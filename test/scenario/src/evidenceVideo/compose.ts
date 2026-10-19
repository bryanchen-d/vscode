/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Composes the storyboard into the evidence video in two passes:
//
// 1. Footage: on the source timeline, composite the pointer, add the band area
//    above the recording, the zoomed inset that follows the pointer, the step
//    bands and the keystroke chips.
// 2. Pieces: cut that footage into the storyboard's pieces, hold the last frame
//    where narration runs longer, freeze on CHANGED notes, render the cards, and
//    concatenate everything with its narration.
//
// Filters run with `cwd` set to the work directory and reference relative file
// names, so no path escaping can corrupt a filter description.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EvidenceManifest } from './manifest';
import { NarrationResult, synthesizeNarration } from './narration';
import { bandHtml, baseLayout, calloutHtml, chipHtml, createRasterizer, cursorHtml, findingHtml, finishLayout, imageDataUri, Layout, outlineHtml, Rasterizer, reportHtml, verdictHtml } from './overlays';
import { buildStoryboard, Callout, formatTimestamp, Piece, pointerTrack, Storyboard } from './storyboard';

export interface ComposeOptions {
	runRoot: string;
	manifest: EvidenceManifest;
	videoPath: string;
	outputPath: string;
	ffmpeg: string;
	ffprobe: string;
	workDir: string;
	/** Overrides synthesis, for tests. */
	narrate?: (lines: { id: string; text: string }[], workDir: string) => Promise<NarrationResult>;
	/** Overrides the browser, for tests. */
	rasterizer?: Rasterizer;
}

export interface ComposeResult {
	duration: number;
	chapters: { at: number; title: string }[];
	narration: Omit<NarrationResult, 'clips'>;
	width: number;
	height: number;
}

const FPS = 30;
const NARRATION_LEAD = 0.25;
const NARRATION_TAIL = 0.6;

export async function composeEvidenceVideo(options: ComposeOptions): Promise<ComposeResult> {
	const { ffmpeg, workDir } = options;
	const footage = probeVideo(options.ffprobe, options.videoPath);
	const storyboard = buildStoryboard(options.manifest, footage);
	const rasterizer = options.rasterizer ?? await createRasterizer();
	try {
		const layout = await measureLayout(storyboard, footage, rasterizer);
		const canvasHeight = footage.height + layout.bandHeight;

		const narration = await (options.narrate ?? synthesizeNarration)(
			storyboard.pieces.map((piece, index) => ({ id: String(index), text: piece.narration ?? '' })),
			workDir
		);
		if (narration.status === 'failed') {
			console.warn(`Narration was requested but failed: ${narration.reason}. The video is rendered without it.`);
		}
		const durations = storyboard.pieces.map((piece, index) => {
			const clip = narration.clips.get(String(index));
			const voice = clip ? clip.seconds + NARRATION_LEAD + NARRATION_TAIL : 0;
			return roundFrame(Math.max(piece.kind === 'footage' ? piece.to - piece.from : piece.seconds, voice, 1 / FPS));
		});
		const starts = durations.reduce<number[]>((all, _duration, index) => [...all, index ? all[index - 1] + durations[index - 1] : 0], []);

		const images = await renderImages(storyboard, layout, canvasHeight, starts, options.runRoot, workDir, rasterizer);
		const footagePath = composeFootage(storyboard, layout, footage, images, ffmpeg, workDir, options.videoPath);

		const withAudio = narration.status === 'ok';
		const pieceFiles = storyboard.pieces.map((piece, index) => {
			const file = `piece-${String(index).padStart(3, '0')}.mp4`;
			encodePiece(storyboard, piece, durations[index], file, footagePath, images, layout, footage, withAudio ? narration.clips.get(String(index))?.file : undefined, withAudio, ffmpeg, workDir);
			return file;
		});
		fs.writeFileSync(path.join(workDir, 'pieces.txt'), pieceFiles.map(file => `file '${file}'`).join('\n') + '\n');
		fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
		run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'pieces.txt', '-c', 'copy', '-movflags', '+faststart', path.resolve(options.outputPath)], workDir);

		const { clips: _clips, ...narrationSummary } = narration;
		return {
			duration: starts.at(-1)! + durations.at(-1)!,
			chapters: chaptersOf(storyboard, starts),
			narration: narrationSummary,
			width: layout.width,
			height: canvasHeight
		};
	} finally {
		if (!options.rasterizer) {
			await rasterizer.close();
		}
	}
}

