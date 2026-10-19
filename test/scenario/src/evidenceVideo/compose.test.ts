/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { renderChapters, resolveVideoTool } from '../renderEvidenceChapters';
import { composeEvidenceVideo } from './compose';
import { EvidenceManifest } from './manifest';
import { wavSeconds } from './narration';
import { createRasterizer, Rasterizer } from './overlays';

const ffmpeg = resolveVideoTool('ffmpeg');
const ffprobe = resolveVideoTool('ffprobe');
const start = Date.parse('2026-10-17T10:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

function createRun(): { runRoot: string; manifest: EvidenceManifest } {
	const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-video-test-'));
	fs.mkdirSync(path.join(runRoot, 'videos'));
	fs.mkdirSync(path.join(runRoot, 'annotations'));
	execFileSync(ffmpeg!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '8',
		'-c:v', 'libvpx', '-b:v', '800k', '-deadline', 'realtime', '-cpu-used', '8', path.join(runRoot, 'videos', 'recording-1.webm')]);
	execFileSync(ffmpeg!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=480x160', '-frames:v', '1', path.join(runRoot, 'annotations', '01-changed.png')]);
	execFileSync(ffmpeg!, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=400x300', '-frames:v', '1', path.join(runRoot, 'annotations', '02-finding.png')]);
	const viewport = { vw: 1280, vh: 720 };
	const manifest: EvidenceManifest = {
		title: 'How to verify the model picker fixes',
		outcome: 'passed',
		videoStartedAt: at(0),
		completedAt: at(8),
		environment: { platform: 'linux', vscodeVersion: '1.143.0', quality: 'Insiders' },
		presentation: { subtitle: 'Insiders from Oct 14 or newer', setup: 'Editor window, signed in. Chat: harness picker `Local` -> `Copilot`.', userSettings: { 'chat.copilot.ensemble.enabled': true }, notCovered: ['Windows with WSL: recorded on Linux.'] },
		artifacts: { videos: ['videos/recording-1.webm'] },
		steps: [
			{ id: 'hover', ref: 'internal #10061', title: 'Model picker: hover `Fusion`, click its details. Hover each tier.', lookFor: 'No hover on any tier, even past the hover delay.', captures: [{ status: 'started', timestamp: at(1.5) }, { status: 'passed', timestamp: at(4.5), details: 'Observed no hover on Standard, High or Max.' }] },
			{ id: 'search', ref: '#315712', title: 'Quick Chat: open the model dropdown and pick `GPT-6 Luna`.', lookFor: 'Opens below its button with the whole list.', captures: [{ status: 'started', timestamp: at(5) }, { status: 'passed', timestamp: at(7.5) }] }
		],
		annotations: [
			{ kind: 'changed', stepId: 'hover', timestamp: at(3), title: 'Ensemble is now called Fusion', body: 'Renamed after this bug. The settings keep `ensemble`.', caption: 'The bug: hovering Balance, now Standard.', image: 'annotations/01-changed.png', highlight: { x: 700, y: 400, width: 200, height: 80 }, viewport: { width: 1280, height: 720 } },
			{ kind: 'finding', stepId: 'search', timestamp: at(6), title: 'With Standard picked, no text describes it', body: 'Standard\'s own description is left only in its screen reader label.', caption: 'A probe run, same build.', image: 'annotations/02-finding.png' }
		],
		interactions: [
			{ t: start + 1800, type: 'move', x: 300, y: 300, ...viewport },
			{ t: start + 2500, type: 'down', x: 760, y: 430, rect: { x: 700, y: 400, width: 200, height: 80 }, ...viewport },
			{ t: start + 5600, type: 'key', code: 'KeyL', ctrl: true, alt: true, shift: true, ...viewport },
			{ t: start + 6400, type: 'key', key: 'Escape', code: 'Escape', ...viewport }
		]
	};
	fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, undefined, 2));
	fs.writeFileSync(path.join(runRoot, 'report.html'), '<video controls src="videos/recording-1.webm"></video>');
	return { runRoot, manifest };
}

