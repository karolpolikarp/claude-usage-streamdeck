'use strict';

// Renders the README banner from synthetic values, so the published image never
// carries a real account's usage or spend. Writes docs/keys.html plus the five
// SVGs it references; screenshot it with:
//   msedge --headless=new --window-size=760,200 --screenshot=docs/keys.png docs/keys.html

const fs = require('fs');
const path = require('path');
const { renderKey, renderStat } = require('../com.karolp.claudelimits.sdPlugin/bin/render');

const OUT_DIR = path.join(__dirname, '..', 'docs');
const HOURS = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

const KEYS = [
	{ name: 'session', svg: renderKey({ kind: 'session', label: 'SESSION', percent: 43, resetsAt: HOURS(2.6) }) },
	{ name: 'week', svg: renderKey({ kind: 'week', label: 'WEEK', percent: 61, resetsAt: HOURS(96) }) },
	{ name: 'fable', svg: renderKey({ kind: 'fable', label: 'FABLE', percent: 12, resetsAt: HOURS(96) }) },
	{ name: 'credits', svg: renderKey({ kind: 'credits', label: 'CREDITS', percent: 28, footer: '31.40/112 €' }) },
	{ name: 'cost', svg: renderStat({ kind: 'cost', label: 'COST TODAY', value: '$47.20', footer: '61.4M tok' }) }
];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const key of KEYS) {
	const svg = Buffer.from(key.svg.split(',')[1], 'base64').toString('utf8');
	fs.writeFileSync(path.join(OUT_DIR, `key-${key.name}.svg`), svg + '\n');
}

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { background:#0d0d10; margin:0; padding:28px; }
  .row { display:flex; gap:20px; }
  img { width:120px; height:120px; display:block; border-radius:18px; }
</style>
<div class="row">
${KEYS.map((k) => `  <img src="key-${k.name}.svg" alt="${k.name}">`).join('\n')}
</div>
`;
fs.writeFileSync(path.join(OUT_DIR, 'keys.html'), html);
console.log('wrote docs/keys.html and 5 SVGs');
