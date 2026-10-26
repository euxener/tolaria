import type { GitProgressEvent } from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { runWithNativeGitClonePhaseTiming } from "./nativeGitClonePhaseTiming";

describe("native Git clone phase timing", () => {
	it("forwards transport, pack/index and checkout phase boundaries to the QA sampler", async () => {
		const enter = vi.fn();
		const value = await runWithNativeGitClonePhaseTiming(
			"clone.first",
			enter,
			async (onProgress) => {
				const phases: GitProgressEvent[] = [
					{ phase: "Counting objects", loaded: 1, total: 4 },
					{ phase: "Receiving objects", loaded: 1, total: 4 },
					{ phase: "Receiving objects", loaded: 2, total: 4 },
					{ phase: "Counting objects", loaded: 2, total: 4 },
					{ phase: "Receiving objects", loaded: 3, total: 4 },
					{ phase: "Resolving deltas", loaded: 1, total: 2 },
					{ phase: "Updating workdir", loaded: 1, total: 1 },
				];
				for (const phase of phases) onProgress(phase);
				return "cloned";
			},
		);

		expect(value).toBe("cloned");
		expect(enter.mock.calls.map(([phase]) => phase)).toEqual([
			"clone.first.transport",
			"clone.first.pack-index",
			"clone.first.checkout",
		]);
	});
});
