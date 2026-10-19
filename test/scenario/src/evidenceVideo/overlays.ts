/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Cards, bands, chips and callouts are laid out as HTML and rasterized to
// transparent PNGs by a headless browser, so typography, pills and rounded
// shapes match the reference style; ffmpeg only composites the images.
//
// Playwright is loaded at run time rather than imported, so this module still
// compiles where only Node is available (CI compiles the renderer on its own).

import * as fs from 'fs';
import * as path from 'path';
import type { BandContent, Callout, Finding, Tone, Verdict } from './storyboard';

export interface Rasterizer {
	/** Height of `#root` laid out at `width`. */
	measure(html: string, width: number): Promise<number>;
	/** Write `#root` to `file` as a transparent PNG and return its pixel size. */
	render(html: string, file: string, viewport: { width: number; height: number }): Promise<{ width: number; height: number }>;
	close(): Promise<void>;
}

interface BrowserLike {
	newPage(): Promise<PageLike>;
	close(): Promise<void>;
}

interface PageLike {
	setViewportSize(size: { width: number; height: number }): Promise<void>;
	setContent(html: string): Promise<void>;
	evaluate(expression: string): Promise<unknown>;
	locator(selector: string): { screenshot(options: { path: string; omitBackground: boolean }): Promise<Buffer> };
}

interface ChromiumLike {
	launch(options: { headless: boolean; channel?: string }): Promise<BrowserLike>;
}

/**
 * Launch a headless Chromium for rasterizing.
 *
 * Tries Playwright's bundled browser first, then installed Chrome and Edge, so
 * a machine that runs Electron scenarios without a downloaded browser still
 * gets the styled video.
 */
