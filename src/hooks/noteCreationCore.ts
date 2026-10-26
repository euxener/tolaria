import { invoke } from "@tauri-apps/api/core";
import type { VaultOption } from "../components/status-bar/types";
import {
	createRemoteNote,
	hasRemoteVault,
	newNotePath,
} from "../lib/remoteNotes";
import { createVaultBackend } from "../lib/vaultBackend";
import { addMockEntry, isTauri, mockInvoke } from "../mock-tauri";
import type { VaultEntry } from "../types";
import {
	NOTE_FORMAT_FRONTMATTER_KEY,
	NOTE_FORMAT_SHEET,
	NOTE_FORMAT_TEXT,
	type NoteFormat,
} from "../utils/noteFormat";
import {
	findByCollidingNotePath,
	notePathFilename,
} from "../utils/notePathIdentity";
import { slugifyNoteStem as slugify } from "../utils/noteSlug";
import { canonicalFrontmatterKey } from "../utils/systemMetadata";
import { canonicalizeTypeName } from "../utils/vaultTypes";
import type { WikilinkCreationDestination } from "../utils/wikilinkCreation";

export function addEntryWithMock(
	entry: VaultEntry,
	content: string,
	addEntry: (entry: VaultEntry) => void,
) {
	if (!isTauri()) addMockEntry(entry, content);
	addEntry(entry);
}

export * from "./noteCreationBase";

import {
	buildNewEntry,
	resolveCreationVaultPath,
	workspaceForVaultPath,
} from "./noteCreationBase";

export * from "./noteCreationDefaults";

import type {
	DefaultValue,
	NoteContentParams,
	TypeInstanceDefault,
} from "./noteCreationDefaults";
import { buildNoteBody, isStatusKey } from "./noteCreationDefaults";

function hasOuterWhitespace(value: string): boolean {
	return value.trim() !== value;
}

function isYamlWikilink(value: string): boolean {
	return value.startsWith("[[") && value.endsWith("]]");
}

function isAmbiguousYamlScalar(value: string): boolean {
	const lowerValue = value.toLowerCase();
	return (
		lowerValue === "true" ||
		lowerValue === "false" ||
		lowerValue === "null" ||
		isDecimalYamlScalar({ value })
	);
}

function isDecimalYamlScalar({ value }: { value: string }): boolean {
	const unsignedValue =
		value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value;
	const decimalParts = unsignedValue.split(".");
	return (
		decimalParts.length <= 2 &&
		decimalParts.every(
			(part) =>
				part.length > 0 &&
				Array.from(part).every((char) => char >= "0" && char <= "9"),
		)
	);
}

function shouldQuoteYamlString(value: string): boolean {
	return [
		hasOuterWhitespace,
		isYamlWikilink,
		isAmbiguousYamlScalar,
		(candidate: string) => candidate.includes(":"),
	].some((check) => check(value));
}

function formatYamlScalar(value: string | number | boolean): string {
	if (typeof value !== "string") return String(value);
	if (shouldQuoteYamlString(value)) return JSON.stringify(value);
	return value;
}

