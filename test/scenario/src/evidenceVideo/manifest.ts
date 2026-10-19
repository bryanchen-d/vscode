/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The evidence manifest as the video renderer reads it. Every field is optional
// because manifests written by older harness versions, and those rebuilt by CI
// finalization, carry only a subset.

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ManifestCapture {
	status?: string;
	timestamp?: string;
	details?: string;
	blockedOn?: string;
}

export interface ManifestStep {
	id?: string;
	title?: string;
	ref?: string;
	lookFor?: string;
	captures?: ManifestCapture[];
}

export interface ManifestInteraction {
	t: number;
	type: string;
	vw: number;
	vh: number;
	dpr?: number;
	x?: number;
	y?: number;
	rect?: Box;
	key?: string;
	code?: string;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	meta?: boolean;
}

export interface ManifestAnnotation {
	kind?: string;
	stepId?: string;
	timestamp?: string;
	title?: string;
	body?: string;
	caption?: string;
	highlight?: Box;
	viewport?: { width: number; height: number; dpr?: number };
	image?: string;
}

export interface EvidenceManifest {
	scenarioId?: string;
	title?: string;
	outcome?: string;
	notes?: string;
	startedAt?: string;
	completedAt?: string;
	videoStartedAt?: string;
	environment?: { platform?: string; vscodeVersion?: string; quality?: string };
	presentation?: {
		subtitle?: string;
		purpose?: string;
		setup?: string;
		notCovered?: string[];
		userSettings?: Record<string, unknown>;
	};
	artifacts?: { videos?: string[];[key: string]: unknown };
	steps?: ManifestStep[];
	annotations?: ManifestAnnotation[];
	interactions?: ManifestInteraction[];
	rendering?: unknown;
}

export function isFiniteBox(value: unknown): value is Box {
	const box = value as Box | undefined;
	return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
}
