/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Narration for the evidence video.
//
// The script is generated from the manifest (see `storyboard.ts`), so the voice
// never says anything the evidence does not show. Synthesis is opt-in:
//
//   EVIDENCE_NARRATION=azure   Azure Speech (HD voices). Needs AZURE_SPEECH_REGION
//                              or AZURE_SPEECH_ENDPOINT, and AZURE_SPEECH_KEY or
//                              AZURE_SPEECH_TOKEN (sent as a bearer token).
//   EVIDENCE_NARRATION=system  The operating system's offline voice.
//   EVIDENCE_NARRATION=none    No narration.
//   (unset)                    Azure when its credentials are present, else none.
//
// EVIDENCE_NARRATION_VOICE selects the voice. A requested provider that fails
// is reported, never silently replaced by another voice.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface NarrationClip {
	file: string;
	seconds: number;
}

export interface NarrationResult {
	provider: 'azure' | 'system' | 'none';
	voice?: string;
	status: 'ok' | 'disabled' | 'failed';
	reason?: string;
	characters: number;
	clips: Map<string, NarrationClip>;
}

const DEFAULT_AZURE_VOICE = 'en-US-Andrew:DragonHDLatestNeural';

export async function synthesizeNarration(lines: { id: string; text: string }[], workDir: string, env: NodeJS.ProcessEnv = process.env): Promise<NarrationResult> {
	const requested = (env.EVIDENCE_NARRATION ?? '').trim().toLowerCase();
	const hasAzure = !!(env.AZURE_SPEECH_KEY || env.AZURE_SPEECH_TOKEN) && !!(env.AZURE_SPEECH_REGION || env.AZURE_SPEECH_ENDPOINT);
	const provider = requested === 'azure' || requested === 'system' || requested === 'none'
		? requested
		: requested ? 'invalid' : hasAzure ? 'azure' : 'none';
	const spoken = lines.filter(line => line.text.trim());
	const characters = spoken.reduce((total, line) => total + line.text.length, 0);
	const result: NarrationResult = { provider: provider === 'invalid' ? 'none' : provider, status: 'disabled', characters, clips: new Map() };
	if (provider === 'invalid') {
		return { ...result, status: 'failed', reason: `unknown EVIDENCE_NARRATION '${requested}' (use azure, system or none)` };
	}
	if (provider === 'none' || !spoken.length) {
		return { ...result, reason: provider === 'none' && !requested ? 'no narration provider is configured' : undefined };
	}
	const voice = env.EVIDENCE_NARRATION_VOICE?.trim() || (provider === 'azure' ? DEFAULT_AZURE_VOICE : undefined);
	result.voice = voice;
	console.log(`Synthesizing ${characters} characters of narration in ${spoken.length} clips with ${provider}${voice ? ` (${voice})` : ''}.`);
	try {
		for (const [index, line] of spoken.entries()) {
			const file = path.join(workDir, `narration-${index}.wav`);
			if (provider === 'azure') {
				await synthesizeAzure(line.text, voice!, file, env);
			} else {
				synthesizeSystem(line.text, voice, file, workDir);
			}
			result.clips.set(line.id, { file, seconds: wavSeconds(fs.readFileSync(file)) });
		}
		result.status = 'ok';
	} catch (error) {
		result.clips.clear();
		result.status = 'failed';
		result.reason = error instanceof Error ? error.message : String(error);
	}
	return result;
}

async function synthesizeAzure(text: string, voice: string, file: string, env: NodeJS.ProcessEnv): Promise<void> {
	const endpoint = env.AZURE_SPEECH_ENDPOINT?.trim() || `https://${env.AZURE_SPEECH_REGION!.trim()}.tts.speech.microsoft.com/cognitiveservices/v1`;
	const headers: Record<string, string> = {
		'Content-Type': 'application/ssml+xml',
		'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
		'User-Agent': 'vscode-evidence-video'
	};
	if (env.AZURE_SPEECH_KEY) {
		headers['Ocp-Apim-Subscription-Key'] = env.AZURE_SPEECH_KEY;
	} else {
		headers.Authorization = `Bearer ${env.AZURE_SPEECH_TOKEN}`;
	}
	const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
	const fetchImpl = (globalThis as unknown as { fetch: (url: string, init: object) => Promise<{ ok: boolean; status: number; statusText: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }> }).fetch;
	let lastError = '';
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await fetchImpl(endpoint, { method: 'POST', headers, body: ssml });
		if (response.ok) {
			fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
			return;
		}
		lastError = `Azure Speech returned ${response.status} ${response.statusText}`;
		// Throttling and transient service errors are retried; anything else is a
		// configuration problem that another attempt cannot fix.
		if (response.status !== 429 && response.status < 500) {
			break;
		}
		await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
	}
	throw new Error(lastError);
}

function synthesizeSystem(text: string, voice: string | undefined, file: string, workDir: string): void {
	const textFile = path.join(workDir, `${path.basename(file, '.wav')}.txt`);
	fs.writeFileSync(textFile, text);
	if (process.platform === 'win32') {
		// Values travel in the environment: `-Command` re-splits trailing
		// arguments on whitespace, which breaks voice names and paths.
		const script = [
			'Add-Type -AssemblyName System.Speech',
			'$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
			'if ($env:EVIDENCE_TTS_VOICE) { $synth.SelectVoice($env:EVIDENCE_TTS_VOICE) }',
			'$synth.SetOutputToWaveFile($env:EVIDENCE_TTS_OUTPUT)',
			'$synth.Speak([IO.File]::ReadAllText($env:EVIDENCE_TTS_TEXT))',
			'$synth.Dispose()'
		].join('; ');
		execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
			stdio: 'ignore',
			env: { ...process.env, EVIDENCE_TTS_TEXT: textFile, EVIDENCE_TTS_OUTPUT: file, EVIDENCE_TTS_VOICE: voice ?? '' }
		});
	} else if (process.platform === 'darwin') {
		execFileSync('say', [...(voice ? ['-v', voice] : []), '-f', textFile, '-o', file, '--data-format=LEI16@24000'], { stdio: 'ignore' });
	} else {
		execFileSync('espeak-ng', [...(voice ? ['-v', voice] : []), '-f', textFile, '-w', file], { stdio: 'ignore' });
	}
}

/** Duration of a PCM WAV file. */
export function wavSeconds(data: Buffer): number {
	if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('narration audio is not a WAV file');
	}
	let byteRate = 0;
	for (let offset = 12; offset + 8 <= data.length;) {
		const id = data.toString('ascii', offset, offset + 4);
		const size = data.readUInt32LE(offset + 4);
		if (id === 'fmt ') {
			byteRate = data.readUInt32LE(offset + 16);
		} else if (id === 'data') {
			if (!byteRate) {
				break;
			}
			// Streaming writers can leave the size unset; fall back to the file length.
			const bytes = size && size !== 0xffffffff ? Math.min(size, data.length - offset - 8) : data.length - offset - 8;
			return bytes / byteRate;
		}
		offset += 8 + size + (size % 2);
	}
	throw new Error('narration audio has no PCM data');
}

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;');
}
