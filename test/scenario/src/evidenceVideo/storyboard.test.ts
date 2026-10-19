/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { EvidenceManifest } from './manifest';
import { buildStoryboard, formatTimestamp, keyLabel, pointerTrack, speakable } from './storyboard';

const start = Date.parse('2026-10-17T10:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const footage = { width: 1920, height: 1080, duration: 20 };

function manifest(overrides: Partial<EvidenceManifest> = {}): EvidenceManifest {
	return {
		title: 'How to verify 3 model picker fixes',
		outcome: 'passed',
		videoStartedAt: at(0),
		completedAt: at(20),
		environment: { platform: 'darwin', vscodeVersion: '1.143.0', quality: 'Insiders' },
		presentation: { subtitle: 'Insiders from Oct 14 or newer', setup: 'Sign in.', userSettings: { 'chat.copilot.ensemble.enabled': true } },
		steps: [
			{ id: 'hover', title: 'Hover each tier', ref: 'internal #10061', lookFor: 'No hover on any tier.', captures: [{ status: 'started', timestamp: at(4) }, { status: 'passed', timestamp: at(9), details: 'Observed no hover.' }] },
			{ id: 'search', title: 'Hover the search field', ref: '#315712', captures: [{ status: 'started', timestamp: at(10) }, { status: 'passed', timestamp: at(15) }] }
		],
		...overrides
	};
}

test('derives setup, step and result bands over the footage', () => {
	const storyboard = buildStoryboard(manifest(), footage);
	assert.strictEqual(storyboard.header, 'How to verify 3 model picker fixes · Insiders from Oct 14 or newer');
	assert.deepStrictEqual(storyboard.bands.map(band => [band.from, band.to, band.content.eyebrow, band.content.result?.label]), [
		[0, 4, 'SET UP', undefined],
		[4, 9, 'internal #10061 · 1 OF 2', undefined],
		[9, 10, 'internal #10061 · 1 OF 2', 'PASSED'],
		[10, 15, '#315712 · 2 OF 2', undefined],
		[15, 20, '#315712 · 2 OF 2', 'PASSED']
	]);
	assert.deepStrictEqual(storyboard.bands[0].content.settings, ['"chat.copilot.ensemble.enabled": true']);
	assert.strictEqual(storyboard.bands[1].content.lookFor, 'No hover on any tier.');
});

test('opens on a computed verdict and keeps every source second in order', () => {
	const storyboard = buildStoryboard(manifest(), footage);
	assert.strictEqual(storyboard.verdict.label, 'VERIFIED');
	assert.strictEqual(storyboard.verdict.headline, 'All 2 checks passed, each checked in the app.');
	assert.strictEqual(storyboard.verdict.meta, 'Insiders 1.143.0 · Oct 17');
	assert.strictEqual(storyboard.pieces[0].kind, 'verdict');
	const footagePieces = storyboard.pieces.filter(piece => piece.kind === 'footage');
	assert.deepStrictEqual(footagePieces.map(piece => [piece.from, piece.to]), [[0, 4], [4, 10], [10, 20]]);
	assert.strictEqual(storyboard.report.length, 0);
	assert.ok(!storyboard.pieces.some(piece => piece.kind === 'report'));
});

test('pauses on a changed note, outlines it and lists it to report', () => {
	const storyboard = buildStoryboard(manifest({
		annotations: [{ kind: 'changed', stepId: 'hover', timestamp: at(6), title: 'Ensemble is now called Fusion', body: 'Renamed after this bug.', highlight: { x: 1200, y: 600, width: 100, height: 40 }, viewport: { width: 1920, height: 1080 } }],
		interactions: [{ t: start + 5000, type: 'move', x: 100, y: 100, vw: 1920, vh: 1080 }]
	}), footage);
	assert.deepStrictEqual(storyboard.pieces.map(piece => piece.kind), ['verdict', 'footage', 'footage', 'freeze', 'footage', 'footage', 'report']);
	const freeze = storyboard.pieces[3];
	assert.ok(freeze.kind === 'freeze' && freeze.at === 6);
	assert.deepStrictEqual(storyboard.callouts[0].highlight, { x: 1194, y: 594, width: 112, height: 52 });
	assert.strictEqual(storyboard.callouts[0].side, 'left');
	assert.deepStrictEqual(storyboard.report.map(entry => [entry.label, entry.text, entry.piece]), [['CHANGED', 'internal #10061: Ensemble is now called Fusion', 3]]);
	assert.strictEqual(storyboard.verdict.headline, 'All 2 checks passed, each checked in the app. Ensemble is now called Fusion.');
});

test('reports a failed step with its detail and anchors it in the timeline', () => {
	const storyboard = buildStoryboard(manifest({
		outcome: 'failed',
		steps: [{ id: 'hover', title: 'Hover each tier', captures: [{ status: 'started', timestamp: at(2) }, { status: 'failed', timestamp: at(7), details: 'A hover appeared.' }] }]
	}), footage);
	assert.strictEqual(storyboard.verdict.label, 'NOT VERIFIED');
	assert.strictEqual(storyboard.verdict.headline, 'Step 1 of 1 failed: Hover each tier.');
	assert.deepStrictEqual(storyboard.report.map(entry => [entry.label, entry.text, entry.offset]), [['FAILED', 'Hover each tier (A hover appeared.)', 5]]);
	assert.strictEqual(storyboard.bands.at(-1)?.content.result?.details, 'A hover appeared.');
});

test('labels reproductions and lists uncovered cases', () => {
	const storyboard = buildStoryboard(manifest({
		presentation: { purpose: 'reproduce', notCovered: ['Windows with WSL.'] },
		steps: [
			{ id: 'a', title: 'Open the picker', captures: [{ status: 'started', timestamp: at(1) }, { status: 'passed', timestamp: at(3) }] },
			{ id: 'b', title: 'Use a hardware key', captures: [{ status: 'skipped', timestamp: at(4), details: 'Needs a security key.', blockedOn: 'human' }] }
		],
		outcome: 'aborted'
	}), footage);
	assert.strictEqual(storyboard.verdict.label, 'INCOMPLETE');
	assert.deepStrictEqual(storyboard.verdict.notCovered, ['Windows with WSL.', 'Use a hardware key: Needs a security key.']);
	assert.deepStrictEqual(storyboard.report.map(entry => entry.label), ['NEEDS A PERSON']);
	const passed = buildStoryboard(manifest({ presentation: { purpose: 'reproduce' } }), footage);
	assert.strictEqual(passed.verdict.label, 'REPRODUCED');
});

test('maps pointer and keyboard events into the video', () => {
	const storyboard = buildStoryboard(manifest({
		interactions: [
			{ t: start + 5000, type: 'move', x: 480, y: 270, vw: 960, vh: 540, dpr: 2 },
			{ t: start + 5000, type: 'move', x: 480, y: 270, vw: 960, vh: 540, dpr: 2 },
			{ t: start + 6000, type: 'down', x: 100, y: 50, vw: 960, vh: 540, dpr: 2 },
			{ t: start + 7000, type: 'key', code: 'KeyL', alt: true, shift: true, meta: true, vw: 960, vh: 540, dpr: 2 },
			{ t: start + 7300, type: 'key', key: 'Escape', code: 'Escape', vw: 960, vh: 540, dpr: 2 }
		]
	}), footage);
	assert.deepStrictEqual(storyboard.pointer, [{ t: 5, x: 960, y: 540 }, { t: 6, x: 200, y: 100 }]);
	assert.deepStrictEqual(storyboard.chips.map(chip => [chip.label, chip.at, Math.round(chip.until * 10) / 10]), [['⌥⇧⌘L', 7, 7.4], ['esc', 7.3, 8.5]]);
});

test('keeps a window smaller than the recording at its own size', () => {
	// The screencast only scales device pixels down, so a 1280x800 window at
	// DPR 1 sits unscaled in the top left of the 1920x1080 recording, and a
	// larger window is fitted into it.
	const storyboard = buildStoryboard(manifest({
		interactions: [
			{ t: start + 5000, type: 'move', x: 640, y: 400, vw: 1280, vh: 800, dpr: 1 },
			{ t: start + 6000, type: 'move', x: 1000, y: 500, vw: 2560, vh: 1440, dpr: 1 }
		]
	}), footage);
	assert.deepStrictEqual(storyboard.pointer, [{ t: 5, x: 640, y: 400 }, { t: 6, x: 750, y: 375 }]);
});

test('formats shortcuts per platform', () => {
	const event = { code: 'KeyP', ctrl: true, shift: true };
	assert.strictEqual(keyLabel(event, 'win32'), 'Ctrl+Shift+P');
	assert.strictEqual(keyLabel(event, 'darwin'), '⌃⇧P');
	assert.strictEqual(keyLabel({ key: 'Enter', code: 'Enter' }, 'linux'), 'Enter');
	assert.strictEqual(keyLabel({ key: 'Escape', code: 'Escape', meta: true }, 'linux'), 'Super+Esc');
	assert.strictEqual(keyLabel({ code: 'Slash', ctrl: true }, 'win32'), 'Ctrl+/');
	assert.strictEqual(keyLabel({ code: 'Digit1', meta: true }, 'darwin'), '⌘1');
});

test('glides the pointer into each recorded position', () => {
	const track = pointerTrack([{ t: 1, x: 0, y: 0 }, { t: 3, x: 100, y: 0 }], 10, 0.4);
	assert.deepStrictEqual(track[0], { t: 1, x: 0, y: 0 });
	assert.deepStrictEqual(track.at(-1), { t: 3, x: 100, y: 0 });
	assert.ok(track.slice(1, -1).every(sample => sample.t > 2.6 && sample.t < 3 && sample.x > 0 && sample.x < 100));
});

test('requires an aligned recording', () => {
	assert.throws(() => buildStoryboard(manifest({ videoStartedAt: undefined }), footage), /video start time/);
	assert.throws(() => buildStoryboard(manifest({ steps: [] }), footage), /no step boundaries/);
});

test('narration text is plain sentences', () => {
	assert.strictEqual(speakable(['Step 1 of 2.', 'Pick `High`', '', 'Look for: *no* hover']), 'Step 1 of 2. Pick High. Look for: no hover.');
	assert.strictEqual(formatTimestamp(86.4), '1:26');
});
