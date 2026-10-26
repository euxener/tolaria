import type { GitProgressEvent } from "isomorphic-git";

type CloneProgress = (progress: GitProgressEvent) => void;

const cloneStage = (phase: string): string | undefined => {
	switch (phase) {
		case "Receiving objects":
			return "transport";
		case "Resolving deltas":
			return "pack-index";
		case "Updating workdir":
			return "checkout";
		default:
			return undefined;
	}
};

export function runWithNativeGitClonePhaseTiming<T>(
	group: string,
	enter: (phase: string) => void,
	run: (onProgress: CloneProgress) => Promise<T>,
) {
	let previous: string | undefined;
	return run(({ phase }) => {
		const stage = cloneStage(phase);
		if (!stage || stage === previous) return;
		previous = stage;
		enter(`${group}.${stage}`);
	});
}
