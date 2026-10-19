/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { synthesizeNarration, wavSeconds } from './narration';

function wav(seconds: number): Buffer {
	const sampleRate = 24000;
	const data = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8, 'ascii');
	header.write('fmt ', 12, 'ascii');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'ascii');
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

async function withSpeechServer(status: number, run: (endpoint: string, requests: { headers: http.IncomingHttpHeaders; body: string }[]) => Promise<void>): Promise<void> {
	const requests: { headers: http.IncomingHttpHeaders; body: string }[] = [];
	const server = http.createServer((request, response) => {
		let body = '';
		request.on('data', chunk => body += chunk);
		request.on('end', () => {
			requests.push({ headers: request.headers, body });
			response.writeHead(status, { 'Content-Type': 'audio/wav' });
			response.end(status === 200 ? wav(0.5) : undefined);
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/cognitiveservices/v1`, requests);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
}

test('synthesizes each line with Azure Speech and measures the clip', async () => {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-narration-'));
	try {
		await withSpeechServer(200, async (endpoint, requests) => {
			const result = await synthesizeNarration([{ id: '0', text: 'Verified. All <2> checks passed.' }, { id: '1', text: '' }], workDir, {
				AZURE_SPEECH_ENDPOINT: endpoint,
				AZURE_SPEECH_KEY: 'test-key'
			});
			assert.strictEqual(result.status, 'ok');
			assert.strictEqual(result.provider, 'azure');
			assert.strictEqual(result.voice, 'en-US-Andrew:DragonHDLatestNeural');
			assert.deepStrictEqual([...result.clips.keys()], ['0']);
			assert.strictEqual(result.clips.get('0')!.seconds, 0.5);
			assert.strictEqual(requests.length, 1);
			assert.strictEqual(requests[0].headers['ocp-apim-subscription-key'], 'test-key');
			assert.ok(requests[0].body.includes('<voice name="en-US-Andrew:DragonHDLatestNeural">Verified. All &lt;2&gt; checks passed.</voice>'));
		});
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
});

test('reports a failed requested provider instead of replacing it', async () => {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-narration-'));
	try {
		await withSpeechServer(401, async endpoint => {
			const result = await synthesizeNarration([{ id: '0', text: 'Verified.' }], workDir, {
				EVIDENCE_NARRATION: 'azure',
				AZURE_SPEECH_ENDPOINT: endpoint,
				AZURE_SPEECH_TOKEN: 'token'
			});
			assert.strictEqual(result.status, 'failed');
			assert.match(result.reason ?? '', /401/);
			assert.strictEqual(result.clips.size, 0);
		});
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
});

test('stays silent unless narration is configured', async () => {
	const unset = await synthesizeNarration([{ id: '0', text: 'Verified.' }], os.tmpdir(), {});
	assert.deepStrictEqual([unset.provider, unset.status, unset.reason], ['none', 'disabled', 'no narration provider is configured']);
	const invalid = await synthesizeNarration([{ id: '0', text: 'Verified.' }], os.tmpdir(), { EVIDENCE_NARRATION: 'loud' });
	assert.strictEqual(invalid.status, 'failed');
});

test('reads WAV duration from its data chunk', () => {
	assert.strictEqual(wavSeconds(wav(1.25)), 1.25);
	assert.throws(() => wavSeconds(Buffer.from('not audio')), /not a WAV/);
});
