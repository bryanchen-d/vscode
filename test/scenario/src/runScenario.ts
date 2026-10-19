/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Locator, Page } from '@playwright/test';
import * as path from 'path';
import type { Application, Code, Workbench } from '../../automation';
import { ApplicationService, JSONValue } from './application';
import { EvidenceBox, EvidenceService, StepBlocker } from './evidence';
import { resolveVideoTool, tryRenderChapters } from './renderEvidenceChapters';

/**
 * Report missing video tooling before anything is launched.
 *
 * Captions are rendered after the run, so a missing ffmpeg is only discovered
 * once the scenario has already finished. Say so up front, with the command to
 * fix it, rather than letting the run complete and produce no annotated video.
 */
function checkVideoTooling(): void {
	const missing = (['ffmpeg', 'ffprobe'] as const).filter(tool => !resolveVideoTool(tool));
	if (!missing.length) {
		return;
	}
	const install = process.platform === 'win32'
		? 'winget install Gyan.FFmpeg'
		: process.platform === 'darwin'
			? 'brew install ffmpeg'
			: 'sudo apt install ffmpeg';
	console.warn(
		`Warning: ${missing.join(' and ')} could not be found, so the recording will not be captioned with step titles.\n` +
		`         The run still produces the raw video, screenshots, trace and report.\n` +
		`         Install ffmpeg (${install}) and re-run. If it is already installed, a PATH change does not\n` +
		`         reach an editor that was already running, so restart it or set FFMPEG_PATH and FFPROBE_PATH,\n` +
		`         then annotate the finished run with: node test/scenario/out/renderEvidenceChapters.js <run-dir>`
	);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Runs a UI validation scenario end to end and writes an evidence bundle.
 *
 * ```
 * node test/scenario/out/runScenario.js <scenario.cjs> [--build <app-root> | --dev]
 * ```
 *
 * The scenario file is not part of this repository, so it can be written next to
 * the run it produces. Give a CommonJS scenario a `.cjs` extension, because this
 * package is an ES module package; an ES module scenario with a default export
 * works too.
 */

export interface ScenarioContext {
	/** The running VS Code instance. */
	readonly app: Application;
	/** Feature-specific automation (editors, settings editor, terminal, ...). */
	readonly workbench: Workbench;
	readonly code: Code;
	/** The window the driver is currently attached to. */
	readonly page: Page;
	/**
	 * Marks the current step `skipped` and stops the run.
	 *
	 * Say what is missing rather than what failed, and classify it: `human` when
	 * a person is required, `infrastructure` when the harness could do it but
	 * cannot yet. Both are reported prominently; the second is an enhancement
	 * request against this skill.
	 */
	skip(reason: string, options?: { needs?: StepBlocker }): never;
	/**
	 * Note a difference between the test instructions and the product, such as a
	 * renamed control. The video pauses here on a CHANGED FROM THE TEST card,
	 * outlining `highlight` and showing `image` (for example the screenshot from
	 * the issue) with `imageCaption` beneath it. `image` is a file path.
	 */
	changed(note: { title: string; body?: string; highlight?: string | Locator; image?: string; imageCaption?: string }): Promise<void>;
	/**
	 * Note something worth a look that is not part of pass/fail. It is listed
	 * after the verdict with a screenshot of `element`, or of the window.
	 */
	finding(note: { title: string; body?: string; element?: string | Locator; caption?: string }): Promise<void>;
}

export interface ScenarioStep {
	/** Stable identifier, used for screenshot names and the chapter card. */
	readonly id: string;
	/** What to do, written as an instruction. Shown as DO. */
	readonly title: string;
	/** The issue or item this step checks, for example `#315712`. */
	readonly ref?: string;
	/** What a person should see when the step passes. Shown as LOOK FOR. */
	readonly lookFor?: string;
	/**
	 * Performs the step. Throw to fail it; the thrown message becomes the
	 * recorded detail. Return a string to describe how the step was validated.
	 */
	run(context: ScenarioContext): Promise<string | void> | string | void;
}

export interface Scenario {
	readonly id: string;
	readonly title: string;
	/** Shown after the title in every header, for example `Insiders from Oct 14 or newer`. */
	readonly subtitle?: string;
	/** `verify` (default) reports a passing run as VERIFIED; `reproduce` reports it as REPRODUCED. */
	readonly purpose?: 'verify' | 'reproduce';
	/** What has to be in place before the first step. Shown on the SET UP band with `userSettings`. */
	readonly setup?: string;
	/** Cases this scenario deliberately does not exercise, listed on the verdict card. */
	readonly notCovered?: readonly string[];
	/** Issue or test-plan item this scenario was derived from. */
	readonly source?: string;
	/** Markdown definition this scenario implements. */
	readonly scenarioPath?: string;
	/** Disposable folder to open. Never point a scenario at real work. */
	readonly workspacePath?: string;
	readonly userSettings?: Record<string, JSONValue>;
	readonly extraArgs?: string[];
	/** Environment overrides for the launched application, without changing the runner's HOME. */
	readonly extraEnv?: Readonly<Record<string, string | undefined>>;
	/**
	 * How long to hold on each completed step, in milliseconds.
	 *
	 * The recording is watched by a person, and a caption is only readable for as
	 * long as its step is on screen, so each step is held briefly once it
	 * finishes. Set `0` when the scenario depends on timing and must run at full
	 * speed.
	 */
	readonly stepPauseMs?: number;
	readonly steps: readonly ScenarioStep[];
}

const DEFAULT_STEP_PAUSE_MS = 1000;

function locatorOf(page: Page, target: string | Locator): Locator {
	return typeof target === 'string' ? page.locator(target).first() : target;
}

async function boxOf(page: Page, target: string | Locator): Promise<EvidenceBox | undefined> {
	try {
		return (await locatorOf(page, target).boundingBox({ timeout: 5000 })) ?? undefined;
	} catch {
		// The note is still recorded; only its outline is lost.
		return undefined;
	}
}

class SkipStep extends Error {
	constructor(reason: string, readonly needs?: StepBlocker) {
		super(reason);
	}
}

function loadScenario(scenarioPath: string): Scenario {
	// A CommonJS scenario needs a `.cjs` extension because this package is an ES
	// module package; an ES module scenario exporting a default works as well.
	const loaded = require(scenarioPath) as Scenario & { default?: Scenario };
	const scenario = loaded?.default ?? loaded;
	if (!scenario || typeof scenario !== 'object') {
		throw new Error(`Scenario '${scenarioPath}' did not export a scenario object.`);
	}
	for (const field of ['id', 'title'] as const) {
		if (typeof scenario[field] !== 'string' || !scenario[field]) {
			throw new Error(`Scenario '${scenarioPath}' is missing '${field}'.`);
		}
	}
	if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
		throw new Error(`Scenario '${scenarioPath}' must declare at least one step.`);
	}
	for (const field of ['subtitle', 'setup'] as const) {
		if (scenario[field] !== undefined && typeof scenario[field] !== 'string') {
			throw new Error(`Scenario '${scenarioPath}' declares a non-string '${field}'.`);
		}
	}
	if (scenario.purpose !== undefined && scenario.purpose !== 'verify' && scenario.purpose !== 'reproduce') {
		throw new Error(`Scenario '${scenarioPath}' purpose must be 'verify' or 'reproduce'.`);
	}
	if (scenario.notCovered !== undefined && (!Array.isArray(scenario.notCovered) || scenario.notCovered.some(item => typeof item !== 'string'))) {
		throw new Error(`Scenario '${scenarioPath}' notCovered must be an array of strings.`);
	}
	const seen = new Set<string>();
	for (const step of scenario.steps) {
		if (typeof step?.id !== 'string' || !step.id || typeof step.title !== 'string' || !step.title) {
			throw new Error(`Scenario '${scenarioPath}' has a step without an 'id' and 'title'.`);
		}
		if (seen.has(step.id)) {
			throw new Error(`Scenario '${scenarioPath}' repeats step id '${step.id}'.`);
		}
		seen.add(step.id);
		for (const field of ['ref', 'lookFor'] as const) {
			if (step[field] !== undefined && typeof step[field] !== 'string') {
				throw new Error(`Step '${step.id}' declares a non-string '${field}'.`);
			}
		}
		if (typeof step.run !== 'function') {
			throw new Error(`Step '${step.id}' does not declare a 'run' function.`);
		}
	}
	return scenario;
}

