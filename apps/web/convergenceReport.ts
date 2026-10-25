// Numbers and verdict of the two-device convergence run (TOL-239, tests/convergence.spec.ts):
// how long an edit typed in one window takes to show in the other, per direction and overall.

/** A run passes when p95 is under this. */
export const CONVERGENCE_BUDGET_MS = 1000;
/** Fewer samples than this say nothing about p95. */
export const MIN_SAMPLES = 20;

export interface ConvergenceSample {
	/** Who typed and who waited, e.g. "owner → editor". */
	direction: string;
	index: number;
	/** From the edit showing in the typing window to it showing in the other; null if it never did. */
	latencyMs: number | null;
}

export interface ConvergenceRun {
	/** "local", or the base URL of the deployment. */
	target: string;
	startedAt: string;
}

export interface LatencyStats {
	direction: string;
	count: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

export interface ConvergenceSummary extends ConvergenceRun {
	ok: boolean;
	budgetMs: number;
	overall: LatencyStats;
	directions: LatencyStats[];
	timeouts: number;
	failures: string[];
	samples: ConvergenceSample[];
}

/** Nearest rank: the smallest value that at least `fraction` of the values are not above. */
export function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(sorted.length * fraction));
	return sorted[rank - 1] ?? Number.NaN;
}

function arrived(samples: ConvergenceSample[]): number[] {
	return samples.flatMap((sample) =>
		sample.latencyMs === null ? [] : [sample.latencyMs],
	);
}

function statsOf(
	direction: string,
	samples: ConvergenceSample[],
): LatencyStats {
	const latencies = arrived(samples);
	return {
		direction,
		count: latencies.length,
		p50Ms: percentile(latencies, 0.5),
		p95Ms: percentile(latencies, 0.95),
		maxMs: percentile(latencies, 1),
	};
}

function failuresOf(overall: LatencyStats, timeouts: number): string[] {
	const failures: string[] = [];
	if (timeouts > 0)
		failures.push(
			`${timeouts} ${timeouts === 1 ? "edit" : "edits"} never arrived`,
		);
	if (overall.count < MIN_SAMPLES)
		failures.push(
			`${overall.count} samples, at least ${MIN_SAMPLES} are needed`,
		);
	if (!(overall.p95Ms < CONVERGENCE_BUDGET_MS))
		failures.push(
			`p95 ${overall.p95Ms} ms is not under ${CONVERGENCE_BUDGET_MS} ms`,
		);
	return failures;
}

export function summarizeConvergence(
	samples: ConvergenceSample[],
	run: ConvergenceRun,
): ConvergenceSummary {
	const directions = [...new Set(samples.map((sample) => sample.direction))];
	const overall = statsOf("all", samples);
	const timeouts = samples.length - overall.count;
	const failures = failuresOf(overall, timeouts);
	return {
		...run,
		ok: failures.length === 0,
		budgetMs: CONVERGENCE_BUDGET_MS,
		overall,
		directions: directions.map((direction) =>
			statsOf(
				direction,
				samples.filter((sample) => sample.direction === direction),
			),
		),
		timeouts,
		failures,
		samples,
	};
}

function row({ direction, count, p50Ms, p95Ms, maxMs }: LatencyStats): string {
	return `| ${direction} | ${count} | ${p50Ms} | ${p95Ms} | ${maxMs} |`;
}

/** The run's summary as Markdown, for the run's log and its artifact. */
export function formatConvergenceReport(summary: ConvergenceSummary): string {
	const verdict = summary.ok ? "PASS" : "FAIL";
	const lines = [
		`# Two-device convergence: ${verdict}`,
		"",
		`Target: ${summary.target}`,
		`Started: ${summary.startedAt}`,
		`Budget: p95 under ${summary.budgetMs} ms; edits that never arrived: ${summary.timeouts}`,
		"",
		"| direction | samples | p50 ms | p95 ms | max ms |",
		"|---|---|---|---|---|",
		row(summary.overall),
		...summary.directions.map(row),
	];
	if (!summary.ok)
		lines.push(
			"",
			"Failed because:",
			...summary.failures.map((failure) => `- ${failure}`),
		);
	return `${lines.join("\n")}\n`;
}
