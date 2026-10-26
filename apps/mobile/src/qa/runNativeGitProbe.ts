import { requireOptionalNativeModule } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import git, { type HttpClient } from "isomorphic-git";
import { gitVirtualRoot } from "../workspace/git/gitFileSystemPaths";
import { gitFileSystemSession } from "../workspace/git/gitFileSystemSessions";
import { cloneGitVault, syncGitVault } from "../workspace/git/gitRemote";
import { nativeGitHttp } from "../workspace/git/nativeGitHttp";
import { assertGitReadFailureSafety } from "./assertGitReadFailureSafety";
import { measureEventLoopDelay } from "./measureEventLoopDelay";
import { measureGitFileSystem } from "./measureGitFileSystem";
import { runWithNativeGitClonePhaseTiming } from "./nativeGitClonePhaseTiming";
import { assertNativeGitRecovery } from "./nativeGitRecoveryProbe";
import { postNativeQaEvent, setNativeQaSinkUrl } from "./nativeQaSink";
import {
	createNativeLargeVaultFixture,
	nativeVaultReadBenchmark,
} from "./nativeVaultReadBenchmark";
import { assertNativeWorkspaceWriteErrors } from "./nativeWorkspaceWriteErrors";

let running = false;

/** Disposable device-local working copies; never opens a user-selected vault. */
export async function runNativeGitProbe(endpoint: string) {
	if (running) return;
	running = true;
	const root = new Directory(Paths.cache, `tolaria-git-qa-${Date.now()}`);
	const started = Date.now();
	try {
		root.create();
		const safetyProof = await prepareProbeFixture(root);
		const largeVault = new Directory(root, "large-vault");
		const generated = await createNativeLargeVaultFixture(largeVault.uri, {
			createDirectory: (path) => new Directory(path).create(),
			writeText: (path, content) => new File(path).write(content),
		});
		const { result, eventLoop, phases } = await measureEventLoopDelay(
			(enter) => {
				enter("git-sync+6000-note-index");
				return Promise.all([
					roundTrip(root, endpoint, enter),
					nativeVaultReadBenchmark(largeVault.uri),
				]);
			},
		);
		const [proof, benchmark] = result;
		const elapsedMs = Date.now() - started;
		const fixtureVault = benchmark
			? {
					...benchmark,
					marker: generated.marker,
					markerPath: generated.markerPath,
					inputQueueLatencyMs: eventLoop.maxDelayMs,
					longInputQueueDelayCount: eventLoop.longDelayCount,
				}
			: null;
		publishProof(endpoint, {
			...proof,
			...safetyProof,
			eventLoop,
			phases,
			fixtureVault,
			elapsedMs,
		});
	} catch (error) {
		publishProof(endpoint, {
			error: error instanceof Error ? error.message : "unknown",
			stack: error instanceof Error ? error.stack : null,
			passed: false,
		});
	} finally {
		if (root.exists) root.delete();
		running = false;
	}
}

async function prepareProbeFixture(root: Directory) {
	await assertNativeWorkspaceWriteErrors(root);
	const nativeDigestVerified = await verifyNativeDigest();
	const nativeFiles = await nativeFileAccessProof();
	const readSafety = new Directory(root, "read-safety");
	readSafety.create();
	const readErrorsVerified = await assertGitReadFailureSafety({
		fs: gitFileSystemSession(readSafety.uri),
		dir: gitVirtualRoot,
	});
	const checkoutRecovery = await assertNativeGitRecovery(root);
	return {
		nativeDigestVerified,
		nativeFiles,
		readErrorsVerified,
		checkoutRecovery,
	};
}

