/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Turns an evidence manifest into a storyboard: what the reviewer sees, when,
// and what the narrator says. Pure, so the whole structure of a video can be
// tested without ffmpeg or a browser.
//
// The footage is never edited: every source frame is kept in order. The
// storyboard only adds cards before and after it, a band above it, overlays on
// top of it, and holds (frozen frames) where a note or narration needs time.

import { Box, EvidenceManifest, isFiniteBox, ManifestInteraction, ManifestStep } from './manifest';

export type Tone = 'blue' | 'green' | 'red' | 'amber' | 'gray';

export interface BandContent {
	eyebrow: string;
	eyebrowTone: Tone;
	header: string;
	instruction?: string;
	lookFor?: string;
	settings?: string[];
	result?: { label: string; tone: Tone; details?: string };
}

/** A band shown above the footage between two source times, in seconds. */
export interface Band {
	from: number;
	to: number;
	content: BandContent;
}

export interface Chip {
	at: number;
	until: number;
	label: string;
}

/** Pointer position in video pixels at a source time, in seconds. */
export interface PointerSample {
	t: number;
	x: number;
	y: number;
}

export interface Callout {
	at: number;
	stepIndex: number;
	title: string;
	body?: string;
	image?: string;
	imageCaption?: string;
	/** Outline in video pixels. */
	highlight?: Box;
	side: 'left' | 'right';
}

export interface Finding {
	title: string;
	body?: string;
	image?: string;
	caption?: string;
}

export interface ReportEntry {
	tone: Tone;
	label: string;
	text: string;
	/** Where the entry appears: a piece and a source offset inside it. */
	piece: number;
	offset: number;
}

export type Piece =
	| { kind: 'verdict'; seconds: number; narration: string }
	| { kind: 'footage'; from: number; to: number; narration?: string }
	| { kind: 'freeze'; at: number; callout: number; seconds: number; narration: string }
	| { kind: 'report'; seconds: number; narration: string }
	| { kind: 'finding'; finding: number; seconds: number; narration: string };

export interface Verdict {
	label: string;
	tone: Tone;
	headline: string;
	meta: string;
	notCovered: string[];
}

export interface Storyboard {
	header: string;
	platform: string;
	verdict: Verdict;
	bands: Band[];
	chips: Chip[];
	pointer: PointerSample[];
	callouts: Callout[];
	findings: Finding[];
	report: ReportEntry[];
	pieces: Piece[];
}

export interface FootageGeometry {
	width: number;
	height: number;
	duration: number;
}

const CHIP_SECONDS = 1.2;
const VERDICT_SECONDS = 6;
const FREEZE_SECONDS = 4;
const FINDING_SECONDS = 6;
const MIN_PIECE_SECONDS = 1 / 30;
const MAX_SETTINGS = 4;