export async function createRasterizer(): Promise<Rasterizer> {
	let chromium: ChromiumLike | undefined;
	const errors: string[] = [];
	for (const name of ['playwright-core', '@playwright/test', 'playwright']) {
		try {
			chromium = (require(name) as { chromium: ChromiumLike }).chromium;
			break;
		} catch (error) {
			errors.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
		}
	}
	if (!chromium) {
		throw new Error(`Playwright is not available (${errors.join('; ')})`);
	}
	let browser: BrowserLike | undefined;
	for (const channel of [undefined, 'chrome', 'msedge']) {
		try {
			browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
			break;
		} catch (error) {
			errors.push(`${channel ?? 'chromium'}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
		}
	}
	if (!browser) {
		throw new Error(`no headless Chromium could be launched (${errors.join('; ')})`);
	}
	const page = await browser.newPage();
	const load = async (html: string, viewport: { width: number; height: number }) => {
		await page.setViewportSize(viewport);
		await page.setContent(html);
		await page.evaluate('document.fonts.ready.then(() => true)');
	};
	return {
		async measure(html, width) {
			await load(html, { width, height: 4000 });
			return Number(await page.evaluate('Math.ceil(document.getElementById("root").getBoundingClientRect().height)'));
		},
		async render(html, file, viewport) {
			await load(html, viewport);
			await page.locator('#root').screenshot({ path: file, omitBackground: true });
			return pngSize(file);
		},
		close: () => browser!.close()
	};
}

export function pngSize(file: string): { width: number; height: number } {
	const header = Buffer.alloc(24);
	const handle = fs.openSync(file, 'r');
	try {
		fs.readSync(handle, header, 0, 24, 0);
	} finally {
		fs.closeSync(handle);
	}
	if (header.toString('ascii', 12, 16) !== 'IHDR') {
		throw new Error(`${path.basename(file)} is not a PNG image`);
	}
	return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

// ---- Layout ----

export interface Layout {
	/** Scale relative to the 1920px design width. */
	scale: number;
	width: number;
	footageHeight: number;
	bandHeight: number;
	margin: number;
	textWidth: number;
	inset?: {
		zoom: number;
		frame: { x: number; y: number; width: number; height: number };
		video: { x: number; y: number; width: number; height: number };
		crop: { width: number; height: number };
		labelTop: number;
	};
}

const DESIGN_WIDTH = 1920;
const ZOOM = 2;

export function baseLayout(width: number, footageHeight: number, withInset: boolean): Omit<Layout, 'bandHeight' | 'inset'> & { insetWidth: number } {
	const scale = width / DESIGN_WIDTH;
	const margin = Math.round(48 * scale);
	const insetWidth = withInset ? even(Math.round(width * 0.335)) : 0;
	const textWidth = withInset ? width - insetWidth - margin * 3 : width - margin * 2;
	return { scale, width, footageHeight, margin, textWidth, insetWidth };
}

export function finishLayout(base: ReturnType<typeof baseLayout>, measuredBandHeight: number): Layout {
	const { insetWidth, ...rest } = base;
	const bandHeight = even(Math.max(Math.round(250 * base.scale), measuredBandHeight));
	const layout: Layout = { ...rest, bandHeight };
	if (insetWidth) {
		const border = Math.max(2, Math.round(2 * base.scale));
		const top = Math.round(Math.max(bandHeight * 0.18, 40 * base.scale));
		const bottom = Math.round(bandHeight * 0.13);
		const frame = { x: base.width - base.margin - insetWidth, y: top, width: insetWidth, height: bandHeight - top - bottom };
		const video = { x: frame.x + border, y: frame.y + border, width: even(frame.width - border * 2), height: even(frame.height - border * 2) };
		layout.inset = {
			zoom: ZOOM,
			frame,
			video,
			crop: {
				width: Math.min(base.width, Math.round(video.width / ZOOM)),
				height: Math.min(base.footageHeight, Math.round(video.height / ZOOM))
			},
			labelTop: Math.max(0, top - Math.round(26 * base.scale))
		};
	}
	return layout;
}

function even(value: number): number {
	return value + (value % 2);
}

// ---- Templates ----

const toneColors: Record<Tone, { text: string; fill: string }> = {
	blue: { text: '#58a6ff', fill: '#1f6feb' },
	green: { text: '#3fb950', fill: '#238636' },
	red: { text: '#f85149', fill: '#da3633' },
	amber: { text: '#d29922', fill: '#9e6a03' },
	gray: { text: '#8b949e', fill: '#6e7681' }
};

function documentFor(scale: number, body: string): string {
	const px = (value: number) => `${Math.round(value * scale * 100) / 100}px`;
	const tones = (Object.keys(toneColors) as Tone[]).map(tone =>
		`.tag.${tone}{color:${toneColors[tone].text}}.pill.${tone}{background:${toneColors[tone].fill}}`).join('');
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
*{box-sizing:border-box}
body{font-family:"Inter","Segoe UI Variable Text","Segoe UI","SF Pro Text",-apple-system,"Helvetica Neue","DejaVu Sans",Arial,sans-serif;color:#e6edf3;-webkit-font-smoothing:antialiased}
code{font-family:"Cascadia Code","SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;background:#262c36;color:#e3b341;border-radius:${px(6)};padding:${px(1)} ${px(8)};font-size:0.92em;white-space:pre-wrap}
.tag{font-weight:700;letter-spacing:0.02em;margin-right:${px(18)};white-space:nowrap}
.hdr{color:#8b949e}
.pill{display:inline-block;color:#fff;font-weight:700;border-radius:999px;white-space:nowrap;letter-spacing:0.02em}
${tones}
.band{position:relative;overflow:hidden}
.band .col{position:absolute}
.band .eyebrow{display:flex;align-items:baseline;font-size:${px(21)};line-height:1.3;margin-bottom:${px(8)}}
.band .eyebrow .hdr{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.band .eyebrow .pill{font-size:${px(16)};padding:${px(3)} ${px(12)};margin-left:${px(14)}}
.band .line{display:flex;align-items:flex-start;gap:${px(14)};margin-top:${px(6)}}
.band .line .pill{font-size:${px(15)};padding:${px(4)} ${px(11)};margin-top:${px(4)};flex:none}
.band .do{font-size:${px(30)};font-weight:600;line-height:1.38;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.band .look,.band .details{font-size:${px(24)};line-height:1.38;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.band .details{color:#c9d1d9}
.band .codes{display:flex;flex-wrap:wrap;gap:${px(6)} ${px(8)};font-size:${px(22)};line-height:1.4;max-height:${px(66)};overflow:hidden}
.band .zlabel{position:absolute;font-size:${px(15)};font-weight:700;letter-spacing:0.04em;color:#8b949e}
.band .zframe{position:absolute;border:${px(2)} solid #c9d1d9}
.band .rule{position:absolute;left:0;right:0;height:1px;background:#30363d}
.chip{display:inline-block;padding:${px(8)} ${px(20)};border:${px(2)} solid #e6edf3;border-radius:${px(12)};background:rgba(13,17,23,0.92);font-size:${px(30)};font-weight:700;letter-spacing:0.04em;white-space:nowrap}
.callout{background:#0d1117;border:${px(3)} solid #d29922;border-radius:${px(14)};padding:${px(24)} ${px(26)}}
.callout .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:${px(14)}}
.callout .head .pill{font-size:${px(19)};padding:${px(7)} ${px(16)}}
.callout .paused{display:flex;align-items:center;gap:${px(4)};font-size:${px(17)};font-weight:700;letter-spacing:0.04em;color:#c9d1d9}
.callout .paused i{display:inline-block;width:${px(5)};height:${px(17)};background:#c9d1d9;margin-right:${px(2)}}
.callout .paused span{margin-left:${px(8)}}
.callout .title{font-size:${px(32)};font-weight:600;line-height:1.3}
.callout .body{font-size:${px(25)};line-height:1.42;margin-top:${px(8)};color:#e6edf3}
.callout img{display:block;max-width:100%;max-height:${px(240)};margin-top:${px(14)};border:${px(1)} solid #6e7681;background:#fff}
.callout .caption{font-size:${px(21)};color:#c9d1d9;margin-top:${px(8)}}
.outline{border:${px(4)} solid #d29922;border-radius:${px(10)};box-shadow:0 0 0 ${px(2)} rgba(13,17,23,0.6)}
.card{position:relative;background:#0d1117;overflow:hidden}
.card .chead{position:absolute;left:${px(96)};right:${px(96)};top:${px(44)};padding-bottom:${px(20)};border-bottom:1px solid #30363d;font-size:${px(22)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .cbody{position:absolute;left:${px(96)};right:${px(96)};top:${px(120)};bottom:${px(80)};display:flex;flex-direction:column;justify-content:center}
.card .big{font-size:${px(26)};padding:${px(10)} ${px(22)};align-self:flex-start}
.card .headline{font-size:${px(44)};font-weight:600;line-height:1.36;margin-top:${px(26)}}
.card .meta{font-size:${px(27)};color:#8b949e;margin-top:${px(10)}}
.card .nc{display:flex;gap:${px(22)};margin-top:${px(40)};font-size:${px(27)};line-height:1.5}
.card .nc .label{flex:none;font-size:${px(20)};font-weight:700;color:#8b949e;letter-spacing:0.03em;padding-top:${px(5)}}
.card .nc .items{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden}
.card .row{display:flex;align-items:center;gap:${px(22)};margin:${px(12)} 0}
.card .row .time{font-size:${px(28)};color:#8b949e;width:${px(86)};flex:none}
.card .row .pill{font-size:${px(18)};padding:${px(6)} ${px(14)};flex:none}
.card .row .text{font-size:${px(31)};font-weight:500;line-height:1.35}
.card .split{display:flex;gap:${px(64)};align-items:center}
.card .split .left{flex:1;min-width:0}
.card .split .right{flex:none;max-width:45%}
.card .split .pill{font-size:${px(22)};padding:${px(8)} ${px(18)}}
.card .ftitle{font-size:${px(40)};font-weight:600;line-height:1.3;margin-top:${px(20)}}
.card .fbody{font-size:${px(28)};line-height:1.5;margin-top:${px(10)};color:#e6edf3}
.card .right img{display:block;max-width:100%;max-height:${px(520)};border:${px(2)} solid #6e7681}
.card .right .caption{font-size:${px(23)};color:#8b949e;margin-top:${px(12)};line-height:1.45}
.card .foot{position:absolute;left:${px(96)};bottom:${px(48)};font-size:${px(23)};color:#8b949e}
</style></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;');
}

/** Escaped text with `code` spans as chips and `->` as an arrow. */
export function richText(value: string): string {
	return value.split(/(`[^`]+`)/u).map(part => part.startsWith('`') && part.endsWith('`') && part.length > 2
		? `<code>${escapeHtml(part.slice(1, -1))}</code>`
		: escapeHtml(part).replaceAll('-&gt;', '→')).join('');
}

export function bandHtml(content: BandContent, layout: Layout | (Omit<Layout, 'bandHeight' | 'inset'> & { bandHeight?: number; inset?: Layout['inset'] })): string {
	const padTop = Math.round(26 * layout.scale);
	const size = layout.bandHeight ? `width:${layout.width}px;height:${layout.bandHeight}px` : `width:${layout.width}px;padding-bottom:${padTop}px`;
	const result = content.result;
	const lines = [
		content.instruction ? `<div class="line"><span class="pill blue">DO</span><div class="do">${richText(content.instruction)}</div></div>` : '',
		content.settings?.length ? `<div class="line"><span class="pill green">USER SETTINGS</span><div class="codes">${content.settings.map(item => `<code>${escapeHtml(item)}</code>`).join('')}</div></div>` : '',
		content.lookFor ? `<div class="line"><span class="pill green">LOOK FOR</span><div class="look">${richText(content.lookFor)}</div></div>` : '',
		result?.details ? `<div class="line"><span class="pill ${result.tone}">RESULT</span><div class="details">${richText(result.details)}</div></div>` : ''
	].join('');
	const inset = layout.inset;
	const insetHtml = inset && layout.bandHeight
		? `<div class="zlabel" style="left:${inset.frame.x}px;top:${inset.labelTop}px">ZOOMED IN ${inset.zoom}×</div>`
		+ `<div class="zframe" style="left:${inset.frame.x}px;top:${inset.frame.y}px;width:${inset.frame.width}px;height:${inset.frame.height}px"></div>`
		: '';
	const rule = layout.bandHeight ? `<div class="rule" style="top:${layout.bandHeight - 1}px"></div>` : '';
	const column = layout.bandHeight
		? `<div class="col" style="left:${layout.margin}px;top:${padTop}px;width:${layout.textWidth}px">`
		// Measured in flow, so the column's height is the band's height.
		: `<div style="margin-left:${layout.margin}px;padding-top:${padTop}px;width:${layout.textWidth}px">`;
	return documentFor(layout.scale, `<div id="root" class="band" style="${size}">${column}`
		+ `<div class="eyebrow"><span class="tag ${content.eyebrowTone}">${escapeHtml(content.eyebrow)}</span><span class="hdr">${escapeHtml(content.header)}</span>`
		+ `${result ? `<span class="pill ${result.tone}">${escapeHtml(result.label)}</span>` : ''}</div>${lines}</div>${insetHtml}${rule}</div>`);
}

export function chipHtml(label: string, scale: number): string {
	return documentFor(scale, `<div id="root" class="chip">${escapeHtml(label)}</div>`);
}

/** The pointer arrow; its hotspot is `hotspot` pixels from the top left. */
export function cursorHtml(scale: number): { html: string; hotspot: number } {
	const width = Math.round(26 * scale);
	const height = Math.round(38 * scale);
	return {
		hotspot: Math.round(2 * scale),
		html: documentFor(scale, `<div id="root" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" viewBox="0 0 26 38">`
			+ `<path d="M2 2 L2 29 L8.6 22.8 L13.3 34 L17.6 32.2 L13 21.3 L21.9 21.3 Z" fill="#ffffff" stroke="#000000" stroke-width="1.7" stroke-linejoin="round"/></svg></div>`)
	};
}

export function outlineHtml(width: number, height: number, scale: number): string {
	return documentFor(scale, `<div id="root" class="outline" style="width:${width}px;height:${height}px"></div>`);
}

export function calloutHtml(callout: Callout, width: number, scale: number, image: string | undefined): string {
	return documentFor(scale, `<div id="root" class="callout" style="width:${width}px">`
		+ `<div class="head"><span class="pill amber">CHANGED FROM THE TEST</span><span class="paused"><i></i><i></i><span>PAUSED</span></span></div>`
		+ `<div class="title">${richText(callout.title)}</div>`
		+ (callout.body ? `<div class="body">${richText(callout.body)}</div>` : '')
		+ (image ? `<img src="${image}">` : '')
		+ (callout.imageCaption ? `<div class="caption">${richText(callout.imageCaption)}</div>` : '')
		+ `</div>`);
}

function cardFrame(width: number, height: number, scale: number, eyebrow: string, tone: Tone, header: string, body: string, foot = ''): string {
	return documentFor(scale, `<div id="root" class="card" style="width:${width}px;height:${height}px">`
		+ `<div class="chead"><span class="tag ${tone}">${escapeHtml(eyebrow)}</span><span class="hdr">${escapeHtml(header)}</span></div>`
		+ `<div class="cbody">${body}</div>${foot ? `<div class="foot">${escapeHtml(foot)}</div>` : ''}</div>`);
}

export function verdictHtml(verdict: Verdict, header: string, width: number, height: number, scale: number): string {
	return cardFrame(width, height, scale, 'VERDICT', 'blue', header,
		`<span class="pill big ${verdict.tone}">${escapeHtml(verdict.label)}</span>`
		+ `<div class="headline">${richText(verdict.headline)}</div>`
		+ (verdict.meta ? `<div class="meta">${escapeHtml(verdict.meta)}</div>` : '')
		+ (verdict.notCovered.length ? `<div class="nc"><span class="label">NOT COVERED</span><div class="items">${verdict.notCovered.map(richText).join(' ')}</div></div>` : ''));
}

export function reportHtml(rows: { time: string; label: string; tone: Tone; text: string }[], header: string, width: number, height: number, scale: number): string {
	return cardFrame(width, height, scale, 'TO REPORT', 'amber', header,
		rows.map(row => `<div class="row"><span class="time">${escapeHtml(row.time)}</span><span class="pill ${row.tone}">${escapeHtml(row.label)}</span><span class="text">${richText(row.text)}</span></div>`).join(''));
}

export function findingHtml(finding: Finding, header: string, width: number, height: number, scale: number, image: string | undefined): string {
	return cardFrame(width, height, scale, 'WORTH A LOOK', 'amber', header,
		`<div class="split"><div class="left"><span class="pill amber">CHECK THIS</span><div class="ftitle">${richText(finding.title)}</div>`
		+ (finding.body ? `<div class="fbody">${richText(finding.body)}</div>` : '') + `</div>`
		+ (image ? `<div class="right"><img src="${image}">${finding.caption ? `<div class="caption">${richText(finding.caption)}</div>` : ''}</div>` : '')
		+ `</div>`,
		'Not part of this test\'s pass/fail: report it if you see it too.');
}

/** An image from the run directory as a data URI; anything outside the run is refused. */
export function imageDataUri(runRoot: string, relativePath: string | undefined): string | undefined {
	if (!relativePath) {
		return undefined;
	}
	const resolved = path.resolve(runRoot, relativePath);
	if (!resolved.startsWith(path.resolve(runRoot) + path.sep) || !fs.existsSync(resolved)) {
		return undefined;
	}
	const extension = path.extname(resolved).toLowerCase();
	const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[extension];
	return type ? `data:${type};base64,${fs.readFileSync(resolved).toString('base64')}` : undefined;
}
