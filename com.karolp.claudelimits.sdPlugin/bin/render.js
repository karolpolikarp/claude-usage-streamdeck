'use strict';

// Keys are 72x72 physical pixels seen from across a desk, so legibility beats
// decoration: the value gets the whole middle of the key at the largest size
// that fits, and the severity colour rides a bar underneath instead of a ring.

const SIZE = 144;
const CENTER_X = SIZE / 2;
const CONTENT_WIDTH = 132;

const LABEL_Y = 27;
const RULE_Y = 34;
const VALUE_Y = 96;
const BAR_Y = 108;
const BAR_H = 12;
const BAR_W = 104;
const FOOTER_Y = 136;

const COLORS = {
	track: '#31313c',
	muted: '#8a8a96',
	text: '#ffffff',
	ok: '#3ddc84',
	warn: '#ffc14d',
	high: '#ff8a3d',
	crit: '#ff4d4f',
	stale: '#5a5a66',
	error: '#ff4d4f'
};

const LABEL_COLORS = {
	session: '#8ab4ff',
	week: '#c08cff',
	fable: '#ff9f6e',
	credits: '#5fd4c4',
	cost: '#f2c14e'
};

function severityColor(percent) {
	if (percent >= 90) return COLORS.crit;
	if (percent >= 75) return COLORS.high;
	if (percent >= 50) return COLORS.warn;
	return COLORS.ok;
}

function escapeXml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// Per-glyph advances in em, close enough to Segoe UI to size text without
// measuring. A flat per-character factor is not good enough here: "$118.32"
// and "SESSION" have the same length but very different widths.
const NARROW = new Set(['.', ',', ':', ' ', '·', "'"]);

function glyphWidth(ch) {
	if (NARROW.has(ch)) return 0.28;
	if (ch >= '0' && ch <= '9') return 0.56;
	if (ch === '%') return 0.85;
	if (ch === '/') return 0.4;
	if (ch >= 'A' && ch <= 'Z') return 0.62;
	return 0.52;
}

function textWidth(text, size) {
	let em = 0;
	for (const ch of String(text)) em += glyphWidth(ch);
	return em * size;
}

/** Largest size in [min, preferred] whose rendered width fits `maxWidth`. */
function fitSize(text, preferred, min, maxWidth = CONTENT_WIDTH) {
	const em = textWidth(text, 1) || 1;
	return Math.max(min, Math.min(preferred, Math.floor(maxWidth / em)));
}

/** "3h 12m" / "45m" / "2d 4h" / "" when there is no reset timestamp. */
function formatReset(resetsAt) {
	if (!resetsAt) return '';
	const target = new Date(resetsAt).getTime();
	if (!isFinite(target)) return '';
	const diff = target - Date.now();
	if (diff <= 0) return 'now';

	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days >= 1) return `${days}d ${hours % 24}h`;
	if (hours >= 1) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

function wrap(inner, accent) {
	const rule = accent
		? `<rect x="${CENTER_X - 22}" y="${RULE_Y}" width="44" height="3" rx="1.5" fill="${accent}" opacity="0.5"/>`
		: '';
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
		`<stop offset="0" stop-color="#1e1e26"/><stop offset="1" stop-color="#101015"/>` +
		`</linearGradient></defs>` +
		`<rect width="${SIZE}" height="${SIZE}" rx="20" fill="url(#bg)"/>` +
		`<g font-family="Segoe UI, SF Pro Text, Helvetica Neue, sans-serif" text-anchor="middle">${rule}${inner}</g>` +
		`</svg>`
	);
}

