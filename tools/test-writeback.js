'use strict';

// Exercises the credentials write-back on a throwaway copy of the real file,
// so the token-refresh path cannot be the first thing that ever touches it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL = path.join(os.homedir(), '.claude', '.credentials.json');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claudelimits-'));
const COPY = path.join(TMP_DIR, '.credentials.json');

fs.copyFileSync(REAL, COPY);
process.env.CLAUDE_CREDENTIALS_PATH = COPY;

const usage = require('../com.karolp.claudelimits.sdPlugin/bin/usage');

const before = JSON.parse(fs.readFileSync(COPY, 'utf8'));
const { parsed, oauth } = usage._readCredentials();

oauth.accessToken = 'sk-ant-oat01-TEST';
oauth.refreshToken = 'sk-ant-ort01-TEST';
oauth.expiresAt = 1234567890000;
parsed.claudeAiOauth = oauth;
usage._writeCredentials(parsed);

const after = JSON.parse(fs.readFileSync(COPY, 'utf8'));
const backup = JSON.parse(fs.readFileSync(COPY + '.sdbak', 'utf8'));

const checks = [
	['file still parses as JSON', typeof after === 'object'],
	['accessToken updated', after.claudeAiOauth.accessToken === 'sk-ant-oat01-TEST'],
	['refreshToken updated', after.claudeAiOauth.refreshToken === 'sk-ant-ort01-TEST'],
	['expiresAt updated', after.claudeAiOauth.expiresAt === 1234567890000],
	[
		'untouched fields preserved',
		after.claudeAiOauth.subscriptionType === before.claudeAiOauth.subscriptionType &&
			JSON.stringify(after.claudeAiOauth.scopes) === JSON.stringify(before.claudeAiOauth.scopes)
	],
	['backup holds the previous token', backup.claudeAiOauth.accessToken === before.claudeAiOauth.accessToken],
	['no temp file left behind', !fs.existsSync(COPY + '.sdtmp')]
];

let failed = 0;
for (const [name, ok] of checks) {
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
	if (!ok) failed++;
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
