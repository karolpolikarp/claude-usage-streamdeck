'use strict';

// Renders the three keys with live data (or --demo values) into ./preview/*.svg
// so the layout can be checked without touching Stream Deck.

const fs = require('fs');
const path = require('path');
const { getUsage, extractMetrics } = require('../com.karolp.claudelimits.sdPlugin/bin/usage');
const { renderKey, renderStat } = require('../com.karolp.claudelimits.sdPlugin/bin/render');

const OUT_DIR = process.env.PREVIEW_DIR || path.join(__dirname, '..', 'preview');
const KINDS = [
	{ kind: 'session', label: 'SESSION' },
	{ kind: 'week', label: 'WEEK' },
	{ kind: 'fable', label: 'FABLE' }
];

function writeSvg(name, dataUri) {
	const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
	fs.writeFileSync(path.join(OUT_DIR, name + '.svg'), svg);
}

(async () => {
	fs.mkdirSync(OUT_DIR, { recursive: true });

	if (process.argv.includes('--demo')) {
		const demo = [
			{ kind: 'session', label: 'SESSION', percent: 43, resetsAt: iso(2.4) },
			{ kind: 'week', label: 'WEEK', percent: 5, resetsAt: iso(120) },
			{ kind: 'fable', label: 'FABLE', percent: 0, resetsAt: null },
			{ kind: 'session', label: 'SESSION', percent: 78, resetsAt: iso(0.7) },
			{ kind: 'week', label: 'WEEK', percent: 96, resetsAt: iso(50) },
			{ kind: 'fable', label: 'FABLE', percent: 61, resetsAt: iso(30), stale: true },
			{ kind: 'session', label: 'SESSION', error: 'no login' }
		];
		demo.forEach((d, i) => writeSvg(`demo-${i}-${d.kind}`, renderKey(d)));

		// The cost key has no percentage, so it goes through renderStat and needs
		// its own set: a normal total, a day with nothing scanned yet, and traffic
		// on a model the rate table does not price.
		const costDemo = [
			{ name: 'cost', label: 'COST TODAY', kind: 'cost', value: '$12.34', footer: '289k tok' },
			{ name: 'cost-empty', label: 'COST TODAY', kind: 'cost', value: null, footer: 'no usage yet' },
			{ name: 'cost-unpriced', label: 'COST TODAY', kind: 'cost', value: '$1.04', footer: '3 unpriced' },
			{ name: 'cost-no-dir', label: 'COST TODAY', kind: 'cost', error: 'no data dir' }
		];
		costDemo.forEach((d) => writeSvg(`demo-${d.name}`, renderStat(d)));

		console.log('wrote demo previews to', OUT_DIR);
		return;
	}

	const data = await getUsage();
	const metrics = extractMetrics(data);
	console.log(JSON.stringify(metrics, null, 2));

	for (const { kind, label } of KINDS) {
		const m = metrics[kind];
		writeSvg(
			kind,
			renderKey({
				kind,
				label,
				percent: m ? m.percent : null,
				resetsAt: m ? m.resetsAt : null
			})
		);
	}
	console.log('wrote live previews to', OUT_DIR);
})().catch((err) => {
	console.error('preview failed:', err.message);
	process.exit(1);
});

function iso(hoursFromNow) {
	return new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
}
