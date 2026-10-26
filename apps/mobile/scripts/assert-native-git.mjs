/* global console, process, setTimeout, clearTimeout */

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNativeSimulatorLease } from "../src/qa/nativeSimulatorLease.ts";
import { resolveNativeSimulatorId } from "../src/qa/nativeSimulatorTarget.ts";
import {
	gitTestEnvironment,
	startGitTestServer,
} from "../src/workspace/git/gitTestServer.ts";

const gitOptions = { env: gitTestEnvironment(), stdio: "pipe" };
const standalone = process.argv.includes("--standalone");
const bundleId =
	process.env.TOLARIA_QA_BUNDLE_ID ??
	(standalone ? "com.tolaria.mobile.dev" : "host.exp.Exponent");
const fileCount = Number(process.env.TOLARIA_GIT_QA_FILES ?? 2);
const historyMiB = Number(process.env.TOLARIA_GIT_QA_HISTORY_MIB ?? 0);
if (!Number.isInteger(fileCount) || fileCount < 2 || fileCount > 10_000) {
	throw new Error("TOLARIA_GIT_QA_FILES must be an integer from 2 to 10000");
}
if (!Number.isInteger(historyMiB) || historyMiB < 0 || historyMiB > 256) {
	throw new Error(
		"TOLARIA_GIT_QA_HISTORY_MIB must be an integer from 0 to 256",
	);
}
const probeTimeoutMs = fileCount > 2 || historyMiB > 0 ? 600_000 : 150_000;
const deviceArgumentIndex = process.argv.indexOf("--device");
const requestedDevice =
	deviceArgumentIndex < 0 ? undefined : process.argv[deviceArgumentIndex + 1];
if (deviceArgumentIndex >= 0) {
	if (!requestedDevice) {
		throw new Error("Usage: --device <booted simulator UDID>");
	}
}
if (requestedDevice?.startsWith("--")) {
	throw new Error("Usage: --device <booted simulator UDID>");
}

function runGit(args) {
	return execFileSync("git", args, gitOptions);
}

async function createFixture(root) {
	const remote = join(root, "team", "vault.git");
	const seed = join(root, "seed");
	await mkdir(remote, { recursive: true });
	await mkdir(seed);
	runGit(["init", "--bare", "--initial-branch=main", remote]);
	runGit(["init", "--initial-branch=main", seed]);
	await writeFile(
		join(seed, "note.md"),
		"---\ncustom: original\n---\n# Initial\n",
	);
	await writeFile(
		join(seed, "deleted.md"),
		"# Remove me in the first working copy\n",
	);
	await createLargeFixture(seed);
	runGit(["-C", seed, "add", "."]);
	runGit([
		"-C",
		seed,
		"-c",
		"user.name=Native QA",
		"-c",
		"user.email=qa@example.invalid",
		"commit",
		"-m",
		"Fixture",
	]);
	await createHistoryFixture(seed);
	runGit(["-C", seed, "push", remote, "main"]);
	return runGit(["-C", remote, "count-objects", "-v"]).toString().trim();
}

async function createHistoryFixture(seed) {
	if (!historyMiB) return;
	const attachment = join(seed, "historical-attachment.bin");
	const commit = [
		"-C",
		seed,
		"-c",
		"user.name=Native QA",
		"-c",
		"user.email=qa@example.invalid",
		"commit",
		"-m",
	];
	// Incompressible revisions stay reachable through history, but not the current vault tree.
	for (let written = 0; written < historyMiB; written += 4) {
		await writeFile(
			attachment,
			randomBytes(Math.min(4, historyMiB - written) * 1024 * 1024),
		);
		runGit(["-C", seed, "add", "historical-attachment.bin"]);
		runGit([...commit, `Historical attachment ${written}`]);
	}
	runGit(["-C", seed, "rm", "historical-attachment.bin"]);
	runGit([...commit, "Remove historical attachment"]);
}

async function createLargeFixture(seed) {
	for (let index = 2; index < fileCount; index += 1) {
		const folder = join(seed, `folder-${index % 20}`);
		await mkdir(folder, { recursive: true });
		const lines = Array.from({ length: 64 }, (_, line) =>
			createHash("sha256").update(`fixture-${index}-${line}`).digest("hex"),
		);
		await writeFile(
			join(folder, `note-${index}.md`),
			`---\ntype: Note\n---\n# Note ${index}\n\n${lines.join("\n")}\n`,
		);
	}
}

async function readProof(request, response, resolve, reject) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	response.end("ok");
	try {
		resolve(JSON.parse(Buffer.concat(chunks).toString()));
	} catch (error) {
		reject(error);
	}
}

function bootedDevices() {
	const result = JSON.parse(
		execFileSync("xcrun", ["simctl", "list", "devices", "booted", "--json"], {
			encoding: "utf8",
		}),
	);
	return Object.values(result.devices).flat();
}

async function runProbe(deviceId) {
	const root = await mkdtemp(join(tmpdir(), "tolaria-native-git-"));
	let server;
	let timeout;
	try {
		const remoteObjects = await createFixture(root);
		let resolveProof;
		let rejectProof;
		const proof = new Promise((resolve, reject) => {
			resolveProof = resolve;
			rejectProof = reject;
			timeout = setTimeout(
				() => reject(new Error("Native Git proof timed out")),
				probeTimeoutMs,
			);
		});
		server = await startGitTestServer(root, (request, response) => {
			if (request.url !== "/proof") return false;
			void readProof(request, response, resolveProof, rejectProof).catch(
				rejectProof,
			);
			return true;
		});
		const scheme = standalone ? "tolaria:///" : "exp://127.0.0.1:8081/--/";
		const url = `${scheme}?source=fixture&gitProbe=${encodeURIComponent(server.url)}&qaRun=native-git`;
		try {
			execFileSync("xcrun", ["simctl", "terminate", deviceId, bundleId], {
				stdio: "pipe",
			});
		} catch {
			/* Expo may not be running. */
		}
		const launch = standalone
			? [
					"launch",
					deviceId,
					bundleId,
					"--tolaria-mobile-search",
					new URL(url).search,
				]
			: ["openurl", deviceId, url];
		execFileSync("xcrun", ["simctl", ...launch]);
		const result = await proof;
		console.log(
			JSON.stringify(
				{ fileCount, historyMiB, remoteObjects, ...result },
				null,
				2,
			),
		);
		if (!result.passed) process.exitCode = 1;
		if (standalone && !result.nativeFiles) process.exitCode = 1;
	} finally {
		clearTimeout(timeout);
		await server?.close();
		await rm(root, { recursive: true, force: true });
	}
}

const simulatorId = resolveNativeSimulatorId(
	requestedDevice,
	bootedDevices(),
	fileCount > 2 || historyMiB > 0,
);
await withNativeSimulatorLease(() => runProbe(simulatorId));