function appendDefaultFrontmatterLines(
	lines: string[],
	defaults: TypeInstanceDefault[],
) {
	const existingKeys = new Set(
		lines.map((line) => canonicalFrontmatterKey(line.split(":", 1)[0])),
	);

	for (const { key, value } of defaults) {
		const canonicalKey = canonicalFrontmatterKey(key);
		if (existingKeys.has(canonicalKey)) continue;
		existingKeys.add(canonicalKey);
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${formatYamlScalar(item)}`);
			}
		} else {
			lines.push(`${key}: ${formatYamlScalar(value)}`);
		}
	}
}

export function buildNoteContent({
	title,
	type,
	status,
	format = NOTE_FORMAT_TEXT,
	template,
	initialEmptyHeading = false,
	defaults = [],
}: NoteContentParams): string {
	const lines = ["---"];
	if (title) lines.push(`title: ${title}`);
	lines.push(`type: ${type}`);
	if (format === NOTE_FORMAT_SHEET)
		lines.push(`${NOTE_FORMAT_FRONTMATTER_KEY}: sheet`);
	if (status) lines.push(`status: ${status}`);
	appendDefaultFrontmatterLines(lines, defaults);
	lines.push("---");
	const body = buildNoteBody({ format, template, initialEmptyHeading });
	return `${lines.join("\n")}\n${body}`;
}

export interface NewNoteParams {
	destination?: WikilinkCreationDestination;
	title: string;
	type: string;
	format?: NoteFormat;
	vaultPath: string;
	defaultWorkspacePath?: string | null;
	vaults?: readonly VaultOption[];
	template?: string | null;
	defaults?: TypeInstanceDefault[];
}

export function resolveNewNote(options: NewNoteParams): {
	entry: VaultEntry;
	content: string;
} {
	const {
		destination,
		title,
		type,
		format,
		vaultPath,
		defaultWorkspacePath,
		vaults = [],
		template,
		defaults = [],
	} = options;
	const creationVaultPath =
		destination?.vaultPath ??
		resolveCreationVaultPath(vaultPath, defaultWorkspacePath, vaults);
	const slug = slugify(title);
	const relativePath = destination?.relativePath ?? `${slug}.md`;
	const status = null;
	const entry = {
		...buildNewEntry({
			path: newNotePath(creationVaultPath, relativePath),
			slug,
			title,
			type,
			status,
		}),
		workspace: workspaceForVaultPath(
			creationVaultPath,
			vaults,
			defaultWorkspacePath,
		),
	};
	return applyTypeDefaults({
		entry,
		content: buildNoteContent({
			title,
			type,
			status,
			format,
			template,
			defaults,
		}),
		defaults,
	});
}

export interface NewTypeParams {
	typeName: string;
	vaultPath: string;
	defaultWorkspacePath?: string | null;
	vaults?: readonly VaultOption[];
}

const TYPE_CREATION_ALIASES = new Map<string, string>([["notes", "Note"]]);

export function normalizeTypeCreationName(typeName: string): string {
	const trimmed = typeName.trim();
	return (
		TYPE_CREATION_ALIASES.get(trimmed.toLowerCase()) ??
		canonicalizeTypeName(trimmed) ??
		trimmed
	);
}

export function resolveNewType({
	typeName,
	vaultPath,
	defaultWorkspacePath,
	vaults = [],
}: NewTypeParams): {
	entry: VaultEntry;
	content: string;
} {
	const normalizedTypeName = normalizeTypeCreationName(typeName);
	const creationVaultPath = resolveCreationVaultPath(
		vaultPath,
		defaultWorkspacePath,
		vaults,
	);
	const slug = slugify(normalizedTypeName);
	const entry = {
		...buildNewEntry({
			path: newNotePath(creationVaultPath, `${slug}.md`),
			slug,
			title: normalizedTypeName,
			type: "Type",
			status: null,
		}),
		workspace: workspaceForVaultPath(
			creationVaultPath,
			vaults,
			defaultWorkspacePath,
		),
	};
	return {
		entry,
		content: `---\ntype: Type\n---\n\n# ${normalizedTypeName}\n`,
	};
}

export type ResolvedEntry = { entry: VaultEntry; content: string };

function relationshipRefs(value: DefaultValue): string[] {
	return Array.isArray(value) ? value.map(String) : [String(value)];
}

export function applyTypeDefaults({
	entry,
	content,
	defaults,
}: {
	entry: VaultEntry;
	content: string;
	defaults: TypeInstanceDefault[];
}): ResolvedEntry {
	if (defaults.length === 0) return { entry, content };

	const relationships = { ...entry.relationships };
	const properties = { ...entry.properties };
	let status = entry.status;
	for (const defaultValue of defaults) {
		if (defaultValue.kind === "relationship") {
			relationships[defaultValue.key] = relationshipRefs(defaultValue.value);
			continue;
		}
		if (isStatusKey(defaultValue.key)) {
			status = String(defaultValue.value);
			continue;
		}
		properties[defaultValue.key] = defaultValue.value as
			| string
			| number
			| boolean;
	}

	return {
		entry: { ...entry, relationships, properties, status },
		content,
	};
}

interface BlockedCreationPlan {
	status: "blocked";
	message: string;
}

interface ReadyCreationPlan {
	status: "create";
	resolved: ResolvedEntry;
}

interface ExistingTypeCreationPlan {
	status: "existing";
	entry: VaultEntry;
}

export type NoteCreationPlan = BlockedCreationPlan | ReadyCreationPlan;
export type TypeCreationPlan =
	| BlockedCreationPlan
	| ExistingTypeCreationPlan
	| ReadyCreationPlan;

function findPathCollision(
	entries: VaultEntry[],
	path: string,
): VaultEntry | undefined {
	return findByCollidingNotePath(entries, path);
}

