/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Page } from '@playwright/test';

/**
 * A pointer or keyboard event observed in a recorded window.
 *
 * Headless recordings contain no mouse cursor and no record of the shortcuts
 * that were pressed, so the evidence video composites both afterwards from
 * these events. Coordinates are CSS pixels of the window viewport (`vw` x `vh`)
 * and `t` is wall-clock milliseconds, comparable with `videoStartedAt`.
 */
export interface InteractionEvent {
	t: number;
	type: 'move' | 'down' | 'key';
	vw: number;
	vh: number;
	/** `window.devicePixelRatio`, which includes the window's zoom level. */
	dpr?: number;
	x?: number;
	y?: number;
	/** The interactive element under a pointer press. */
	rect?: { x: number; y: number; width: number; height: number };
	/** Only for named keys such as `Escape`; printable keys are identified by `code`. */
	key?: string;
	code?: string;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	meta?: boolean;
}

const MAX_EVENTS = 20000;

/**
 * Listens passively in the page: nothing is drawn into the product UI, no
 * event is cancelled, and typed text is never recorded. Only shortcuts (a key
 * with Ctrl, Alt or Meta, by physical key code) and named keys such as Escape
 * or Enter are kept, so the recording can show them as keystroke chips.
 */
const installScript = `(() => {
	const store = globalThis;
	if (store.__vscodeEvidenceInteractions) {
		return;
	}
	const events = [];
	store.__vscodeEvidenceInteractions = events;
	const named = new Set(['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
		'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
	const modifiers = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn']);
	const interactive = 'button,a,input,textarea,select,[role],.monaco-list-row,.action-item,.monaco-button';
	const push = event => {
		if (events.length < ${MAX_EVENTS}) {
			event.vw = window.innerWidth;
			event.vh = window.innerHeight;
			event.dpr = window.devicePixelRatio || 1;
			events.push(event);
		}
	};
	const round = value => Math.round(value * 10) / 10;
	window.addEventListener('pointermove', event => {
		push({ t: Date.now(), type: 'move', x: round(event.clientX), y: round(event.clientY) });
	}, { capture: true, passive: true });
	window.addEventListener('pointerdown', event => {
		const target = event.target instanceof Element ? (event.target.closest(interactive) || event.target) : undefined;
		const box = target ? target.getBoundingClientRect() : undefined;
		push({
			t: Date.now(), type: 'down', x: round(event.clientX), y: round(event.clientY),
			rect: box ? { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) } : undefined
		});
	}, { capture: true, passive: true });
	window.addEventListener('keydown', event => {
		if (event.repeat || modifiers.has(event.key)) {
			return;
		}
		// AltGr (reported as Ctrl+Alt on Windows) and Option on macOS compose
		// ordinary characters, so those keystrokes are typing, not shortcuts.
		if (event.getModifierState && event.getModifierState('AltGraph')) {
			return;
		}
		const isNamed = named.has(event.key);
		if (!isNamed && (!(event.ctrlKey || event.altKey || event.metaKey) || (event.altKey && !event.ctrlKey && !event.metaKey && navigator.platform.startsWith('Mac')))) {
			return;
		}
		// A printable key is identified by its physical code only; the character it
		// produced is never stored.
		push({ t: Date.now(), type: 'key', ...(isNamed ? { key: event.key } : {}), code: event.code, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
	}, { capture: true, passive: true });
})()`;

const drainScript = '(globalThis.__vscodeEvidenceInteractions || []).splice(0)';

/**
 * Collects pointer and shortcut events from every recorded window.
 *
 * Events are buffered in the page and drained at step boundaries, so a window
 * that reloads only loses the events of the step in progress.
 */
export class InteractionRecorder {
	private readonly events: InteractionEvent[] = [];
	private readonly pages = new Set<Page>();

	track(page: Page): void {
		if (this.pages.has(page)) {
			return;
		}
		this.pages.add(page);
		const install = () => page.evaluate(installScript).catch(() => { /* the window may be closing */ });
		page.on('domcontentloaded', install);
		page.on('close', () => this.pages.delete(page));
		void install();
	}

	async drain(): Promise<void> {
		for (const page of this.pages) {
			try {
				const drained = await page.evaluate(drainScript) as InteractionEvent[];
				for (const event of drained) {
					if (this.events.length < MAX_EVENTS) {
						this.events.push(event);
					}
				}
			} catch {
				// A closed or navigating window cannot be drained; its events are lost,
				// which only removes cursor and keystroke overlays from the video.
			}
		}
	}

	snapshot(): InteractionEvent[] {
		return [...this.events].sort((a, b) => a.t - b.t);
	}
}
