'use strict';

const WebSocket = require('ws');
const log = require('./log');
const { getUsage, extractMetrics } = require('./usage');
const { collectToday } = require('./cost');
const { renderKey, renderStat } = require('./render');

const POLL_INTERVAL_MS = 60 * 1000;
const REDRAW_INTERVAL_MS = 30 * 1000; // keeps the countdown moving between polls
const STALE_AFTER_MS = 5 * 60 * 1000;

// `source` decides which poller feeds the key: the usage API or the local
// transcript scan.
const ACTIONS = {
	'com.karolp.claudelimits.session': { kind: 'session', label: 'SESSION', source: 'usage' },
	'com.karolp.claudelimits.week': { kind: 'week', label: 'WEEK', source: 'usage' },
	'com.karolp.claudelimits.fable': { kind: 'fable', label: 'FABLE', source: 'usage' },
	'com.karolp.claudelimits.credits': { kind: 'credits', label: 'CREDITS', source: 'usage' },
	'com.karolp.claudelimits.cost': { kind: 'cost', label: 'COST TODAY', source: 'cost' }
};

const CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£', PLN: 'zł' };

/** context -> action UUID */
const visible = new Map();

let ws = null;
let lastMetrics = null;
let lastFetchAt = 0;
let lastError = null;
let lastCost = null;
let lastCostError = null;
let pollTimer = null;
let redrawTimer = null;

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = String(argv[i]).replace(/^-+/, '');
		out[key] = argv[i + 1];
	}
	return out;
}

function send(payload) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(payload));
	}
}

function setImage(context, image) {
	send({ event: 'setImage', context, payload: { image, target: 0 } });
}

function shortError(err) {
	const message = String(err && err.message ? err.message : err);
	if (/ENOENT|no claudeAiOauth/i.test(message)) return 'no login';
	if (/HTTP 429/.test(message)) return 'slow down';
	if (/refresh/i.test(message)) return 'auth';
	if (/HTTP 4\d\d/i.test(message)) return 'auth';
	if (/HTTP 5\d\d/i.test(message)) return 'server';
	if (/timeout|ENOTFOUND|ECONN/i.test(message)) return 'offline';
	return 'error';
}

function money(amount, currency) {
	const symbol = CURRENCY_SYMBOLS[currency] || currency || '';
	const value = amount >= 100 ? Math.round(amount) : amount.toFixed(2);
	return symbol ? `${value} ${symbol}` : String(value);
}

function compactTokens(count) {
	if (count >= 1e9) return (count / 1e9).toFixed(1) + 'B';
	if (count >= 1e6) return (count / 1e6).toFixed(1) + 'M';
	if (count >= 1e3) return Math.round(count / 1e3) + 'k';
	return String(count);
}

function creditsFooter(metric) {
	if (!metric || metric.used === null || metric.limit === null) return '';
	const symbol = CURRENCY_SYMBOLS[metric.currency] || metric.currency || '';
	return `${metric.used.toFixed(2)}/${Math.round(metric.limit)}${symbol ? ' ' + symbol : ''}`;
}

/**
 * A model-scoped weekly window has no `resets_at` until it is first used, so
 * the reset line would otherwise be blank on an untouched window.
 */
function footerFor(kind, metric) {
	if (kind === 'credits') return creditsFooter(metric);
	if (metric && !metric.resetsAt && metric.percent === 0) return 'unused';
	return undefined;
}

function drawUsageKey(context, action, stale) {
	if (!lastMetrics && lastError) {
		setImage(
			context,
			renderKey({ label: action.label, kind: action.kind, error: shortError(lastError) })
		);
		return;
	}

	const metric = lastMetrics ? lastMetrics[action.kind] : null;
	setImage(
		context,
		renderKey({
			label: action.label,
			kind: action.kind,
			percent: metric ? metric.percent : null,
			resetsAt: metric ? metric.resetsAt : null,
			footer: footerFor(action.kind, metric),
			// Credits that are switched off still have a balance worth showing,
			// but the greyed caption makes the state obvious.
			dimLabel: action.kind === 'credits' && metric && metric.enabled === false,
			stale
		})
	);
}

function drawCostKey(context, action) {
	if (!lastCost && lastCostError) {
		setImage(
			context,
			renderStat({ label: action.label, kind: action.kind, error: shortError(lastCostError) })
		);
		return;
	}
	if (!lastCost) {
		setImage(context, renderStat({ label: action.label, kind: action.kind, value: null }));
		return;
	}

	// Cents stop being interesting past $100, and dropping them buys a much
	// larger face on the key.
	const usd = lastCost.usd;
	const value =
		usd >= 1000 ? '$' + (usd / 1000).toFixed(1) + 'k' : usd >= 100 ? '$' + Math.round(usd) : '$' + usd.toFixed(2);
	setImage(
		context,
		renderStat({
			label: action.label,
			kind: action.kind,
			value,
			// Kept to one short phrase — anything longer has to shrink to stay
			// inside the key and stops being readable on the device.
			footer: `${compactTokens(lastCost.totalTokens)} tok`
		})
	);
}

function drawAll() {
	const stale = lastMetrics !== null && Date.now() - lastFetchAt > STALE_AFTER_MS;

	for (const [context, actionId] of visible) {
		const action = ACTIONS[actionId];
		if (!action) continue;
		if (action.source === 'cost') drawCostKey(context, action);
		else drawUsageKey(context, action, stale);
	}
}