export function buildStoryboard(manifest: EvidenceManifest, footage: FootageGeometry): Storyboard {
	const videoStartedAtMs = Date.parse(manifest.videoStartedAt ?? '');
	if (!Number.isFinite(videoStartedAtMs)) {
		throw new Error('the run has no video start time, so the storyboard cannot be aligned');
	}
	const { duration } = footage;
	const offsetOf = (timestamp: string | number | undefined) => {
		const ms = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp ?? '');
		return (ms - videoStartedAtMs) / 1000;
	};
	const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
	const presentation = manifest.presentation ?? {};
	const platform = manifest.environment?.platform ?? process.platform;
	const header = [manifest.title, presentation.subtitle].filter(Boolean).join(' · ');

	// Step windows over the footage, in source seconds.
	const windows: { step: ManifestStep; from: number; close: number; to: number }[] = [];
	let previous = 0;
	(manifest.steps ?? []).forEach(step => {
		const started = step.captures?.find(capture => capture.status === 'started') ?? step.captures?.[0];
		const offset = offsetOf(started?.timestamp);
		if (!Number.isFinite(offset)) {
			return;
		}
		const from = clamp(offset, previous, duration);
		windows.push({ step, from, close: from, to: duration });
		previous = from;
	});
	if (!windows.length) {
		throw new Error('no step boundaries could be derived from the manifest');
	}
	windows.forEach((window, index) => {
		window.to = index + 1 < windows.length ? windows[index + 1].from : duration;
		const closing = window.step.captures?.at(-1);
		const closeOffset = closing && closing.status !== 'started' ? offsetOf(closing.timestamp) : NaN;
		window.close = Number.isFinite(closeOffset) ? clamp(closeOffset, window.from, window.to) : window.to;
	});
	const stepCount = windows.length;
	const refOf = (step: ManifestStep) => step.ref?.trim() || undefined;

	// Bands.
	const bands: Band[] = [];
	const hasSetup = windows[0].from > 0.05;
	const setupText = presentation.setup?.trim() || defaultSetup(manifest);
	if (hasSetup) {
		bands.push({
			from: 0,
			to: windows[0].from,
			content: { eyebrow: 'SET UP', eyebrowTone: 'blue', header, instruction: setupText, settings: settingsChips(presentation.userSettings) }
		});
	}
	windows.forEach((window, index) => {
		const ref = refOf(window.step);
		const base: BandContent = {
			eyebrow: ref ? `${ref} · ${index + 1} OF ${stepCount}` : `STEP ${index + 1} OF ${stepCount}`,
			eyebrowTone: 'blue',
			header,
			instruction: window.step.title?.trim() || window.step.id || '',
			lookFor: window.step.lookFor?.trim() || undefined
		};
		const closing = window.step.captures?.at(-1);
		const result = resultOf(closing?.status, closing?.blockedOn, closing?.details);
		if (!result || window.close >= window.to) {
			bands.push({ from: window.from, to: window.to, content: result && window.close >= window.to ? { ...base, result } : base });
			return;
		}
		if (window.close > window.from) {
			bands.push({ from: window.from, to: window.close, content: base });
		}
		bands.push({ from: window.close, to: window.to, content: { ...base, result } });
	});

	// Keystroke chips.
	const interactions = [...(manifest.interactions ?? [])].filter(event => Number.isFinite(event.t)).sort((a, b) => a.t - b.t);
	const keys = interactions.filter(event => event.type === 'key');
	const chips: Chip[] = [];
	keys.forEach((event, index) => {
		const at = offsetOf(event.t);
		if (!(at >= 0 && at < duration)) {
			return;
		}
		const next = keys[index + 1] ? offsetOf(keys[index + 1].t) : Infinity;
		const until = Math.min(at + CHIP_SECONDS, Math.max(next, at + 0.4), duration);
		chips.push({ at, until, label: keyLabel(event, platform) });
	});

	// Pointer path in video pixels.
	const pointer: PointerSample[] = [];
	for (const event of interactions) {
		if ((event.type !== 'move' && event.type !== 'down') || !Number.isFinite(event.x) || !Number.isFinite(event.y)) {
			continue;
		}
		const scale = viewportScale(footage, event.vw, event.vh, event.dpr);
		if (!scale) {
			continue;
		}
		const t = clamp(offsetOf(event.t), 0, duration);
		const x = Math.round(event.x! * scale);
		const y = Math.round(event.y! * scale);
		const last = pointer.at(-1);
		if (last && last.x === x && last.y === y) {
			continue;
		}
		pointer.push({ t, x, y });
	}

	// Notes.
	const annotations = (manifest.annotations ?? []).filter(note => typeof note.title === 'string' && note.title.trim());
	const latestViewport = (at: number) => {
		let found: ManifestInteraction | undefined;
		for (const event of interactions) {
			if (offsetOf(event.t) > at) {
				break;
			}
			found = event;
		}
		return found ? { width: found.vw, height: found.vh, dpr: found.dpr } : undefined;
	};
	const callouts: Callout[] = [];
	for (const note of annotations.filter(candidate => candidate.kind === 'changed')) {
		const stepIndex = windows.findIndex(window => window.step.id === note.stepId);
		const window = windows[stepIndex];
		const raw = offsetOf(note.timestamp);
		const at = clamp(Number.isFinite(raw) ? raw : (window?.close ?? duration), window?.from ?? 0, window?.to ?? duration);
		let highlight: Box | undefined;
		if (isFiniteBox(note.highlight)) {
			const viewport = note.viewport ?? latestViewport(at);
			const scale = viewport ? viewportScale(footage, viewport.width, viewport.height, viewport.dpr) : undefined;
			if (scale) {
				const pad = 6;
				highlight = {
					x: Math.max(0, Math.round(note.highlight.x * scale) - pad),
					y: Math.max(0, Math.round(note.highlight.y * scale) - pad),
					width: Math.round(note.highlight.width * scale) + pad * 2,
					height: Math.round(note.highlight.height * scale) + pad * 2
				};
			}
		}
		const center = highlight ? highlight.x + highlight.width / 2 : 0;
		callouts.push({
			at,
			stepIndex,
			title: note.title!.trim(),
			body: note.body?.trim() || undefined,
			image: note.image,
			imageCaption: note.caption?.trim() || undefined,
			highlight,
			side: center > footage.width / 2 ? 'left' : 'right'
		});
	}
	callouts.sort((a, b) => a.at - b.at);
	const findings: Finding[] = annotations
		.filter(note => note.kind === 'finding')
		.map(note => ({ title: note.title!.trim(), body: note.body?.trim() || undefined, image: note.image, caption: note.caption?.trim() || undefined }));

	// Timeline.
	const verdict = buildVerdict(manifest, windows.map(window => window.step), callouts);
	const pieces: Piece[] = [{
		kind: 'verdict',
		seconds: VERDICT_SECONDS,
		narration: speakable([`${verdict.label}.`, verdict.headline, verdict.notCovered.length ? `Not covered: ${verdict.notCovered.join('; ')}.` : ''])
	}];
	const report: ReportEntry[] = [];
	const addFootage = (from: number, to: number, narration?: string) => {
		if (to - from >= MIN_PIECE_SECONDS) {
			pieces.push({ kind: 'footage', from, to, narration });
			return true;
		}
		return false;
	};
	if (hasSetup) {
		addFootage(0, windows[0].from, speakable(['Set up.', setupText]));
	}
	windows.forEach((window, index) => {
		const ref = refOf(window.step);
		let cursor = window.from;
		let narration: string | undefined = speakable([
			`Step ${index + 1} of ${stepCount}.`,
			window.step.title ?? '',
			window.step.lookFor ? `Look for: ${window.step.lookFor}` : ''
		]);
		const firstPiece = pieces.length;
		const anchorFor = (time: number) => {
			for (let piece = pieces.length - 1; piece >= firstPiece; piece--) {
				const candidate = pieces[piece];
				if (candidate.kind === 'footage' && time >= candidate.from) {
					return { piece, offset: time - candidate.from };
				}
			}
			return { piece: Math.max(firstPiece, pieces.length - 1), offset: 0 };
		};
		for (const [calloutIndex, callout] of callouts.entries()) {
			if (callout.stepIndex !== index && !(callout.stepIndex === -1 && callout.at >= window.from && callout.at < window.to)) {
				continue;
			}
			if (addFootage(cursor, callout.at, narration)) {
				narration = undefined;
			}
			cursor = callout.at;
			pieces.push({
				kind: 'freeze',
				at: callout.at,
				callout: calloutIndex,
				seconds: FREEZE_SECONDS,
				narration: speakable(['Changed from the test.', callout.title, callout.body ?? ''])
			});
			report.push({ tone: 'amber', label: 'CHANGED', text: `${ref ? `${ref}: ` : ''}${callout.title}`, piece: pieces.length - 1, offset: 0 });
		}
		if (!addFootage(cursor, window.to, narration) && narration && pieces.length === firstPiece) {
			// A step too short to show still needs its piece for narration and the report.
			pieces.push({ kind: 'footage', from: Math.max(0, window.to - MIN_PIECE_SECONDS), to: window.to, narration });
		}
		const closing = window.step.captures?.at(-1);
		if (closing?.status === 'failed' || closing?.status === 'skipped') {
			const anchor = anchorFor(window.close);
			const what = `${ref ? `${ref}: ` : ''}${window.step.title ?? window.step.id ?? ''}`;
			const label = closing.status === 'failed' ? 'FAILED' : closing.blockedOn === 'infrastructure' ? 'NEEDS HARNESS' : closing.blockedOn === 'human' ? 'NEEDS A PERSON' : 'SKIPPED';
			report.push({ tone: closing.status === 'failed' ? 'red' : 'amber', label, text: closing.details ? `${what} (${closing.details})` : what, ...anchor });
		}
	});
	if (report.length) {
		pieces.push({
			kind: 'report',
			seconds: Math.min(9, 3 + report.length * 1.5),
			narration: speakable(['To report.', ...report.map(entry => `${entry.label.toLowerCase()}: ${entry.text}.`)])
		});
	}
	findings.forEach((finding, index) => pieces.push({
		kind: 'finding',
		finding: index,
		seconds: FINDING_SECONDS,
		narration: speakable(['Worth a look.', finding.title, finding.body ?? ''])
	}));

	return { header, platform, verdict, bands, chips, pointer, callouts, findings, report, pieces };
}