async function measureLayout(storyboard: Storyboard, footage: { width: number; height: number }, rasterizer: Rasterizer): Promise<Layout> {
	const base = baseLayout(footage.width, footage.height, storyboard.pointer.length > 0);
	let measured = 0;
	for (const band of storyboard.bands) {
		measured = Math.max(measured, await rasterizer.measure(bandHtml(band.content, base), footage.width));
	}
	return finishLayout(base, measured);
}

interface Image {
	file: string;
	width: number;
	height: number;
}

interface Images {
	bands: Image[];
	chips: Map<string, Image>;
	cursor?: Image & { hotspot: number };
	callouts: { card: Image; outline?: Image }[];
	verdict: Image;
	report?: Image;
	findings: Image[];
}

async function renderImages(storyboard: Storyboard, layout: Layout, canvasHeight: number, starts: number[], runRoot: string, workDir: string, rasterizer: Rasterizer): Promise<Images> {
	const { width, scale } = layout;
	const canvas = { width, height: canvasHeight };
	const render = async (html: string, name: string, viewport = canvas): Promise<Image> => {
		const file = path.join(workDir, name);
		const size = await rasterizer.render(html, file, viewport);
		return { file: name, ...size };
	};

	const bands: Image[] = [];
	for (const [index, band] of storyboard.bands.entries()) {
		bands.push(await render(bandHtml(band.content, layout), `band-${index}.png`, { width, height: layout.bandHeight }));
	}
	const chips = new Map<string, Image>();
	for (const chip of storyboard.chips) {
		if (!chips.has(chip.label)) {
			chips.set(chip.label, await render(chipHtml(chip.label, scale), `chip-${chips.size}.png`));
		}
	}
	let cursor: Images['cursor'];
	if (storyboard.pointer.length) {
		const { html, hotspot } = cursorHtml(scale);
		cursor = { ...await render(html, 'cursor.png'), hotspot };
	}
	const callouts: Images['callouts'] = [];
	for (const [index, callout] of storyboard.callouts.entries()) {
		const card = await render(calloutHtml(callout, Math.round(width * 0.375), scale, imageDataUri(runRoot, callout.image)), `callout-${index}.png`);
		const outline = callout.highlight
			? await render(outlineHtml(callout.highlight.width, callout.highlight.height, scale), `outline-${index}.png`)
			: undefined;
		callouts.push({ card, outline });
	}
	const verdict = await render(verdictHtml(storyboard.verdict, storyboard.header, width, canvasHeight, scale), 'verdict.png');
	const report = storyboard.report.length
		? await render(reportHtml(storyboard.report.map(entry => ({
			time: formatTimestamp(starts[entry.piece] + entry.offset),
			label: entry.label,
			tone: entry.tone,
			text: entry.text
		})), storyboard.header, width, canvasHeight, scale), 'report.png')
		: undefined;
	const findings: Image[] = [];
	for (const [index, finding] of storyboard.findings.entries()) {
		findings.push(await render(findingHtml(finding, storyboard.header, width, canvasHeight, scale, imageDataUri(runRoot, finding.image)), `finding-${index}.png`));
	}
	return { bands, chips, cursor, callouts, verdict, report, findings };
}

