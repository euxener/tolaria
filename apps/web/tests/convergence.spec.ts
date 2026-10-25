import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	devices,
	expect,
	type Page,
	type TestInfo,
	test,
	webkit,
} from "@playwright/test";
import {
	type ConvergenceSample,
	type ConvergenceSummary,
	formatConvergenceReport,
	MIN_SAMPLES,
	summarizeConvergence,
} from "../convergenceReport";
import {
	createSharedNote,
	deployedSettings,
	deployedTarget,
	localTarget,
	removeSharedNote,
	type SharedNote,
	type Target,
} from "./convergenceTargets";

/**
 * TOL-239: the owner of a vault and the editor they shared a note with type into that note
 * at the same time, the owner on a desktop browser (Chromium) and the editor on an iPhone
 * (WebKit). Each sample types a unique marker in one window and times how long it takes to
 * show in the other, both ways; the run fails unless p95 is under a second
 * (convergenceReport.ts) and writes its summary as convergence.md and convergence.json.
 *
 * Both windows open the note in the shell itself (`/?note=` and the shared vault's
 * `/vaults/<id>/?note=`), not the S4 collab.html page: since TOL-190 the shell's note view is
 * the note's live Yjs document over the collab websocket, the surface beta users edit in.
 *
 * By default it runs in the web suite against the run's own server and share front. With
 * TOLARIA_CONVERGENCE_BASE_URL it runs against that deployment (the scheduled staging run of
 * tolaria-cloud); convergenceTargets.ts lists what it then reads from the environment.
 */

const SAMPLES_PER_DIRECTION = Math.max(
	MIN_SAMPLES / 2,
	Number(process.env.TOLARIA_CONVERGENCE_SAMPLES_PER_DIRECTION ?? MIN_SAMPLES),
);
/** An edit that has not arrived after this never will: the run records it as lost. */
const SAMPLE_TIMEOUT_MS = 10_000;
const MAX_LOST = 3;
const OWNER_LINE = "Typed on the desktop:";
const EDITOR_LINE = "Typed on the phone:";

test.describe.configure({ retries: 0 });

interface Seat {
	label: string;
	page: Page;
	/** The text of the paragraph this seat types in. */
	line: string;
	/** Every marker typed in the run, by either seat: what the note's file must end up holding. */
	typed: string[];
}

/**
 * Notes when each watched marker first shows in this page's editor, by the page's own clock.
 * Both browsers run on one machine, so the two pages' `Date.now()` can be compared directly.
 */
function installWatcher(page: Page): Promise<void> {
	return page.evaluate(() => {
		const state = {
			pending: new Set<string>(),
			seen: {} as Record<string, number>,
		};
		const check = () => {
			if (state.pending.size === 0) return;
			const text = document.querySelector(".bn-editor")?.textContent ?? "";
			for (const marker of state.pending) {
				if (!text.includes(marker)) continue;
				state.seen[marker] = Date.now();
				state.pending.delete(marker);
			}
		};
		new MutationObserver(check).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
		});
		Object.assign(window, {
			__convergence: {
				seen: state.seen,
				watch: (marker: string) => {
					state.pending.add(marker);
					check();
				},
			},
		});
	});
}

interface Watcher {
	seen: Record<string, number>;
	watch(marker: string): void;
}

function watch(page: Page, marker: string): Promise<void> {
	return page.evaluate(
		(text) =>
			(window as unknown as { __convergence: Watcher }).__convergence.watch(
				text,
			),
		marker,
	);
}

/** When the marker showed in this page, or null if it did not within `timeoutMs`. */
async function seenAt(
	page: Page,
	marker: string,
	timeoutMs: number,
): Promise<number | null> {
	try {
		const handle = await page.waitForFunction(
			(text) =>
				(window as unknown as { __convergence: Watcher }).__convergence.seen[
					text
				],
			marker,
			{ timeout: timeoutMs },
		);
		return (await handle.jsonValue()) as number;
	} catch {
		return null;
	}
}

/**
 * Puts the caret at the end of the seat's paragraph through the DOM selection, as
 * collab.spec.ts does, so a click never lands on the other seat's caret label.
 */