function buildVerdict(manifest: EvidenceManifest, steps: ManifestStep[], callouts: Callout[]): Verdict {
	const reproduce = manifest.presentation?.purpose === 'reproduce';
	const total = steps.length;
	const noun = (count: number) => `${count} ${count === 1 ? 'check' : 'checks'}`;
	const lastStatus = (step: ManifestStep) => step.captures?.at(-1)?.status;
	const stopIndex = steps.findIndex(step => lastStatus(step) !== 'passed');
	const stopped = steps[stopIndex];
	const stoppedTitle = stopped ? (stopped.title ?? stopped.id ?? '') : '';
	let label: string;
	let tone: Tone;
	let headline: string;
	switch (manifest.outcome) {
		case 'passed':
			label = reproduce ? 'REPRODUCED' : 'VERIFIED';
			tone = reproduce ? 'amber' : 'green';
			headline = reproduce
				? `Reproduced: all ${noun(total)} behaved as reported, each checked in the app.`
				: `All ${noun(total)} passed, each checked in the app.`;
			break;
		case 'partial':
			label = 'PARTIAL';
			tone = 'amber';
			headline = `All ${noun(total)} that could be automated passed; other planned checks were not run.`;
			break;
		case 'failed':
			label = reproduce ? 'NOT REPRODUCED' : 'NOT VERIFIED';
			tone = 'red';
			headline = stopped
				? `Step ${stopIndex + 1} of ${total} failed: ${trimSentence(stoppedTitle)}.`
				: 'The run failed.';
			break;
		case 'aborted':
			label = 'INCOMPLETE';
			tone = 'amber';
			headline = stopped
				? `Stopped at step ${stopIndex + 1} of ${total}: ${trimSentence(stoppedTitle)}.`
				: 'The run stopped before it finished.';
			break;
		default:
			label = (manifest.outcome ?? 'unknown').toUpperCase();
			tone = 'gray';
			headline = `Outcome: ${manifest.outcome ?? 'unknown'}.`;
	}
	if (callouts.length) {
		headline = `${headline} ${callouts.map(callout => trimSentence(callout.title)).join('; ')}.`;
	}
	const environment = manifest.environment ?? {};
	const date = formatDate(manifest.completedAt ?? manifest.startedAt);
	const meta = [[environment.quality, environment.vscodeVersion].filter(value => value && value !== 'unknown').join(' '), date].filter(Boolean).join(' · ');
	const notCovered = [
		...(manifest.presentation?.notCovered ?? []).map(item => item.trim()).filter(Boolean),
		...steps
			.filter(step => lastStatus(step) === 'skipped')
			.map(step => `${step.title ?? step.id}: ${step.captures?.at(-1)?.details ?? 'skipped'}`)
	];
	return { label, tone, headline, meta, notCovered };
}