function composeFootage(storyboard: Storyboard, layout: Layout, footage: { width: number; height: number; duration: number }, images: Images, ffmpeg: string, workDir: string, videoPath: string): string {
	const { width, bandHeight, inset } = layout;
	const inputs: string[] = ['-i', path.resolve(videoPath)];
	const graph: string[] = [];
	const addInput = (file: string) => {
		inputs.push('-i', file);
		return inputs.filter(argument => argument === '-i').length - 1;
	};
	const window = (from: number, to: number, last: boolean) => `enable='gte(t,${from.toFixed(3)})*${last ? 'lte' : 'lt'}(t,${to.toFixed(3)})'`;

	let label = 'src';
	const pointerCommands = images.cursor ? writePointerCommands(storyboard, layout, footage, images.cursor.hotspot, workDir) : undefined;
	graph.push(`[0:v]fps=${FPS}${pointerCommands ? `,sendcmd=f=${pointerCommands}` : ''}[${label}]`);
	if (images.cursor) {
		const cursorInput = addInput(images.cursor.file);
		graph.push(`[${label}][${cursorInput}:v]overlay@cursor=x=-200:y=-200:eval=frame[cur]`);
		label = 'cur';
	}
	if (inset && images.cursor) {
		graph.push(`[${label}]split=2[main][zoomsrc]`);
		const x0 = Math.round((footage.width - inset.crop.width) / 2);
		const y0 = Math.round((footage.height - inset.crop.height) / 2);
		graph.push(`[zoomsrc]crop@zoom=w=${inset.crop.width}:h=${inset.crop.height}:x=${x0}:y=${y0},scale=${inset.video.width}:${inset.video.height}:flags=lanczos[inset]`);
		graph.push(`[main]pad=${width}:${footage.height + bandHeight}:0:${bandHeight}:color=0x0d1117[padded]`);
		graph.push(`[padded][inset]overlay=x=${inset.video.x}:y=${inset.video.y}[framed]`);
		label = 'framed';
	} else {
		graph.push(`[${label}]pad=${width}:${footage.height + bandHeight}:0:${bandHeight}:color=0x0d1117[framed]`);
		label = 'framed';
	}
	storyboard.bands.forEach((band, index) => {
		const input = addInput(images.bands[index].file);
		const next = `band${index}`;
		graph.push(`[${label}][${input}:v]overlay=x=0:y=0:${window(band.from, band.to, index === storyboard.bands.length - 1)}[${next}]`);
		label = next;
	});
	storyboard.chips.forEach((chip, index) => {
		const image = images.chips.get(chip.label)!;
		const input = addInput(image.file);
		const x = Math.round((width - image.width) / 2);
		const y = bandHeight + footage.height - image.height - Math.round(footage.height * 0.1);
		const next = `chip${index}`;
		graph.push(`[${label}][${input}:v]overlay=x=${x}:y=${y}:${window(chip.at, chip.until, false)}[${next}]`);
		label = next;
	});
	graph.push(`[${label}]format=yuv420p[out]`);
	fs.writeFileSync(path.join(workDir, 'footage.filter'), graph.join(';\n'));
	run(ffmpeg, [
		'-y', '-hide_banner', '-loglevel', 'error',
		...inputs,
		'-filter_complex_script', 'footage.filter',
		'-map', '[out]', '-an',
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', String(FPS), '-pix_fmt', 'yuv420p',
		'footage.mp4'
	], workDir);
	return 'footage.mp4';
}

function writePointerCommands(storyboard: Storyboard, layout: Layout, footage: { width: number; height: number }, hotspot: number, workDir: string): string {
	const inset = layout.inset;
	const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
	const lines = pointerTrack(storyboard.pointer).map(sample => {
		const commands = [`overlay@cursor x ${sample.x - hotspot}`, `overlay@cursor y ${sample.y - hotspot}`];
		if (inset) {
			commands.push(
				`crop@zoom x ${Math.round(clamp(sample.x - inset.crop.width / 2, 0, footage.width - inset.crop.width))}`,
				`crop@zoom y ${Math.round(clamp(sample.y - inset.crop.height / 2, 0, footage.height - inset.crop.height))}`
			);
		}
		return `${sample.t.toFixed(3)} ${commands.join(', ')};`;
	});
	fs.writeFileSync(path.join(workDir, 'pointer.cmd'), lines.join('\n') + '\n');
	return 'pointer.cmd';
}