async function caretToEnd({ page, line }: Seat): Promise<void> {
	const block = page
		.locator(".bn-editor .bn-inline-content", { hasText: line })
		.first();
	await block.evaluate((element) => {
		(element.closest('[contenteditable="true"]') as HTMLElement).focus();
		const range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		const selection = window.getSelection() as Selection;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		return new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

/** One sample: `from` types a marker; the time until `to` shows it, from when `from` did. */
async function sample(
	from: Seat,
	to: Seat,
	marker: string,
	timeoutMs: number,
): Promise<number | null> {
	await watch(from.page, marker);
	await watch(to.page, marker);
	await caretToEnd(from);
	from.typed.push(marker);
	await from.page.keyboard.type(` ${marker}`);
	const typed = await seenAt(from.page, marker, timeoutMs);
	const arrived = await seenAt(to.page, marker, timeoutMs);
	return typed === null || arrived === null
		? null
		: Math.max(0, arrived - typed);
}

function markerOf(direction: string, index: number): string {
	return `cv${direction}${index}x${randomUUID().slice(0, 5)}`;
}

async function measure(
	owner: Seat,
	editor: Seat,
): Promise<ConvergenceSample[]> {
	const pairs = [
		{ from: owner, to: editor, direction: "owner → editor", tag: "o" },
		{ from: editor, to: owner, direction: "editor → owner", tag: "e" },
	];
	// Warm-up, not counted: both windows are connected once an edit makes the round trip.
	for (const { from, to, tag } of pairs) {
		expect(
			await sample(from, to, markerOf(`w${tag}`, 0), 60_000),
			`warm-up ${from.label} → ${to.label}`,
		).not.toBeNull();
	}
	const samples: ConvergenceSample[] = [];
	for (let index = 0; index < SAMPLES_PER_DIRECTION; index++) {
		for (const { from, to, direction, tag } of pairs) {
			const latencyMs = await sample(
				from,
				to,
				markerOf(tag, index),
				SAMPLE_TIMEOUT_MS,
			);
			samples.push({ direction, index, latencyMs });
			// Typing sessions, not a burst: the next edit starts after a short pause.
			await from.page.waitForTimeout(150);
		}
		if (samples.filter((one) => one.latencyMs === null).length >= MAX_LOST)
			break;
	}
	return samples;
}

function outDir(testInfo: TestInfo): string {
	const dir =
		process.env.TOLARIA_CONVERGENCE_OUT_DIR ??
		testInfo.outputPath("convergence");
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function publish(
	summary: ConvergenceSummary,
	testInfo: TestInfo,
): Promise<void> {
	const report = formatConvergenceReport(summary);
	const dir = outDir(testInfo);
	writeFileSync(join(dir, "convergence.md"), report);
	writeFileSync(
		join(dir, "convergence.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	await testInfo.attach("convergence.md", {
		body: report,
		contentType: "text/markdown",
	});
	console.log(report);
}

async function openNote(
	seat: Seat,
	url: string,
	note: SharedNote,
	openMs: number,
): Promise<void> {
	await seat.page.goto(url, { waitUntil: "load", timeout: openMs });
	await expect(seat.page.locator(".bn-editor h1").first()).toContainText(
		note.title,
		{ timeout: openMs },
	);
	await expect(
		seat.page
			.locator(".bn-editor .bn-inline-content", { hasText: seat.line })
			.first(),
	).toBeVisible({
		timeout: openMs,
	});
	await installWatcher(seat.page);
}

function newNote() {
	const slug = `${new Date()
		.toISOString()
		.replace(/[^0-9]/gu, "")
		.slice(0, 14)}-${randomUUID().slice(0, 6)}`;
	const title = `Convergence ${slug}`;
	return {
		path: `convergence/${slug}.md`,
		title,
		body: `---\ntype: Note\n---\n# ${title}\n\n${OWNER_LINE}\n\n${EDITOR_LINE}\n`,
	};
}

async function targetOf(baseURL: string | undefined): Promise<Target> {
	const deployed = deployedSettings();
	if (deployed) return deployedTarget(deployed);
	// Only a local run reads the web suite's config: its servers are the target.
	const { COLLAB_TOKEN, REMOTE_URL } = await import("../playwright.config");
	return localTarget({
		previewUrl: baseURL ?? "",
		remoteUrl: REMOTE_URL,
		token: COLLAB_TOKEN,
	});
}

const browsers: Browser[] = [];

test.beforeAll(async () => {
	browsers.push(await chromium.launch(), await webkit.launch());
});

test.afterAll(async () => {
	for (const browser of browsers) await browser.close();
});

/** The owner's desktop window and the editor's phone window, both of the same run. */
async function seatsOf(target: Target, typed: string[]) {
	const [desktopBrowser, phoneBrowser] = browsers as [Browser, Browser];
	const windows = [
		await target.window(desktopBrowser, "owner", devices["Desktop Chrome"]),
		await target.window(phoneBrowser, "editor", devices["iPhone 15"]),
	];
	const [ownerWindow, editorWindow] = windows as [
		BrowserContext,
		BrowserContext,
	];
	const owner: Seat = {
		label: "owner (desktop)",
		page: await ownerWindow.newPage(),
		line: OWNER_LINE,
		typed,
	};
	const editor: Seat = {
		label: "editor (iPhone)",
		page: await editorWindow.newPage(),
		line: EDITOR_LINE,
		typed,
	};
	return { owner, editor, windows };
}

async function converge(
	target: Target,
	testInfo: TestInfo,
): Promise<ConvergenceSummary> {
	const startedAt = new Date().toISOString();
	const note = await createSharedNote(target, newNote());
	const typed: string[] = [];
	try {
		const { owner, editor, windows } = await seatsOf(target, typed);
		const query = `?note=${encodeURIComponent(note.path)}`;
		await openNote(owner, `/${query}`, note, target.openMs);
		await openNote(editor, `${note.editorBase}/${query}`, note, target.openMs);

		const summary = summarizeConvergence(await measure(owner, editor), {
			target: target.name,
			startedAt,
		});
		await publish(summary, testInfo);
		for (const seat of [owner, editor]) {
			await testInfo.attach(`${seat.label}.png`, {
				body: await seat.page.screenshot(),
				contentType: "image/png",
			});
		}
		for (const window of windows) await window.close();
		return summary;
	} finally {
		await removeSharedNote(target, note, typed);
	}
}

test("an owner on a desktop and an editor on a phone converge on a shared note within a second at p95", async ({
	baseURL,
}, testInfo) => {
	const target = await targetOf(baseURL);
	test.setTimeout(target.openMs * 3 + 180_000);
	try {
		const summary = await converge(target, testInfo);
		expect(summary.ok, summary.failures.join("; ")).toBe(true);
	} finally {
		await target.stop();
	}
});