export interface ScenarioBlocker {
	readonly id: string;
	readonly title: string;
	readonly needs: StepBlocker;
	readonly reason: string;
}

export async function runScenario(scenario: Scenario): Promise<{ runPath: string; outcome: 'passed' | 'failed' | 'aborted'; blockers: ScenarioBlocker[] }> {
	checkVideoTooling();
	const pauseMs = Math.max(0, scenario.stepPauseMs ?? DEFAULT_STEP_PAUSE_MS);
	const blockers: ScenarioBlocker[] = [];
	const appService = new ApplicationService();
	const evidence = new EvidenceService(appService);
	const runPath = await evidence.start(
		scenario.id,
		scenario.title,
		scenario.source,
		scenario.scenarioPath,
		scenario.workspacePath,
		scenario.userSettings,
		scenario.extraArgs,
		scenario.extraEnv,
		{
			subtitle: scenario.subtitle,
			purpose: scenario.purpose,
			setup: scenario.setup,
			notCovered: scenario.notCovered ? [...scenario.notCovered] : undefined,
			steps: scenario.steps.map(step => ({ id: step.id, ref: step.ref, lookFor: step.lookFor }))
		}
	);
	console.log(`Evidence run: ${runPath}`);

	let outcome: 'passed' | 'failed' | 'aborted' = 'passed';
	let notes: string | undefined;
	try {
		for (const step of scenario.steps) {
			await evidence.step(step.id, step.title, 'started');
			const app = await appService.getApplicationIfRunning();
			if (!app) {
				throw new Error('VS Code is no longer running.');
			}
			const page = app.code.driver.currentPage;
			const context: ScenarioContext = {
				app,
				workbench: app.workbench,
				code: app.code,
				page,
				skip: (reason: string, options?: { needs?: StepBlocker }) => { throw new SkipStep(reason, options?.needs); },
				changed: async note => {
					const highlight = note.highlight ? await boxOf(page, note.highlight) : undefined;
					await evidence.annotate('changed', {
						title: note.title,
						body: note.body,
						caption: note.imageCaption,
						highlight,
						image: note.image ? { path: note.image } : undefined
					});
				},
				finding: async note => {
					let data: Buffer | undefined;
					try {
						data = note.element
							? await locatorOf(page, note.element).screenshot({ timeout: 5000 })
							: await app.code.driver.screenshotBuffer(false);
					} catch {
						// A finding without its screenshot is still worth listing.
					}
					await evidence.annotate('finding', {
						title: note.title,
						body: note.body,
						caption: note.caption,
						image: data ? { data } : undefined
					});
				}
			};
			try {
				const details = await step.run(context);
				await evidence.step(step.id, step.title, 'passed', details || undefined);
				console.log(`  PASS ${step.id} ${step.title}`);
				// Hold the finished step so its caption is readable in the recording.
				await wait(pauseMs);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const skipped = error instanceof SkipStep;
				const needs = error instanceof SkipStep ? error.needs : undefined;
				await evidence.step(step.id, step.title, skipped ? 'skipped' : 'failed', message, needs);
				console.log(`  ${skipped ? 'SKIP' : 'FAIL'} ${step.id} ${step.title}${needs ? ` [needs ${needs}]` : ''}: ${message}`);
				if (needs) {
					blockers.push({ id: step.id, title: step.title, needs, reason: message });
				}
				// A later step cannot be trusted once the product is in an
				// unexpected state, and a skipped step means its precondition is
				// unavailable, so stop either way rather than reporting noise.
				// A skipped step leaves the scenario unvalidated, so the run is
				// reported as aborted rather than passed.
				outcome = skipped ? 'aborted' : 'failed';
				notes = `${skipped ? 'Skipped' : 'Failed'} at step '${step.id}': ${message}`;
				await wait(pauseMs);
				break;
			}
		}
	} catch (error) {
		outcome = 'failed';
		notes = error instanceof Error ? error.message : String(error);
		console.error(`Scenario aborted: ${notes}`);
	}

	if (blockers.length) {
		notes = [notes, ...blockers.map(blocker => `Step '${blocker.id}' needs ${blocker.needs}: ${blocker.reason}`)].filter(Boolean).join('\n');
	}

	const reportPath = await evidence.finish(outcome, notes);
	console.log(`Report: ${reportPath}`);
	await tryRenderChapters(runPath);
	for (const blocker of blockers) {
		const reason = blocker.reason.replace(/\s*\.\s*$/u, '');
		console.log(blocker.needs === 'human'
			? `Needs a person: ${blocker.id} ${blocker.title} - ${reason}.`
			: `Needs harness support: ${blocker.id} ${blocker.title} - ${reason}. This is automatable, so report it as an enhancement to the skill.`);
	}
	return { runPath, outcome, blockers };
}

if (require.main === module) {
	const scenarioArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
	if (!scenarioArgument) {
		console.error('Usage: node test/scenario/out/runScenario.js <scenario.cjs> [--build <app-root> | --dev]');
		console.error('  (no target)      run the installed VS Code Insiders, else Stable');
		console.error('  --build <path>   run a specific installed build');
		console.error('  --dev            run the build from this checkout');
		process.exit(2);
	}
	const scenarioPath = path.resolve(scenarioArgument);
	(async () => {
		const { outcome } = await runScenario(loadScenario(scenarioPath));
		console.log(`Outcome: ${outcome}`);
		// Exit rather than resolving, because the harness leaves the profile
		// cleanup timer and Playwright's transport open.
		process.exit(outcome === 'passed' ? 0 : 1);
	})().catch(error => {
		console.error(error instanceof Error ? error.stack ?? error.message : error);
		process.exit(1);
	});
}
