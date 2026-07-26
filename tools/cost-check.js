'use strict';

// Prints today's usage roll-up and times both the cold scan and an incremental one.

const { collectToday } = require('../com.karolp.claudelimits.sdPlugin/bin/cost');
const { unknownModels } = require('../com.karolp.claudelimits.sdPlugin/bin/pricing');

const t0 = Date.now();
const first = collectToday();
const t1 = Date.now();
const second = collectToday();
const t2 = Date.now();

const fmtTokens = (t) =>
	`in=${t.input} out=${t.output} read=${t.cacheRead} w5m=${t.cacheWrite5m} w1h=${t.cacheWrite1h}`;

console.log(`cold scan   ${t1 - t0} ms, ${first.filesScanned} files, ${(first.bytesRead / 1e6).toFixed(1)} MB`);
console.log(`incremental ${t2 - t1} ms, ${(second.bytesRead / 1e3).toFixed(1)} kB`);
console.log('');
console.log(`cost today  $${first.usd.toFixed(2)}`);
console.log(`requests    ${first.requests} (${first.unpricedRequests} unpriced)`);
console.log(`sessions    ${first.sessions}`);
console.log(`tokens      ${first.totalTokens} (${fmtTokens(first.tokens)})`);
console.log('');
for (const [model, tokens] of Object.entries(first.byModel)) {
	console.log(`  ${model.padEnd(22)} ${fmtTokens(tokens)}`);
}
if (unknownModels.size) console.log('\nunpriced models:', [...unknownModels].join(', '));
