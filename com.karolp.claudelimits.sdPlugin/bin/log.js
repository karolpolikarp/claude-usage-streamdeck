'use strict';

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'plugin.log');
const MAX_BYTES = 512 * 1024;

function write(level, message) {
	const line = `${new Date().toISOString()} ${level} ${message}\n`;
	try {
		const stat = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH) : null;
		if (stat && stat.size > MAX_BYTES) fs.writeFileSync(LOG_PATH, '');
		fs.appendFileSync(LOG_PATH, line);
	} catch (_) {
		/* logging must never take the plugin down */
	}
	process.stdout.write(line);
}

module.exports = {
	info: (m) => write('INFO', m),
	warn: (m) => write('WARN', m),
	error: (m) => write('ERROR', m),
	LOG_PATH
};
