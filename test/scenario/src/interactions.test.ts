/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Browser, Page } from '@playwright/test';
import { test } from 'node:test';
import { InteractionRecorder } from './interactions';

async function launch(): Promise<Browser | string> {
	const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
	const errors: string[] = [];
	for (const channel of [undefined, 'chrome', 'msedge']) {
		try {
			return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
		} catch (error) {
			errors.push(error instanceof Error ? error.message.split('\n')[0] : String(error));
		}
	}
	return errors.join('; ');
}

test('records pointer presses and shortcuts but never typed text', async t => {
	const browser = await launch();
	if (typeof browser === 'string') {
		t.skip(`no headless browser: ${browser}`);
		return;
	}
	try {
		const page: Page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		await page.setContent('<button id="go" style="position:absolute;left:100px;top:200px;width:120px;height:40px">Go</button><input id="field" style="position:absolute;left:300px;top:300px">');
		const recorder = new InteractionRecorder();
		recorder.track(page);
		recorder.track(page);
		await page.waitForFunction('!!globalThis.__vscodeEvidenceInteractions');

		const before = Date.now();
		await page.click('#go');
		await page.click('#field');
		await page.keyboard.type('secret');
		await page.keyboard.press('Control+Shift+P');
		await page.keyboard.press('Escape');
		await recorder.drain();

		const events = recorder.snapshot();
		assert.ok(events.every(event => event.t >= before - 50 && event.vw === 800 && event.vh === 600 && event.dpr === 1));
		const presses = events.filter(event => event.type === 'down');
		assert.strictEqual(presses.length, 2);
		assert.deepStrictEqual(presses[0].rect, { x: 100, y: 200, width: 120, height: 40 });
		assert.deepStrictEqual([presses[0].x, presses[0].y], [160, 220]);
		assert.ok(events.some(event => event.type === 'move'), 'pointer moves are recorded');
		const keys = events.filter(event => event.type === 'key');
		assert.deepStrictEqual(keys.map(event => [event.key, event.code, !!event.ctrl, !!event.shift]), [[undefined, 'KeyP', true, true], ['Escape', 'Escape', false, false]]);
		assert.ok(!JSON.stringify(events).includes('secret'), 'typed text is not recorded');
		assert.ok(keys.every(event => event.key === undefined || event.key.length > 1), 'printable characters are identified by code only');

		// Draining empties the page buffer, so events are never reported twice.
		await recorder.drain();
		assert.strictEqual(recorder.snapshot().length, events.length);
	} finally {
		await browser.close();
	}
});
