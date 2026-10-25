import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	request,
} from "@playwright/test";
import { GRANTEE, OWNER, ShareFront, USER_COOKIE } from "./shareFront";

/**
 * Where convergence.spec.ts runs (TOL-239), behind one interface:
 *
 * - local (the default, part of the web suite): the run's own Tolaria server behind the
 *   share front of shareFront.ts, with its two fixed users;
 * - a deployment (`TOLARIA_CONVERGENCE_BASE_URL`, e.g. staging): two real beta accounts,
 *   each signed in by its session, through Cloudflare Access with a service token. Every
 *   credential comes from the environment, and the Access headers only go to that origin.
 */

export type Role = "owner" | "editor";

export interface Target {
	/** "local", or the deployment's base URL. */
	readonly name: string;
	/** How long a first open may take: a deployment's container can be cold. */
	readonly openMs: number;
	/** An API client of this user on the target's origin. */
	api(role: Role): Promise<APIRequestContext>;
	/** Who the owner shares with, as in the Share dialog: an email, or `@` and a GitHub login. */
	readonly editorInvitee: string;
	/** A browser window of this user, on the target's origin. */
	window(
		browser: Browser,
		role: Role,
		device: Parameters<Browser["newContext"]>[0],
	): Promise<BrowserContext>;
	stop(): Promise<void>;
}

const ONBOARDING_DISMISSED = "tolaria:claude-code-onboarding-dismissed";

interface LocalOptions {
	previewUrl: string;
	remoteUrl: string;
	token: string;
}

/** The browser never holds the server token for a shared vault: the front mints tickets. */
const PLACEHOLDER_TOKEN = "via-share-front";

/** The API clients a target opened, disposed of together when it stops. */
class ApiClients {
	private readonly opened: APIRequestContext[] = [];

	async open(
		baseURL: string,
		headers: Record<string, string>,
	): Promise<APIRequestContext> {
		const client = await request.newContext({
			baseURL,
			extraHTTPHeaders: headers,
		});
		this.opened.push(client);
		return client;
	}

	async dispose(): Promise<void> {
		for (const client of this.opened) await client.dispose();
	}
}

class LocalTarget implements Target {
	readonly name = "local";
	readonly openMs = 15_000;
	readonly editorInvitee = GRANTEE.email;
	private readonly clients = new ApiClients();

	constructor(
		private readonly front: ShareFront,
		private readonly token: string,
	) {}

	private userOf(role: Role) {
		return role === "owner" ? OWNER : GRANTEE;
	}

	api(role: Role): Promise<APIRequestContext> {
		return this.clients.open(this.front.origin, {
			cookie: `${USER_COOKIE}=${this.userOf(role).userId}`,
		});
	}

	async window(
		browser: Browser,
		role: Role,
		device: Parameters<Browser["newContext"]>[0],
	): Promise<BrowserContext> {
		const context = await browser.newContext({
			...device,
			baseURL: this.front.origin,
		});
		const url = new URL(this.front.origin);
		await context.addCookies([
			{
				name: USER_COOKIE,
				value: this.userOf(role).userId,
				domain: url.hostname,
				path: "/",
			},
		]);
		const credential = role === "owner" ? this.token : PLACEHOLDER_TOKEN;
		await context.addInitScript(
			([key, token]) => {
				window.localStorage.setItem(key, "1");
				window.TOLARIA_REMOTE_URL = window.location.origin;
				window.TOLARIA_REMOTE_TOKEN = token;
			},
			[ONBOARDING_DISMISSED, credential],
		);
		return context;
	}

	async stop(): Promise<void> {
		await this.clients.dispose();
		await this.front.stop();
	}
}

export async function localTarget(options: LocalOptions): Promise<Target> {
	const front = new ShareFront(options);
	await front.start();
	return new LocalTarget(front, options.token);
}

/** The settings of a run against a deployment, all from the environment. */
export interface DeployedSettings {
	baseUrl: string;
	ownerSession: string;
	editorSession: string;
	editorInvitee: string;
	access: Record<string, string>;
}