function needsSource(source) {
	for (const actionId of visible.values()) {
		const action = ACTIONS[actionId];
		if (action && action.source === source) return true;
	}
	return false;
}

let pendingPoll = null;
let retryTimer = null;
let backoffUntil = 0;

/**
 * A 429 right after a restart would otherwise leave the keys blank until the
 * next minute tick, so honour `retry-after` with a single extra attempt. The
 * regular timer is suppressed for the same window — firing both put two
 * requests milliseconds apart while already rate limited.
 */
function scheduleRetry(err) {
	if (!err || !err.retryAfterMs) return;
	const delay = Math.min(Math.max(err.retryAfterMs, 5000), 5 * 60 * 1000);
	backoffUntil = Date.now() + delay;
	if (retryTimer) return;
	log.info(`rate limited, retrying usage in ${Math.round(delay / 1000)}s`);
	retryTimer = setTimeout(() => {
		retryTimer = null;
		poll('retry');
	}, delay);
	if (retryTimer.unref) retryTimer.unref();
}

/** Three keys appearing at once must not turn into three polls. */
function poll(reason) {
	// Scheduled polls stand down during a rate-limit backoff; an explicit
	// keypress and the scheduled retry itself still go through.
	if ((reason === 'timer' || reason === 'appear') && Date.now() < backoffUntil) {
		return Promise.resolve();
	}
	if (pendingPoll) return pendingPoll;
	pendingPoll = runPoll(reason).finally(() => {
		pendingPoll = null;
	});
	return pendingPoll;
}

async function runPoll(reason) {
	if (needsSource('usage')) {
		try {
			const data = await getUsage();
			lastMetrics = extractMetrics(data);
			lastFetchAt = Date.now();
			lastError = null;
			backoffUntil = 0;
			log.info(
				`poll(${reason}) usage ok session=${fmt(lastMetrics.session)} week=${fmt(lastMetrics.week)} fable=${fmt(lastMetrics.fable)} credits=${fmt(lastMetrics.credits)}`
			);
		} catch (err) {
			lastError = err;
			log.error(`poll(${reason}) usage failed: ${err.message}`);
			scheduleRetry(err);
		}
	}

	if (needsSource('cost')) {
		try {
			lastCost = collectToday();
			lastCostError = null;
			log.info(
				`poll(${reason}) cost ok $${lastCost.usd.toFixed(2)} req=${lastCost.requests} files=${lastCost.filesScanned}`
			);
		} catch (err) {
			lastCostError = err;
			log.error(`poll(${reason}) cost failed: ${err.message}`);
		}
	}

	drawAll();
}

function fmt(metric) {
	return metric && metric.percent !== null ? Math.round(metric.percent) + '%' : '-';
}

/**
 * Timers run for as long as the socket is open. Stream Deck sends
 * willDisappear for every key on the page while the user edits a profile or
 * opens a property inspector, so tying the timers to the visible-key count
 * left the plugin permanently asleep once editing was done. Polling with no
 * keys visible costs nothing — `needsSource` skips the work.
 */
function startTimers() {
	if (!pollTimer) pollTimer = setInterval(() => poll('timer'), POLL_INTERVAL_MS);
	if (!redrawTimer) redrawTimer = setInterval(drawAll, REDRAW_INTERVAL_MS);
}

function stopTimers() {
	if (pollTimer) clearInterval(pollTimer), (pollTimer = null);
	if (redrawTimer) clearInterval(redrawTimer), (redrawTimer = null);
}

/** True when the key that just appeared has nothing to draw yet. */
function sourceIsEmpty(source) {
	return source === 'cost' ? lastCost === null : lastMetrics === null;
}

function connect() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.port || !args.pluginUUID || !args.registerEvent) {
		log.error('missing Stream Deck registration arguments, exiting');
		process.exit(1);
	}

	ws = new WebSocket('ws://127.0.0.1:' + args.port);

	ws.on('open', () => {
		send({ event: args.registerEvent, uuid: args.pluginUUID });
		log.info('registered with Stream Deck on port ' + args.port);
		startTimers();
	});

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch (err) {
			return;
		}

		switch (msg.event) {
			case 'willAppear': {
				visible.set(msg.context, msg.action);
				startTimers();
				drawAll();
				const action = ACTIONS[msg.action];
				const source = action ? action.source : 'usage';
				log.info(`willAppear ${msg.action} (${visible.size} visible)`);
				if (sourceIsEmpty(source) || Date.now() - lastFetchAt > POLL_INTERVAL_MS) {
					poll('appear');
				}
				break;
			}

			case 'willDisappear':
				visible.delete(msg.context);
				log.info(`willDisappear ${msg.action} (${visible.size} visible)`);
				break;

			case 'keyUp':
				poll('keypress').then(() => {
					const failed = lastError || lastCostError;
					send({ event: failed ? 'showAlert' : 'showOk', context: msg.context });
				});
				break;

			case 'systemDidWakeUp':
				poll('wake');
				break;

			case 'applicationDidLaunch':
			case 'deviceDidConnect':
				drawAll();
				break;
		}
	});

	ws.on('close', () => {
		log.warn('Stream Deck socket closed, exiting');
		stopTimers();
		process.exit(0);
	});

	ws.on('error', (err) => log.error('socket error: ' + err.message));
}

process.on('uncaughtException', (err) => log.error('uncaught: ' + (err && err.stack)));
process.on('unhandledRejection', (err) => log.error('unhandled: ' + err));

connect();
