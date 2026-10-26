import type { VaultEntry } from "../types";
import { NOTE_FORMAT_SHEET, type NoteFormat } from "../utils/noteFormat";
import { canonicalFrontmatterKey } from "../utils/systemMetadata";
import { isTypeInstanceDefault } from "../utils/typeInstanceDefaults.mjs";
import type { TemplateLookupParams } from "./noteCreationBase";

export interface NoteContentParams {
	title: string | null;
	type: string;
	status: string | null;
	format?: NoteFormat;
	template?: string | null;
	initialEmptyHeading?: boolean;
	defaults?: TypeInstanceDefault[];
}

export type DefaultValue =
	| string
	| number
	| boolean
	| Array<string | number | boolean>;

export interface TypeInstanceDefault {
	key: string;
	value: DefaultValue;
	kind: "property" | "relationship";
}

export function buildNoteBody({
	format,
	template,
	initialEmptyHeading,
}: Pick<
	NoteContentParams,
	"format" | "template" | "initialEmptyHeading"
>): string {
	const templateBody = template ? `\n${template}` : "";
	if (format === NOTE_FORMAT_SHEET) return templateBody;
	if (!initialEmptyHeading) return templateBody;
	if (template?.trimStart().startsWith("# ")) return templateBody;
	if (!template) return "\n# \n\n";
	return `\n# \n\n${template}`;
}

function relationshipDefaultValue(refs: string[]): DefaultValue | null {
	if (refs.length === 0) return null;
	return refs.length === 1 ? refs[0] : refs;
}

function resolveTypeEntry({
	entries,
	typeName,
}: TemplateLookupParams): VaultEntry | undefined {
	return entries.find(
		(entry) => entry.isA === "Type" && entry.title === typeName,
	);
}

function collectPropertyDefaults(typeEntry: VaultEntry): TypeInstanceDefault[] {
	return Object.entries(typeEntry.properties ?? {}).flatMap(([key, value]) =>
		isTypeInstanceDefault(key, value, canonicalFrontmatterKey)
			? [{ key, value, kind: "property" as const }]
			: [],
	);
}

function collectRelationshipDefaults(
	typeEntry: VaultEntry,
): TypeInstanceDefault[] {
	return Object.entries(typeEntry.relationships ?? {}).flatMap(
		([key, refs]) => {
			const value = relationshipDefaultValue(refs);
			return value && isTypeInstanceDefault(key, value, canonicalFrontmatterKey)
				? [{ key, value, kind: "relationship" as const }]
				: [];
		},
	);
}

export function isStatusKey(key: string): boolean {
	return canonicalFrontmatterKey(key) === "status";
}

/** Status is semantic on every entry, so read its current value from `status`
 *  and only borrow the author's key spelling from the Type's properties. */
function collectStatusDefault(typeEntry: VaultEntry): TypeInstanceDefault[] {
	const status = typeEntry.status;
	if (
		!status ||
		!isTypeInstanceDefault("status", status, canonicalFrontmatterKey)
	)
		return [];
	const key =
		Object.keys(typeEntry.properties ?? {}).find(isStatusKey) ?? "status";
	return [{ key, value: status, kind: "property" }];
}

function appendUniqueDefault(
	defaults: TypeInstanceDefault[],
	seenKeys: Set<string>,
	defaultValue: TypeInstanceDefault,
) {
	const canonicalKey = canonicalFrontmatterKey(defaultValue.key);
	if (canonicalKey === "type" || canonicalKey === "title") return;
	if (seenKeys.has(canonicalKey)) return;
	seenKeys.add(canonicalKey);
	defaults.push(defaultValue);
}

export function resolveTypeInstanceDefaults(
	params: TemplateLookupParams,
): TypeInstanceDefault[] {
	const typeEntry = resolveTypeEntry(params);
	if (!typeEntry) return [];

	const defaults: TypeInstanceDefault[] = [];
	const seenKeys = new Set<string>();
	const candidateDefaults = [
		...collectStatusDefault(typeEntry),
		...collectPropertyDefaults(typeEntry),
		...collectRelationshipDefaults(typeEntry),
	];
	for (const defaultValue of candidateDefaults) {
		appendUniqueDefault(defaults, seenKeys, defaultValue);
	}
	return defaults;
}