function buildCreationCollisionMessage({
	noun,
	title,
	path,
}: {
	noun: "note" | "type";
	title: string;
	path: string;
}): string {
	const filename = notePathFilename(path);
	return `Cannot create ${noun} "${title}" because ${filename} already exists`;
}

function findEquivalentTypeEntry(
	entries: VaultEntry[],
	typeName: string,
): VaultEntry | undefined {
	const trimmed = normalizeTypeCreationName(typeName);
	const targetSlug = slugify(trimmed);
	return entries.find(
		(entry) =>
			entry.isA === "Type" &&
			(entry.title === trimmed || slugify(entry.title) === targetSlug),
	);
}

export function planNewNoteCreation(
	options: NewNoteParams & { entries: VaultEntry[] },
): NoteCreationPlan {
	const {
		defaultWorkspacePath,
		destination,
		entries,
		title,
		type,
		vaultPath,
		vaults,
		template,
		defaults,
	} = options;
	const resolved = resolveNewNote({
		destination,
		title,
		type,
		vaultPath,
		defaultWorkspacePath,
		vaults,
		template,
		defaults,
	});
	const collision = findPathCollision(entries, resolved.entry.path);
	if (collision) {
		return {
			status: "blocked",
			message: buildCreationCollisionMessage({
				noun: "note",
				title,
				path: resolved.entry.path,
			}),
		};
	}
	return { status: "create", resolved };
}

export function planNewTypeCreation({
	defaultWorkspacePath,
	entries,
	typeName,
	vaultPath,
	vaults,
}: NewTypeParams & { entries: VaultEntry[] }): TypeCreationPlan {
	const existingType = findEquivalentTypeEntry(entries, typeName);
	if (existingType) return { status: "existing", entry: existingType };

	const resolved = resolveNewType({
		typeName,
		vaultPath,
		defaultWorkspacePath,
		vaults,
	});
	const collision = findPathCollision(entries, resolved.entry.path);
	if (collision) {
		return {
			status: "blocked",
			message: buildCreationCollisionMessage({
				noun: "type",
				title: typeName,
				path: resolved.entry.path,
			}),
		};
	}

	return { status: "create", resolved };
}

function isAlreadyExistsError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /already exists|file exists|eexist/i.test(message);
}

export function createPersistFailureMessage(
	entry: VaultEntry,
	error: unknown,
): string {
	if (isAlreadyExistsError(error)) {
		const noun = entry.isA === "Type" ? "type" : "note";
		return buildCreationCollisionMessage({
			noun,
			title: entry.title,
			path: entry.path,
		});
	}
	return entry.isA === "Type"
		? "Failed to create type — disk write error"
		: "Failed to create note — disk write error";
}

export interface PersistNewNoteRequest {
	path: string;
	content: string;
	vaultPath?: string;
}

function createNoteContentArgs({
	path,
	content,
	vaultPath,
}: PersistNewNoteRequest): Record<string, unknown> {
	return vaultPath ? { path, content, vaultPath } : { path, content };
}

/** Persist a newly created note. Resolves with where it was stored (a conflict copy on a remote). */
export function persistNewNote(
	request: PersistNewNoteRequest,
): Promise<string> {
	const args = createNoteContentArgs(request);
	if (hasRemoteVault()) return createRemoteNote(request.path, request.content);
	if (!isTauri())
		return mockInvoke<void>("save_note_content", args).then(() => request.path);
	return invoke<void>("create_note_content", args).then(() => request.path);
}

async function typeTargetExistsOnDisk({
	path,
	vaultPath,
}: Pick<PersistNewNoteRequest, "path" | "vaultPath">): Promise<boolean> {
	if (!isTauri()) return false;

	try {
		const backend = createVaultBackend(vaultPath ?? "");
		await backend.files.read(path);
		return true;
	} catch {
		return false;
	}
}

export async function findTypeTargetCollision(
	resolved: ResolvedEntry,
): Promise<string | null> {
	if (
		!(await typeTargetExistsOnDisk({
			path: resolved.entry.path,
			vaultPath: resolved.entry.workspace?.path,
		}))
	)
		return null;
	return buildCreationCollisionMessage({
		noun: "type",
		title: resolved.entry.title,
		path: resolved.entry.path,
	});
}

// Rapid Cmd+N bursts can outpace the note-list render path on desktop. Keep
// the first create immediate, then serialize the rest so each new note settles
// before the next one is opened.
export const RAPID_CREATE_NOTE_SETTLE_MS = 200;
