import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONVERGENCE_BUDGET_MS,
	type ConvergenceSample,
	formatConvergenceReport,
	MIN_SAMPLES,
	percentile,
	summarizeConvergence,
} from "./convergenceReport.ts";

function samples(direction: string, latencies: number[]): ConvergenceSample[] {
	return latencies.map((latencyMs, index) => ({
		direction,
		index,
		latencyMs,
	}));
}

const run = { target: "local", startedAt: "2026-10-25T20:00:00.000Z" };

/** Twenty quick samples each way: what a healthy run looks like. */
function healthy(): ConvergenceSample[] {
	const quick = Array.from({ length: 20 }, (_, index) => 40 + index);
	return [
		...samples("owner → editor", quick),
		...samples("editor → owner", quick),
	];
}

describe("percentile", () => {
	it("takes the nearest rank, so p95 of 20 values is the 19th", () => {
		const values = Array.from({ length: 20 }, (_, index) => index + 1);
		assert.equal(percentile(values, 0.5), 10);
		assert.equal(percentile(values, 0.95), 19);
		assert.equal(percentile(values, 1), 20);
	});

	it("does not depend on the order of the values", () => {
		assert.equal(percentile([300, 100, 200], 0.5), 200);
	});

	it("is not a number without values", () => {
		assert.ok(Number.isNaN(percentile([], 0.95)));
	});
});

describe("summarizeConvergence", () => {
	it("passes a run whose p95 is under the budget", () => {
		const summary = summarizeConvergence(healthy(), run);
		assert.equal(summary.ok, true);
		assert.equal(summary.overall.count, 40);
		assert.equal(summary.overall.p50Ms, 49);
		assert.equal(summary.overall.p95Ms, 58);
		assert.equal(summary.overall.maxMs, 59);
		assert.deepEqual(
			summary.directions.map((direction) => direction.direction),
			["owner → editor", "editor → owner"],
		);
		assert.deepEqual(summary.failures, []);
	});

	it(`fails a run whose p95 reaches ${CONVERGENCE_BUDGET_MS} ms`, () => {
		const slow = healthy().map((sample, index) =>
			index % 10 === 0
				? { ...sample, latencyMs: CONVERGENCE_BUDGET_MS }
				: sample,
		);
		const summary = summarizeConvergence(slow, run);
		assert.equal(summary.ok, false);
		assert.equal(summary.overall.p95Ms, CONVERGENCE_BUDGET_MS);
		assert.match(
			summary.failures.join("\n"),
			/p95 1000 ms is not under 1000 ms/u,
		);
	});

	it("fails a run with an edit that never arrived, whatever the percentiles say", () => {
		const lost = [
			...healthy(),
			{ direction: "editor → owner", index: 20, latencyMs: null },
		];
		const summary = summarizeConvergence(lost, run);
		assert.equal(summary.ok, false);
		assert.equal(summary.timeouts, 1);
		assert.match(summary.failures.join("\n"), /1 edit never arrived/u);
	});

	it(`fails a run with fewer than ${MIN_SAMPLES} samples`, () => {
		const summary = summarizeConvergence(
			samples("owner → editor", [10, 20]),
			run,
		);
		assert.equal(summary.ok, false);
		assert.match(
			summary.failures.join("\n"),
			/2 samples, at least 20 are needed/u,
		);
	});
});

describe("formatConvergenceReport", () => {
	it("reads as a summary with the verdict, the numbers and each direction", () => {
		const text = formatConvergenceReport(summarizeConvergence(healthy(), run));
		assert.match(text, /^# Two-device convergence: PASS/u);
		assert.match(text, /\| all \| 40 \| 49 \| 58 \| 59 \|/u);
		assert.match(text, /\| owner → editor \| 20 \|/u);
		assert.match(text, /Target: local/u);
	});

	it("lists why a run failed", () => {
		const lost = [
			...healthy(),
			{ direction: "owner → editor", index: 20, latencyMs: null },
		];
		const text = formatConvergenceReport(summarizeConvergence(lost, run));
		assert.match(text, /^# Two-device convergence: FAIL/u);
		assert.match(text, /- 1 edit never arrived/u);
	});
});
