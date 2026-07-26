'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./log');
const { costOf, normalizeModel, knownModel } = require('./pricing');

const PROJECTS_DIR =
	process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

/**
 * Transcript entries repeat the same assistant message several times with the
 * same requestId as the response grows, so entries are keyed and overwritten
 * rather than summed. Files are read incrementally from the last byte offset.
 */
const state = {
	day: null,
	/** path -> {offset, mtimeMs} */
	files: new Map(),
	/** dedupe key -> {model, usage, sessionId} */
	entries: new Map()
};

function localDayKey(date = new Date()) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function startOfLocalDay() {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function reset(day) {
	state.day = day;
	state.files.clear();
	state.entries.clear();
}

function listCandidateFiles(sinceMs) {
	const out = [];
	const walk = (dir) => {
		let items;
		try {
			items = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (const item of items) {
			const full = path.join(dir, item.name);
			if (item.isDirectory()) {
				walk(full);
			} else if (item.isFile() && item.name.endsWith('.jsonl')) {
				let stat;
				try {
					stat = fs.statSync(full);
				} catch (err) {
					continue;
				}
				if (stat.mtimeMs >= sinceMs) out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
			}
		}
	};
	walk(PROJECTS_DIR);
	return out;
}

function readNewLines(file) {
	const known = state.files.get(file.path);
	let offset = known ? known.offset : 0;
	// A rewritten/truncated file invalidates the offset.
	if (offset > file.size) offset = 0;
	if (offset === file.size) return { lines: [], offset };

	const fd = fs.openSync(file.path, 'r');
	try {
		const length = file.size - offset;
		const buf = Buffer.alloc(length);
		fs.readSync(fd, buf, 0, length, offset);
		const text = buf.toString('utf8');
		const lastNewline = text.lastIndexOf('\n');
		if (lastNewline === -1) return { lines: [], offset }; // partial line only
		const complete = text.slice(0, lastNewline);
		return { lines: complete.split('\n'), offset: offset + Buffer.byteLength(complete, 'utf8') + 1 };
	} finally {
		fs.closeSync(fd);
	}
}

function usageTokens(usage) {
	const creation = usage.cache_creation || {};
	const has1h = typeof creation.ephemeral_1h_input_tokens === 'number';
	const has5m = typeof creation.ephemeral_5m_input_tokens === 'number';
	return {
		input: usage.input_tokens || 0,
		output: usage.output_tokens || 0,
		cacheRead: usage.cache_read_input_tokens || 0,
		cacheWrite5m: has5m
			? creation.ephemeral_5m_input_tokens
			: has1h
				? 0
				: usage.cache_creation_input_tokens || 0,
		cacheWrite1h: has1h ? creation.ephemeral_1h_input_tokens : 0
	};
}

function ingest(line, dayStartMs) {
	if (!line || line[0] !== '{') return;
	let entry;
	try {
		entry = JSON.parse(line);
	} catch (err) {
		return;
	}
	if (entry.type !== 'assistant') return;
	const message = entry.message;
	if (!message || !message.usage) return;

	const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
	if (!isFinite(ts) || ts < dayStartMs) return;

	const key = `${entry.requestId || ''}|${message.id || entry.uuid || ''}`;
	state.entries.set(key, {
		model: message.model,
		tokens: usageTokens(message.usage),
		sessionId: entry.sessionId || entry.session_id || null
	});
}

function emptyTokens() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function addTokens(target, tokens) {
	target.input += tokens.input;
	target.output += tokens.output;
	target.cacheRead += tokens.cacheRead;
	target.cacheWrite5m += tokens.cacheWrite5m;
	target.cacheWrite1h += tokens.cacheWrite1h;
}

/**
 * Scans today's transcripts and returns the notional API cost of the usage.
 * On a Max subscription nothing is actually billed — this is what the same
 * traffic would have cost at list price.
 */
function collectToday() {
	const day = localDayKey();
	if (state.day !== day) {
		log.info(`cost: new day ${day}, resetting scan state`);
		reset(day);
	}

	const dayStartMs = startOfLocalDay();
	const files = listCandidateFiles(dayStartMs);
	let bytesRead = 0;

	for (const file of files) {
		const known = state.files.get(file.path);
		if (known && known.mtimeMs === file.mtimeMs && known.offset === file.size) continue;
		const { lines, offset } = readNewLines(file);
		bytesRead += lines.reduce((n, l) => n + l.length, 0);
		for (const line of lines) ingest(line, dayStartMs);
		state.files.set(file.path, { offset, mtimeMs: file.mtimeMs });
	}

	const byModel = new Map();
	const sessions = new Set();
	const total = emptyTokens();
	let usd = 0;
	let unpricedRequests = 0;

	for (const entry of state.entries.values()) {
		const model = normalizeModel(entry.model) || 'unknown';
		if (!byModel.has(model)) byModel.set(model, emptyTokens());
		addTokens(byModel.get(model), entry.tokens);
		addTokens(total, entry.tokens);
		usd += costOf(entry.model, entry.tokens);
		if (!knownModel(entry.model)) unpricedRequests++;
		if (entry.sessionId) sessions.add(entry.sessionId);
	}

	return {
		usd,
		tokens: total,
		totalTokens:
			total.input + total.output + total.cacheRead + total.cacheWrite5m + total.cacheWrite1h,
		requests: state.entries.size,
		unpricedRequests,
		sessions: sessions.size,
		byModel: Object.fromEntries([...byModel].map(([m, t]) => [m, t])),
		filesScanned: files.length,
		bytesRead
	};
}

module.exports = { collectToday, PROJECTS_DIR };