function toDataUri(svg) {
	return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function labelNode(text, color) {
	const size = fitSize(text, 21, 14);
	return `<text x="${CENTER_X}" y="${LABEL_Y}" font-size="${size}" font-weight="700" letter-spacing="0.6" fill="${color}">${escapeXml(text)}</text>`;
}

function footerNode(text) {
	if (!text) return '';
	const size = fitSize(text, 20, 13);
	return `<text x="${CENTER_X}" y="${FOOTER_Y}" font-size="${size}" font-weight="600" fill="${COLORS.muted}">${escapeXml(text)}</text>`;
}

function barNode(percent, color) {
	const clamped = Math.max(0, Math.min(100, percent));
	const x = CENTER_X - BAR_W / 2;
	const filled = (BAR_W * clamped) / 100;
	const track = `<rect x="${x}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${COLORS.track}"/>`;
	if (filled < 1) return track;
	// A sliver narrower than the corner radius renders as a lopsided blob.
	const width = Math.max(filled, BAR_H);
	return track + `<rect x="${x}" y="${BAR_Y}" width="${width.toFixed(1)}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>`;
}

function staleDot() {
	return `<circle cx="126" cy="18" r="6" fill="${COLORS.warn}"/>`;
}

/**
 * @param {object} opts
 * @param {string} opts.label    short caption, e.g. "SESSION"
 * @param {string} opts.kind     session | week | fable | credits — caption colour
 * @param {number|null} opts.percent
 * @param {string|null} [opts.resetsAt] ISO timestamp, used when no footer is given
 * @param {string} [opts.footer] replaces the reset countdown
 * @param {boolean} [opts.dimLabel]
 * @param {boolean} [opts.stale] data older than the freshness window
 * @param {string|null} [opts.error] short error caption instead of a value
 */
function renderKey(opts) {
	const labelColor = opts.error
		? COLORS.error
		: opts.dimLabel
			? COLORS.muted
			: LABEL_COLORS[opts.kind] || COLORS.muted;
	const parts = [labelNode(opts.label, labelColor)];

	if (opts.error) {
		parts.push(
			`<text x="${CENTER_X}" y="${VALUE_Y}" font-size="52" font-weight="700" fill="${COLORS.error}">!</text>`,
			footerNode(opts.error)
		);
		return toDataUri(wrap(parts.join(''), labelColor));
	}

	if (opts.percent === null || opts.percent === undefined) {
		parts.push(
			`<text x="${CENTER_X}" y="${VALUE_Y}" font-size="52" font-weight="700" fill="${COLORS.muted}">--</text>`,
			barNode(0, COLORS.track),
			footerNode('no data')
		);
		return toDataUri(wrap(parts.join(''), labelColor));
	}

	const rounded = Math.round(opts.percent);
	const color = opts.stale ? COLORS.stale : severityColor(rounded);
	const valueSize = fitSize(`${rounded}%`, 62, 34);
	parts.push(
		`<text x="${CENTER_X}" y="${VALUE_Y}" font-size="${valueSize}" font-weight="700" fill="${opts.stale ? COLORS.muted : COLORS.text}">${rounded}<tspan font-size="${Math.round(valueSize * 0.5)}" fill="${COLORS.muted}" dx="2">%</tspan></text>`,
		barNode(rounded, color),
		footerNode(opts.footer !== undefined ? opts.footer : formatReset(opts.resetsAt))
	);
	if (opts.stale) parts.push(staleDot());

	return toDataUri(wrap(parts.join(''), labelColor));
}

/**
 * Bar-less variant for values that have no natural percentage — a running
 * total rather than a share of a limit.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} opts.kind
 * @param {string|null} opts.value  headline text, e.g. "$12.34"
 * @param {string} [opts.footer]
 * @param {string|null} [opts.error]
 * @param {boolean} [opts.stale]
 */
function renderStat(opts) {
	const labelColor = opts.error ? COLORS.error : LABEL_COLORS[opts.kind] || COLORS.muted;
	const parts = [labelNode(opts.label, labelColor)];

	if (opts.error) {
		parts.push(
			`<text x="${CENTER_X}" y="${VALUE_Y}" font-size="52" font-weight="700" fill="${COLORS.error}">!</text>`,
			footerNode(opts.error)
		);
		return toDataUri(wrap(parts.join(''), labelColor));
	}

	const value = opts.value === null || opts.value === undefined ? '--' : String(opts.value);
	const size = fitSize(value, 56, 26);
	// A leading currency symbol reads better a size down and in the muted tone.
	const split = /^([^\d.]+)(.+)$/.exec(value);
	const body = split
		? `<tspan font-size="${Math.round(size * 0.6)}" fill="${COLORS.muted}">${escapeXml(split[1])}</tspan>${escapeXml(split[2])}`
		: escapeXml(value);

	parts.push(
		`<text x="${CENTER_X}" y="${VALUE_Y + 4}" font-size="${size}" font-weight="700" fill="${opts.stale ? COLORS.muted : COLORS.text}">${body}</text>`,
		footerNode(opts.footer)
	);
	if (opts.stale) parts.push(staleDot());

	return toDataUri(wrap(parts.join(''), labelColor));
}

module.exports = { renderKey, renderStat, formatReset };