function resultOf(status: string | undefined, blockedOn: string | undefined, details: string | undefined): BandContent['result'] {
	switch (status) {
		case 'passed': return { label: 'PASSED', tone: 'green', details: details?.trim() || undefined };
		case 'failed': return { label: 'FAILED', tone: 'red', details: details?.trim() || undefined };
		case 'skipped': return { label: blockedOn ? `SKIPPED · NEEDS ${blockedOn === 'human' ? 'A PERSON' : 'HARNESS'}` : 'SKIPPED', tone: 'amber', details: details?.trim() || undefined };
		default: return undefined;
	}
}

function defaultSetup(manifest: EvidenceManifest): string {
	const environment = manifest.environment ?? {};
	const product = ['VS Code', environment.quality && environment.quality !== 'unknown' ? environment.quality : '', environment.vscodeVersion ?? ''].filter(Boolean).join(' ');
	return `Open ${product} with a clean profile.`;
}

function settingsChips(settings: Record<string, unknown> | undefined): string[] | undefined {
	const entries = Object.entries(settings ?? {});
	if (!entries.length) {
		return undefined;
	}
	const chips = entries.slice(0, MAX_SETTINGS).map(([key, value]) => {
		const text = `"${key}": ${JSON.stringify(value)}`;
		return text.length > 90 ? `${text.slice(0, 87)}...` : text;
	});
	if (entries.length > MAX_SETTINGS) {
		chips.push(`+${entries.length - MAX_SETTINGS} more`);
	}
	return chips;
}