const REQUIRED = {
	ownerSession: "TOLARIA_CONVERGENCE_OWNER_SESSION",
	editorSession: "TOLARIA_CONVERGENCE_EDITOR_SESSION",
	editorInvitee: "TOLARIA_CONVERGENCE_EDITOR",
} as const;

/** The variables a deployed run needs, by setting. */
function required(env: NodeJS.ProcessEnv, baseUrl: string) {
	const values = Object.entries(REQUIRED).map(([key, name]) => [
		key,
		env[name],
	]);
	const missing = Object.values(REQUIRED).filter((name) => !env[name]);
	if (missing.length > 0)
		throw new Error(`a run against ${baseUrl} needs ${missing.join(", ")}`);
	return Object.fromEntries(values) as Record<keyof typeof REQUIRED, string>;
}

/** The Access service token's headers, when both halves are set. */
function accessHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
	const id = env.TOLARIA_CONVERGENCE_ACCESS_CLIENT_ID;
	const secret = env.TOLARIA_CONVERGENCE_ACCESS_CLIENT_SECRET;
	if (!id || !secret) return {};
	return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** Null for a local run; throws naming every missing variable (never a value). */
export function deployedSettings(
	env: NodeJS.ProcessEnv = process.env,
): DeployedSettings | null {
	const baseUrl = env.TOLARIA_CONVERGENCE_BASE_URL;
	if (!baseUrl) return null;
	return { baseUrl, ...required(env, baseUrl), access: accessHeaders(env) };
}

const SESSION_COOKIE = "session";

class DeployedTarget implements Target {
	readonly openMs = 480_000;
	private readonly origin: string;
	private readonly clients = new ApiClients();

	constructor(private readonly settings: DeployedSettings) {
		this.origin = new URL(settings.baseUrl).origin;
	}

	get name(): string {
		return this.origin;
	}

	get editorInvitee(): string {
		return this.settings.editorInvitee;
	}

	private sessionOf(role: Role): string {
		return role === "owner"
			? this.settings.ownerSession
			: this.settings.editorSession;
	}

	api(role: Role): Promise<APIRequestContext> {
		return this.clients.open(this.origin, {
			...this.settings.access,
			cookie: `${SESSION_COOKIE}=${this.sessionOf(role)}`,
		});
	}

	async window(
		browser: Browser,
		role: Role,
		device: Parameters<Browser["newContext"]>[0],
	): Promise<BrowserContext> {
		const context = await browser.newContext({
			...device,
			baseURL: this.origin,
		});
		const { hostname, protocol } = new URL(this.origin);
		const secure = protocol === "https:";
		await context.addCookies([
			{
				name: SESSION_COOKIE,
				value: this.sessionOf(role),
				domain: hostname,
				path: "/",
				secure,
				httpOnly: true,
				sameSite: "Lax",
			},
		]);
		// Access answers the first request with its own cookie, which the websockets then carry.
		await context.route("**/*", (route) => {
			const sent = route.request();
			if (new URL(sent.url()).origin !== this.origin) return route.continue();
			return route.continue({
				headers: { ...sent.headers(), ...this.settings.access },
			});
		});
		await context.addInitScript(
			(key) => window.localStorage.setItem(key, "1"),
			ONBOARDING_DISMISSED,
		);
		return context;
	}

	stop(): Promise<void> {
		return this.clients.dispose();
	}
}

export function deployedTarget(settings: DeployedSettings): Target {
	return new DeployedTarget(settings);
}

export interface SharedNote {
	path: string;
	title: string;
	shareId: string;
	/** Where the editor opens the owner's vault, e.g. `/vaults/<id>`. */
	editorBase: string;
}

const encodePath = (path: string) =>
	path.split("/").map(encodeURIComponent).join("/");

