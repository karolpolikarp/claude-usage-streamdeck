'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// Overridable so the write-back path can be exercised against a throwaway copy.
const CREDENTIALS_PATH =
	process.env.CLAUDE_CREDENTIALS_PATH || path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const log = require('./log');

function readCredentials() {
	const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
	const parsed = JSON.parse(raw);
	const oauth = parsed.claudeAiOauth;
	if (!oauth || !oauth.accessToken) {
		throw new Error('no claudeAiOauth.accessToken in ' + CREDENTIALS_PATH);
	}
	return { parsed, oauth };
}

/**
 * Writes refreshed tokens back so Claude Code and this plugin stay on the same
 * credentials. Anthropic may rotate the refresh token, so dropping the response
 * on the floor would leave a dead refresh token on disk.
 */
function writeCredentials(parsed) {
	const backup = CREDENTIALS_PATH + '.sdbak';
	try {
		fs.copyFileSync(CREDENTIALS_PATH, backup);
	} catch (err) {
		log.warn('credentials backup failed: ' + err.message);
	}
	const tmp = CREDENTIALS_PATH + '.sdtmp';
	fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, CREDENTIALS_PATH);
}

function request(options, body) {
	return new Promise((resolve, reject) => {
		const req = https.request(options, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () =>
				resolve({ status: res.statusCode, body: data, headers: res.headers })
			);
		});
		req.on('error', reject);
		req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
		if (body) req.write(body);
		req.end();
	});
}

async function refreshTokens() {
	const { parsed, oauth } = readCredentials();
	if (!oauth.refreshToken) throw new Error('no refreshToken stored');

	const url = new URL(TOKEN_URL);
	const payload = JSON.stringify({
		grant_type: 'refresh_token',
		refresh_token: oauth.refreshToken,
		client_id: CLIENT_ID
	});
	const res = await request(
		{
			host: url.host,
			path: url.pathname,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(payload),
				'User-Agent': 'streamdeck-claude-limits/1.0'
			}
		},
		payload
	);
	if (res.status !== 200) {
		throw new Error('token refresh failed: HTTP ' + res.status);
	}
	const json = JSON.parse(res.body);
	if (!json.access_token) throw new Error('token refresh returned no access_token');

	oauth.accessToken = json.access_token;
	if (json.refresh_token) oauth.refreshToken = json.refresh_token;
	if (json.expires_in) oauth.expiresAt = Date.now() + json.expires_in * 1000;
	parsed.claudeAiOauth = oauth;
	writeCredentials(parsed);
	log.info('oauth token refreshed, expires ' + new Date(oauth.expiresAt).toISOString());
	return oauth.accessToken;
}

async function fetchUsage(token) {
	return request({
		host: USAGE_HOST,
		path: USAGE_PATH,
		method: 'GET',
		headers: {
			Authorization: 'Bearer ' + token,
			'Content-Type': 'application/json',
			'anthropic-beta': 'oauth-2025-04-20',
			'User-Agent': 'streamdeck-claude-limits/1.0'
		}
	});
}

let inFlight = null;

/** Returns the raw /api/oauth/usage payload, refreshing the token when needed. */
function getUsage() {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		const { oauth } = readCredentials();
		let token = oauth.accessToken;

		if (!oauth.expiresAt || oauth.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
			log.info('access token expired or near expiry, refreshing');
			token = await refreshTokens();
		}

		let res = await fetchUsage(token);
		if (res.status === 401) {
			log.info('usage returned 401, refreshing token and retrying');
			token = await refreshTokens();
			res = await fetchUsage(token);
		}
		if (res.status !== 200) {
			const err = new Error('usage HTTP ' + res.status);
			if (res.status === 429) {
				// `retry-after` is in seconds; fall back to a minute when absent.
				const header = res.headers && res.headers['retry-after'];
				const seconds = Number(header);
				err.retryAfterMs = isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000;
			}
			throw err;
		}
		return JSON.parse(res.body);
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

/**
 * Flattens the payload into the three windows the keys care about.
 * `five_hour`/`seven_day` carry utilization as 0-100; the Fable window only
 * exists inside `limits[]` as a model-scoped weekly entry.
 */
function extractMetrics(data) {
	const limits = Array.isArray(data.limits) ? data.limits : [];
	const fable = limits.find(
		(l) =>
			l &&
			l.group === 'weekly' &&
			l.scope &&
			l.scope.model &&
			/fable/i.test(l.scope.model.display_name || '')
	);

	return {
		session: fromWindow(data.five_hour),
		week: fromWindow(data.seven_day),
		fable: fable
			? { percent: numberOrNull(fable.percent), resetsAt: fable.resets_at || null }
			: null,
		credits: fromSpend(data.spend, data.extra_usage)
	};
}

/**
 * Usage-credit spend. `spend` carries money in minor units with an exponent;
 * `extra_usage` is the older shape and is used as a fallback.
 */
function fromSpend(spend, extraUsage) {
	if (spend && spend.used && spend.limit) {
		const exponent = typeof spend.used.exponent === 'number' ? spend.used.exponent : 2;
		const scale = Math.pow(10, exponent);
		return {
			percent: numberOrNull(spend.percent),
			used: numberOrNull(spend.used.amount_minor) !== null ? spend.used.amount_minor / scale : null,
			limit:
				numberOrNull(spend.limit.amount_minor) !== null ? spend.limit.amount_minor / scale : null,
			currency: spend.used.currency || null,
			enabled: spend.enabled !== false
		};
	}
	if (extraUsage) {
		const scale = Math.pow(10, extraUsage.decimal_places || 0);
		return {
			percent: numberOrNull(extraUsage.utilization),
			used: numberOrNull(extraUsage.used_credits) !== null ? extraUsage.used_credits / scale : null,
			limit:
				numberOrNull(extraUsage.monthly_limit) !== null ? extraUsage.monthly_limit / scale : null,
			currency: extraUsage.currency || null,
			enabled: extraUsage.is_enabled !== false
		};
	}
	return null;
}

function fromWindow(win) {
	if (!win) return null;
	return { percent: numberOrNull(win.utilization), resetsAt: win.resets_at || null };
}

function numberOrNull(value) {
	return typeof value === 'number' && isFinite(value) ? value : null;
}

module.exports = {
	getUsage,
	extractMetrics,
	CREDENTIALS_PATH,
	// exported for tools/test-writeback.js
	_readCredentials: readCredentials,
	_writeCredentials: writeCredentials
};
