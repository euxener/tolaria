import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Two-device convergence against a deployment (TOL-239): tests/convergence.spec.ts with
// TOLARIA_CONVERGENCE_BASE_URL set, and nothing started locally. tolaria-cloud's scheduled
// staging run uses it; the same spec runs against a local server in apps/web/playwright.config.ts.
// No traces or videos: they would record the session cookies and the Access headers.

const baseURL = process.env.TOLARIA_CONVERGENCE_BASE_URL;
const outDir = process.env.TOLARIA_CONVERGENCE_OUT_DIR;
if (!baseURL)
	throw new Error(
		"set TOLARIA_CONVERGENCE_BASE_URL (see apps/web/tests/convergenceTargets.ts)",
	);

export default defineConfig({
	testDir: "./tests",
	testMatch: /convergence\.spec\.ts/,
	// Playwright empties its output directory first, so it gets its own under the run's.
	outputDir: outDir
		? join(outDir, "playwright")
		: "../../test-results/web-convergence",
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL,
		headless: true,
		trace: "off",
		video: "off",
		screenshot: "off",
	},
});