function encodePiece(storyboard: Storyboard, piece: Piece, seconds: number, file: string, footagePath: string, images: Images, layout: Layout, footage: { width: number; height: number; duration: number }, clip: string | undefined, withAudio: boolean, ffmpeg: string, workDir: string): void {
	const inputs: string[] = [];
	const graph: string[] = [];
	let count = 0;
	const add = (...args: string[]) => {
		inputs.push(...args);
		return count++;
	};
	const duration = seconds.toFixed(3);
	switch (piece.kind) {
		case 'footage': {
			const length = Math.max(piece.to - piece.from, 1 / FPS);
			const video = add('-ss', piece.from.toFixed(3), '-t', length.toFixed(3), '-i', footagePath);
			const hold = Math.max(0, seconds - length);
			graph.push(`[${video}:v]setpts=PTS-STARTPTS${hold > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : ''}[v]`);
			break;
		}
		case 'freeze': {
			const at = Math.min(Math.max(piece.at, 0), Math.max(0, footage.duration - 0.1));
			const video = add('-ss', at.toFixed(3), '-i', footagePath);
			const callout = images.callouts[piece.callout];
			const spec = layoutCallout(storyboard.callouts[piece.callout], layout, footage, callout.card);
			graph.push(`[${video}:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${duration}[frozen]`);
			let label = 'frozen';
			if (callout.outline && spec.outline) {
				const outline = add('-i', callout.outline.file);
				graph.push(`[${label}][${outline}:v]overlay=x=${spec.outline.x}:y=${spec.outline.y}[outlined]`);
				label = 'outlined';
			}
			const card = add('-i', callout.card.file);
			graph.push(`[${label}][${card}:v]overlay=x=${spec.card.x}:y=${spec.card.y}[v]`);
			break;
		}
		case 'verdict':
		case 'report':
		case 'finding': {
			const image = piece.kind === 'verdict' ? images.verdict : piece.kind === 'report' ? images.report! : images.findings[piece.finding];
			const still = add('-loop', '1', '-framerate', String(FPS), '-t', duration, '-i', image.file);
			graph.push(`[${still}:v]null[v]`);
			break;
		}
	}
	const last = graph.length - 1;
	graph[last] = graph[last].replace(/\[v\]$/u, `,fps=${FPS},format=yuv420p,setsar=1[v]`);
	const audioArgs: string[] = [];
	if (withAudio) {
		if (clip) {
			const audio = add('-i', path.relative(workDir, clip));
			graph.push(`[${audio}:a]aresample=48000,adelay=${Math.round(NARRATION_LEAD * 1000)},apad,atrim=duration=${duration}[a]`);
		} else {
			const silence = add('-f', 'lavfi', '-t', duration, '-i', 'anullsrc=r=48000:cl=mono');
			graph.push(`[${silence}:a]anull[a]`);
		}
		audioArgs.push('-map', '[a]', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-ar', '48000');
	} else {
		audioArgs.push('-an');
	}
	run(ffmpeg, [
		'-y', '-hide_banner', '-loglevel', 'error',
		...inputs,
		'-filter_complex', graph.join(';'),
		'-map', '[v]', ...audioArgs,
		'-t', duration,
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', String(FPS * 1000),
		file
	], workDir);
}

function layoutCallout(callout: Callout, layout: Layout, footage: { width: number; height: number }, card: Image): { card: { x: number; y: number }; outline?: { x: number; y: number } } {
	const { margin, bandHeight, width } = layout;
	// The card sits on the side away from the outlined control, in the lower part
	// of the window, and never leaves the footage area.
	const x = callout.side === 'left' ? margin : width - margin - card.width;
	const preferred = bandHeight + Math.round(footage.height * 0.4);
	const y = Math.max(bandHeight + margin, Math.min(preferred, bandHeight + footage.height - margin - card.height));
	const outline = callout.highlight ? { x: callout.highlight.x, y: bandHeight + callout.highlight.y } : undefined;
	return { card: { x, y }, outline };
}

function chaptersOf(storyboard: Storyboard, starts: number[]): { at: number; title: string }[] {
	const chapters: { at: number; title: string }[] = [];
	let lastStep = '';
	storyboard.pieces.forEach((piece, index) => {
		const at = Math.round(starts[index] * 10) / 10;
		switch (piece.kind) {
			case 'verdict': chapters.push({ at, title: `Verdict: ${storyboard.verdict.label}` }); break;
			case 'footage': {
				const band = storyboard.bands.find(candidate => piece.from >= candidate.from && piece.from < candidate.to);
				const title = band ? `${band.content.eyebrow}: ${band.content.instruction ?? ''}`.trim() : 'Recording';
				if (title !== lastStep) {
					chapters.push({ at, title });
					lastStep = title;
				}
				break;
			}
			case 'freeze': chapters.push({ at, title: `Changed from the test: ${storyboard.callouts[piece.callout].title}` }); break;
			case 'report': chapters.push({ at, title: 'To report' }); break;
			case 'finding': chapters.push({ at, title: `Worth a look: ${storyboard.findings[piece.finding].title}` }); break;
		}
	});
	return chapters;
}

export function probeVideo(ffprobe: string, videoPath: string): { width: number; height: number; duration: number } {
	const probe = JSON.parse(execFileSync(ffprobe, [
		'-v', 'error', '-select_streams', 'v:0',
		'-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
		'-of', 'json', videoPath
	], { encoding: 'utf8' })) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
	const width = Number(probe.streams?.[0]?.width);
	const height = Number(probe.streams?.[0]?.height);
	const duration = Number(probe.format?.duration);
	if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(duration) || duration <= 0) {
		throw new Error('the recorded video could not be probed');
	}
	return { width, height, duration };
}

function roundFrame(seconds: number): number {
	return Math.round(seconds * FPS) / FPS;
}

function run(tool: string, args: string[], cwd: string): void {
	try {
		execFileSync(tool, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
		throw new Error(`${path.basename(tool)} failed${stderr ? `: ${stderr.split('\n').slice(-4).join(' ')}` : ''}`);
	}
}