function viewportScale(footage: FootageGeometry, viewportWidth: number, viewportHeight: number, devicePixelRatio: number | undefined): number | undefined {
	if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
		return undefined;
	}
	// The screencast captures device pixels and only scales them down to fit the
	// recording canvas, so a smaller window keeps its size in the top left.
	const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio! > 0 ? devicePixelRatio! : 1;
	return Math.min(dpr, footage.width / viewportWidth, footage.height / viewportHeight);
}

const macKeys: Record<string, string> = {
	Escape: 'esc', Enter: '↩', Tab: '⇥', Backspace: '⌫', Delete: '⌦', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
	PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End', Insert: 'Ins', ' ': 'Space'
};
const otherKeys: Record<string, string> = {
	Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
	PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End', Insert: 'Ins', ' ': 'Space'
};

const codeKeys: Record<string, string> = {
	Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Minus: '-', Equal: '=',
	Semicolon: ';', Quote: '\'', Backquote: '`', Space: 'Space', IntlBackslash: '\\'
};

/** A shortcut as the platform writes it: `⌥⇧⌘L` on macOS, `Ctrl+Shift+L` elsewhere. */
export function keyLabel(event: Pick<ManifestInteraction, 'key' | 'code' | 'ctrl' | 'alt' | 'shift' | 'meta'>, platform: string): string {
	const mac = platform === 'darwin';
	const names = mac ? macKeys : otherKeys;
	let key: string;
	if (event.key && names[event.key]) {
		key = names[event.key];
	} else if (event.code && /^Key[A-Z]$/u.test(event.code)) {
		// The physical key, because Option on macOS turns `L` into `¬`.
		key = event.code.slice(3);
	} else if (event.code && /^(Digit|Numpad)[0-9]$/u.test(event.code)) {
		key = event.code.slice(-1);
	} else if (event.code && codeKeys[event.code]) {
		key = codeKeys[event.code];
	} else if (event.key && event.key.length === 1) {
		key = event.key.toUpperCase();
	} else {
		key = event.key ?? event.code ?? '?';
	}
	if (mac) {
		return `${event.ctrl ? '⌃' : ''}${event.alt ? '⌥' : ''}${event.shift ? '⇧' : ''}${event.meta ? '⌘' : ''}${key}`;
	}
	const meta = platform === 'win32' ? 'Win' : 'Super';
	return [event.ctrl && 'Ctrl', event.alt && 'Alt', event.shift && 'Shift', event.meta && meta, key].filter(Boolean).join('+');
}

/**
 * Interpolate the pointer for display.
 *
 * Automation moves the pointer in jumps, so each move is shown as a short glide
 * that arrives exactly when the real event happened. Samples are emitted at
 * `rate` per second, and once more at each arrival.
 */
export function pointerTrack(samples: readonly PointerSample[], rate = 15, glideSeconds = 0.35): PointerSample[] {
	const track: PointerSample[] = [];
	samples.forEach((sample, index) => {
		const previous = samples[index - 1];
		if (previous) {
			const start = Math.max(previous.t, sample.t - glideSeconds);
			const span = sample.t - start;
			if (span > 0) {
				for (let time = start + 1 / rate; time < sample.t; time += 1 / rate) {
					const progress = easeInOut((time - start) / span);
					track.push({
						t: round3(time),
						x: Math.round(previous.x + (sample.x - previous.x) * progress),
						y: Math.round(previous.y + (sample.y - previous.y) * progress)
					});
				}
			}
		}
		track.push({ t: round3(sample.t), x: sample.x, y: sample.y });
	});
	return track;
}

function easeInOut(value: number): number {
	return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Final-video timestamp, `m:ss`. */
export function formatTimestamp(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function formatDate(value: string | undefined): string {
	const date = new Date(value ?? '');
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function trimSentence(value: string): string {
	return value.trim().replace(/[\s.]+$/u, '');
}

/** Narration text: markup stripped, whitespace collapsed, sentences joined. */
export function speakable(parts: string[]): string {
	return parts
		.map(part => part.replace(/`([^`]*)`/gu, '$1').replace(/[*_#>]/gu, '').replace(/\s+/gu, ' ').trim())
		.filter(Boolean)
		.map(part => /[.!?:]$/u.test(part) ? part : `${part}.`)
		.join(' ');
}