/** Answers until the vault is up: a cold container answers 5xx while it starts. */
async function untilUp(
	send: () => ReturnType<APIRequestContext["get"]>,
	timeoutMs: number,
) {
	const started = Date.now();
	for (;;) {
		const response = await send();
		if (response.status() < 500 || Date.now() - started > timeoutMs)
			return response;
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}

async function createNote(
	target: Target,
	owner: APIRequestContext,
	note: NewNote,
): Promise<void> {
	const created = await untilUp(
		() =>
			owner.put(`/v1/files/${encodePath(note.path)}`, {
				headers: { "if-none-match": "*" },
				data: note.body,
				timeout: 200_000,
			}),
		target.openMs,
	);
	expect(created.status(), `creating ${note.path}`).toBe(201);
}

/** How long the server may take to write the last live edits into the file. */
const WRITTEN_MS = 60_000;

/**
 * Until the note's file holds every edit typed into it. The server writes a live document
 * back when the note is deleted with edits it has not written yet, which would restore it.
 */
async function untilWritten(
	owner: APIRequestContext,
	path: string,
	typed: string[],
): Promise<void> {
	await expect
		.poll(
			async () => {
				const body = await (
					await owner.get(`/v1/files/${encodePath(path)}`)
				).text();
				return typed.filter((marker) => !body.includes(marker)).length;
			},
			{
				timeout: WRITTEN_MS,
				message: `${path} holds every edit typed into it`,
			},
		)
		.toBe(0);
}

async function deleteNote(
	owner: APIRequestContext,
	path: string,
): Promise<void> {
	const read = await owner.get(`/v1/files/${encodePath(path)}`);
	expect(read.status(), `reading ${path} to delete it`).toBe(200);
	const deleted = await owner.delete(`/v1/files/${encodePath(path)}`, {
		headers: { "if-match": read.headers().etag ?? "" },
	});
	expect(deleted.status(), `deleting ${path}`).toBe(200);
	// Nothing written back after the delete: the note stays gone.
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	const after = await owner.get(`/v1/files/${encodePath(path)}`);
	expect(after.status(), `${path} after its deletion`).toBe(404);
}

/** Shares the note with the editor, as the Share dialog does; the share's id. */
async function shareWithEditor(
	target: Target,
	owner: APIRequestContext,
	path: string,
): Promise<string> {
	const invitee = target.editorInvitee.startsWith("@")
		? { github: target.editorInvitee.slice(1) }
		: { email: target.editorInvitee };
	const shared = await owner.post("/api/shares", {
		data: { ...invitee, role: "editor", path },
	});
	expect(shared.status(), "sharing the note with the editor").toBe(201);
	return ((await shared.json()) as { share: { id: string } }).share.id;
}

/** Where the share is served, from the editor's "Shared with me". */
async function editorBaseOf(target: Target, shareId: string): Promise<string> {
	const editor = await target.api("editor");
	const incoming = await editor.get("/api/shares/incoming");
	expect(incoming.status(), "the editor's Shared with me").toBe(200);
	const { shares } = (await incoming.json()) as {
		shares: Array<{ id: string; base: string }>;
	};
	const base = shares.find((candidate) => candidate.id === shareId)?.base;
	expect(base, "the share in the editor's Shared with me").toBeTruthy();
	return base ?? "";
}

async function revokeShare(
	owner: APIRequestContext,
	shareId: string,
): Promise<void> {
	const revoked = await owner.delete(`/api/shares/${shareId}`);
	expect(revoked.status(), "revoking the share").toBe(200);
}

export interface NewNote {
	path: string;
	body: string;
	title: string;
}

/**
 * The owner creates the note and shares it with the editor. If that fails half way, what
 * was made is removed again before the error goes on.
 */
export async function createSharedNote(
	target: Target,
	note: NewNote,
): Promise<SharedNote> {
	const owner = await target.api("owner");
	await createNote(target, owner, note);
	let shareId: string | undefined;
	try {
		shareId = await shareWithEditor(target, owner, note.path);
		const editorBase = await editorBaseOf(target, shareId);
		return { path: note.path, title: note.title, shareId, editorBase };
	} catch (error) {
		if (shareId) await revokeShare(owner, shareId);
		await deleteNote(owner, note.path);
		throw error;
	}
}

/**
 * Revokes the share and deletes the note once the server has written every marker `typed`
 * into it, so a run leaves the vault as it found it.
 */
export async function removeSharedNote(
	target: Target,
	note: SharedNote,
	typed: string[],
): Promise<void> {
	const owner = await target.api("owner");
	await revokeShare(owner, note.shareId);
	await untilWritten(owner, note.path, typed);
	await deleteNote(owner, note.path);
}
