'use strict';

// Fake Stream Deck host: spawns bin/plugin.js exactly like the app does,
// sends willAppear for the three actions and dumps whatever the plugin draws.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PLUGIN_DIR = path.join(__dirname, '..', 'com.karolp.claudelimits.sdPlugin');
const WebSocket = require(path.join(PLUGIN_DIR, 'node_modules', 'ws'));
const OUT_DIR = path.join(__dirname, '..', 'preview');

const ACTIONS = [
	'com.karolp.claudelimits.session',
	'com.karolp.claudelimits.week',
	'com.karolp.claudelimits.fable',
	'com.karolp.claudelimits.credits',
	'com.karolp.claudelimits.cost'
];

const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, () => {
	const port = server.address().port;
	console.log('fake Stream Deck listening on', port);

	const child = spawn(
		process.execPath,
		[
			path.join(PLUGIN_DIR, 'bin', 'plugin.js'),
			'-port', String(port),
			'-pluginUUID', 'SIMULATED-UUID',
			'-registerEvent', 'registerPlugin',
			'-info', JSON.stringify({ application: { platform: 'windows' } })
		],
		{ cwd: PLUGIN_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	child.stdout.on('data', (d) => process.stdout.write('[plugin] ' + d));
	child.stderr.on('data', (d) => process.stderr.write('[plugin:err] ' + d));

	const images = new Map();

	server.on('connection', (socket) => {
		socket.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.event === 'registerPlugin') {
				console.log('plugin registered as', msg.uuid);
				ACTIONS.forEach((action, i) => {
					socket.send(
						JSON.stringify({
							event: 'willAppear',
							action,
							context: 'ctx-' + i,
							device: 'dev-0',
							payload: { coordinates: { column: i, row: 0 }, settings: {}, state: 0 }
						})
					);
				});
				return;
			}
			if (msg.event === 'setImage') {
				images.set(msg.context, msg.payload.image);
				console.log('setImage for', msg.context, msg.payload.image.slice(0, 40) + '...');
			}
		});
	});

	setTimeout(() => {
		fs.mkdirSync(OUT_DIR, { recursive: true });
		let written = 0;
		for (const [context, dataUri] of images) {
			const idx = Number(context.split('-')[1]);
			const name = ACTIONS[idx].split('.').pop();
			const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
			fs.writeFileSync(path.join(OUT_DIR, 'sim-' + name + '.svg'), svg);
			written++;
		}
		console.log(written ? `wrote ${written} simulated key images to ${OUT_DIR}` : 'NO IMAGES RECEIVED');
		child.kill();
		server.close();
		process.exit(written === ACTIONS.length ? 0 : 1);
	}, 12000);
});