async function verifyNativeDigest() {
	const { oid } = await git.hashBlob({ object: new Uint8Array() });
	if (oid !== "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
		throw new Error("nativeDigestVerificationFailed");
	return true;
}

async function nativeFileAccessProof() {
	const module = requireOptionalNativeModule<{
		runFileAccessProbe?: () => Promise<Record<string, boolean>>;
	}>("TolariaWorkspaceAccess");
	if (!module?.runFileAccessProbe) return null;
	const checks = await module.runFileAccessProbe();
	if (!Object.values(checks).every(Boolean))
		throw new Error("nativeFileAccessProofFailed");
	return checks;
}

async function roundTrip(
	root: Directory,
	endpoint: string,
	enter: (phase: string) => void,
) {
	const started = Date.now();
	const { first, second, connection } = createCloneFixtures(root, endpoint);
	const firstClone = await cloneFixture(
		first,
		connection,
		"clone.first",
		enter,
	);
	const secondClone = await cloneFixture(
		second,
		connection,
		"clone.second",
		enter,
	);
	const sync = await editAndSyncClones({
		first,
		second,
		connection,
		secondCloned: secondClone.finishedAt,
		enter,
	});
	enter("verify");
	const preserved = await verifyRoundTrip(
		second,
		sync.content,
		sync.attachment,
	);
	const passed =
		preserved.binaryPreserved &&
		preserved.deletionPreserved &&
		preserved.contentPreserved &&
		sync.pushed === "synced" &&
		sync.pulled === "synced" &&
		sync.unchangedSync;
	return {
		passed,
		...preserved,
		unchangedSync: sync.unchangedSync,
		pushed: sync.pushed,
		pulled: sync.pulled,
		timings: {
			firstCloneMs: firstClone.finishedAt - started,
			secondCloneMs: secondClone.finishedAt - firstClone.finishedAt,
			...sync.timings,
		},
		fileSystem: {
			firstClone: firstClone.fileSystem.snapshot(),
			secondClone: secondClone.fileSystem.snapshot(),
		},
	};
}

function createCloneFixtures(root: Directory, endpoint: string) {
	const first = new Directory(root, "first");
	const second = new Directory(root, "second");
	first.create();
	second.create();
	const http: HttpClient = {
		request: (request) => {
			const url = new URL(request.url);
			return nativeGitHttp.request({
				...request,
				url: `${endpoint}${url.pathname}${url.search}`,
			});
		},
	};
	const connection = (directory: Directory) => ({
		fs: gitFileSystemSession(directory.uri),
		dir: gitVirtualRoot,
		http,
	});
	return { first, second, connection };
}

async function cloneFixture(
	directory: Directory,
	connection: (directory: Directory) => {
		fs: ReturnType<typeof gitFileSystemSession>;
		dir: string;
		http: HttpClient;
	},
	group: string,
	enter: (phase: string) => void,
) {
	const repositoryUrl = "https://github.com/team/vault";
	enter(`${group}.setup`);
	const gitConnection = connection(directory);
	const fileSystem = measureGitFileSystem(gitConnection.fs);
	await runWithNativeGitClonePhaseTiming(group, enter, (onProgress) =>
		cloneGitVault(
			{ ...gitConnection, fs: fileSystem.fs, onProgress },
			repositoryUrl,
		),
	);
	return { finishedAt: Date.now(), fileSystem };
}

type CloneConnection = (directory: Directory) => {
	fs: ReturnType<typeof gitFileSystemSession>;
	dir: string;
	http: HttpClient;
};

type CloneSyncInput = {
	first: Directory;
	second: Directory;
	connection: CloneConnection;
	secondCloned: number;
	enter: (phase: string) => void;
};

async function editAndSyncClones({
	first,
	second,
	connection,
	secondCloned,
	enter,
}: CloneSyncInput) {
	enter("fixture.edit");
	const content =
		"---\ncustom: preserved\ntags: [native]\n---\n# Native Git round trip\n";
	new File(first, "note.md").write(content);
	const attachment = new Uint8Array([0, 255, 1, 128, 10, 0, 250]);
	new Directory(first, "attachments").create();
	new File(first, "attachments", "bytes.bin").write(attachment);
	new File(first, "deleted.md").delete();
	const author = { name: "Native QA", email: "qa@example.invalid" };
	const sync = (directory: Directory, name: string) =>
		syncGitVault(
			{
				...connection(directory),
				onPhase: (phase) => enter(`${name}.${phase}`),
			},
			author,
		);
	const pushed = await sync(first, "push");
	const firstSynced = Date.now();
	const pulled = await sync(second, "pull");
	const secondSynced = Date.now();
	const unchanged = await sync(second, "unchanged");
	const unchangedSynced = Date.now();
	const unchangedSync =
		unchanged.kind === "synced" &&
		unchanged.changedFiles === 0 &&
		!unchanged.workspaceChanged;
	return {
		content,
		attachment,
		pushed: pushed.kind,
		pulled: pulled.kind,
		unchangedSync,
		timings: {
			pushMs: firstSynced - secondCloned,
			pullMs: secondSynced - firstSynced,
			unchangedSyncMs: unchangedSynced - secondSynced,
		},
	};
}

async function verifyRoundTrip(
	second: Directory,
	content: string,
	attachment: Uint8Array,
) {
	const saved = await new File(second, "note.md").text();
	const binary = await new File(second, "attachments", "bytes.bin").bytes();
	const binaryPreserved =
		binary.length === attachment.length &&
		binary.every((byte, index) => byte === attachment[index]);
	const deletionPreserved = !new File(second, "deleted.md").exists;
	return {
		binaryPreserved,
		deletionPreserved,
		contentPreserved: saved === content,
	};
}

function publishProof(endpoint: string, proof: Record<string, unknown>) {
	console.info("TOLARIA_NATIVE_GIT_PROOF", JSON.stringify(proof));
	setNativeQaSinkUrl(new URL("/proof", endpoint).toString());
	postNativeQaEvent(proof);
}