function probe(file: string): { width: number; height: number; duration: number; audio: boolean } {
	const result = JSON.parse(execFileSync(ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' })) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
	const video = result.streams.find(stream => stream.codec_type === 'video')!;
	return { width: video.width!, height: video.height!, duration: Number(result.format.duration), audio: result.streams.some(stream => stream.codec_type === 'audio') };
}

async function tryRasterizer(): Promise<Rasterizer | string> {
	try {
		return await createRasterizer();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

test('composes the storyboard video with narration', async t => {
	if (!ffmpeg || !ffprobe) {
		t.skip('ffmpeg and ffprobe are required');
		return;
	}
	const rasterizer = await tryRasterizer();
	if (typeof rasterizer === 'string') {
		t.skip(`no headless browser: ${rasterizer}`);
		return;
	}
	const { runRoot, manifest } = createRun();
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-video-work-'));
	try {
		const outputPath = path.join(runRoot, 'videos', 'annotated.mp4');
		const result = await composeEvidenceVideo({
			runRoot, manifest, videoPath: path.join(runRoot, 'videos', 'recording-1.webm'), outputPath, ffmpeg, ffprobe, workDir, rasterizer,
			narrate: async (lines, directory) => {
				const clips = new Map<string, { file: string; seconds: number }>();
				for (const line of lines.filter(candidate => candidate.text)) {
					const file = path.join(directory, `tone-${line.id}.wav`);
					execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-ar', '24000', '-ac', '1', file]);
					clips.set(line.id, { file, seconds: wavSeconds(fs.readFileSync(file)) });
				}
				return { provider: 'system', status: 'ok', characters: 0, clips };
			}
		});
		const media = probe(outputPath);
		assert.strictEqual(media.width, 1280);
		assert.strictEqual(media.height, result.height);
		assert.ok(result.height > 720 && result.height % 2 === 0, `band adds an even height: ${result.height}`);
		assert.ok(media.audio, 'narrated video carries an audio track');
		assert.ok(Math.abs(media.duration - result.duration) < 0.3, `duration ${media.duration} matches ${result.duration}`);
		// Verdict (6s) + footage (8s, held for narration) + freeze (4s) + report + finding.
		assert.ok(result.duration > 8 + 6 + 4, `cards and holds extend the recording: ${result.duration}`);
		assert.deepStrictEqual(result.chapters.map(chapter => chapter.title.split(':')[0]), ['Verdict', 'SET UP', 'internal #10061 · 1 OF 2', 'Changed from the test', '#315712 · 2 OF 2', 'To report', 'Worth a look']);
		assert.strictEqual(result.narration.status, 'ok');
		if (process.env.EVIDENCE_VIDEO_KEEP) {
			fs.cpSync(runRoot, process.env.EVIDENCE_VIDEO_KEEP, { recursive: true });
		}
	} finally {
		await rasterizer.close();
		fs.rmSync(workDir, { recursive: true, force: true });
		fs.rmSync(runRoot, { recursive: true, force: true });
	}
});

test('falls back to the caption band on request and records why', async t => {
	if (!ffmpeg || !ffprobe) {
		t.skip('ffmpeg and ffprobe are required');
		return;
	}
	const { runRoot } = createRun();
	const previous = process.env.EVIDENCE_VIDEO_STYLE;
	process.env.EVIDENCE_VIDEO_STYLE = 'caption-band';
	try {
		await renderChapters(runRoot);
		const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8')) as EvidenceManifest & { rendering: { style: string } };
		assert.strictEqual(manifest.rendering.style, 'caption-band');
		assert.strictEqual(manifest.artifacts?.videos?.[0], 'videos/annotated.mp4');
		assert.strictEqual(probe(path.join(runRoot, 'videos', 'annotated.mp4')).width, 1280);
		assert.ok(fs.readFileSync(path.join(runRoot, 'report.html'), 'utf8').includes('src="videos/annotated.mp4"'));
	} finally {
		if (previous === undefined) {
			delete process.env.EVIDENCE_VIDEO_STYLE;
		} else {
			process.env.EVIDENCE_VIDEO_STYLE = previous;
		}
		fs.rmSync(runRoot, { recursive: true, force: true });
	}
});
