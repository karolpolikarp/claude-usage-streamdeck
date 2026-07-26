'use strict';

// Regenerates the static key images in imgs/actions from the same renderer the
// plugin uses, so the placeholder a key shows before its first poll matches the
// live artwork exactly.

const fs = require('fs');
const path = require('path');
const { renderKey, renderStat } = require('../com.karolp.claudelimits.sdPlugin/bin/render');

const OUT_DIR = path.join(__dirname, '..', 'com.karolp.claudelimits.sdPlugin', 'imgs', 'actions');

const KEYS = [
	{ file: 'session-key', render: () => renderKey({ kind: 'session', label: 'SESSION', percent: null }) },
	{ file: 'week-key', render: () => renderKey({ kind: 'week', label: 'WEEK', percent: null }) },
	{ file: 'fable-key', render: () => renderKey({ kind: 'fable', label: 'FABLE', percent: null }) },
	{ file: 'credits-key', render: () => renderKey({ kind: 'credits', label: 'CREDITS', percent: null }) },
	{ file: 'cost-key', render: () => renderStat({ kind: 'cost', label: 'COST TODAY', value: null }) }
];

for (const key of KEYS) {
	const svg = Buffer.from(key.render().split(',')[1], 'base64').toString('utf8');
	fs.writeFileSync(path.join(OUT_DIR, key.file + '.svg'), svg + '\n');
	console.log('wrote', key.file + '.svg');
}
