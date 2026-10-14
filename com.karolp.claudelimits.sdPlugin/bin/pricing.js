'use strict';

// USD per million tokens. Cache multipliers are relative to the input rate:
// 5-minute write 1.25x, 1-hour write 2x, read 0.1x.
const RATES = {
	'claude-fable-5': { input: 10, output: 50 },
	'claude-mythos-5': { input: 10, output: 50 },
	'claude-opus-5': { input: 5, output: 25 },
	'claude-opus-4-8': { input: 5, output: 25 },
	'claude-opus-4-7': { input: 5, output: 25 },
	'claude-opus-4-6': { input: 5, output: 25 },
	'claude-opus-4-5': { input: 5, output: 25 },
	'claude-sonnet-5': { input: 3, output: 15 },
	'claude-sonnet-4-6': { input: 3, output: 15 },
	'claude-sonnet-4-5': { input: 3, output: 15 },
	'claude-haiku-4-5': { input: 1, output: 5 }
};

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;
const MILLION = 1e6;

const unknownModels = new Set();

/** Strips context-window suffixes such as `claude-opus-5[1m]` or a date snapshot. */
function normalizeModel(model) {
	if (!model) return null;
	let id = String(model).replace(/\[[^\]]*\]$/, '');
	if (RATES[id]) return id;
	// Dated snapshots: claude-haiku-4-5-20251001 -> claude-haiku-4-5
	const dated = id.replace(/-\d{8}$/, '');
	if (RATES[dated]) return dated;
	return id;
}

/**
 * @param {string} model
 * @param {{input:number,output:number,cacheWrite5m:number,cacheWrite1h:number,cacheRead:number}} tokens
 * @returns {number} cost in USD
 */
function costOf(model, tokens) {
	const id = normalizeModel(model);
	const rate = RATES[id];
	if (!rate) {
		if (id && !isSynthetic(model)) unknownModels.add(id);
		return 0;
	}
	const usd =
		tokens.input * rate.input +
		tokens.cacheWrite5m * rate.input * CACHE_WRITE_5M +
		tokens.cacheWrite1h * rate.input * CACHE_WRITE_1H +
		tokens.cacheRead * rate.input * CACHE_READ +
		tokens.output * rate.output;
	return usd / MILLION;
}

function knownModel(model) {
	return Boolean(RATES[normalizeModel(model)]);
}

/**
 * Transcripts also carry pseudo-entries such as `<synthetic>` for turns that
 * never reached the API — a local error, an interrupted request. Zero is the
 * right cost for those, so they must not be reported as unpriced traffic.
 */
function isSynthetic(model) {
	if (!model) return true;
	return !/^claude-/.test(normalizeModel(model));
}

module.exports = { costOf, normalizeModel, knownModel, isSynthetic, unknownModels, RATES };
