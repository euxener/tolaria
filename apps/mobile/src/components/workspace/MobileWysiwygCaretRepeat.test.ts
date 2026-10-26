// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTentapEditor } from "./MobileTentapTestHarness";

const nativeKeyCommandsPath = resolve(
	process.cwd(),
	"modules/tolaria-key-commands/ios/TolariaKeyCommandsModule.swift",
);

describe("mobile WYSIWYG arrow-key repeat", () => {
	it("lets repeated arrows reach the editor WebView without being canceled", async () => {
		const { editor, dispose } = await createTestTentapEditor(
			"<p>first line</p><p>second line</p>",
		);
		try {
			editor.commands.setTextSelection(5);

			for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
				const event = new KeyboardEvent("keydown", {
					key,
					bubbles: true,
					repeat: true,
				});
				editor.view.dom.dispatchEvent(event);
				expect(
					event.repeat,
					`${key} should retain the platform repeat flag`,
				).toBe(true);
				expect(
					event.defaultPrevented,
					`${key} should remain available to native caret movement`,
				).toBe(false);
			}

			for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
				const selectionEvent = new KeyboardEvent("keydown", {
					key,
					bubbles: true,
					repeat: true,
					shiftKey: true,
				});
				editor.view.dom.dispatchEvent(selectionEvent);
				expect(
					selectionEvent.defaultPrevented,
					`Shift+${key} should remain available to native selection movement`,
				).toBe(false);
			}
		} finally {
			dispose();
		}
	});

	it("does not give bare vertical arrows priority over UIKit text editing", () => {
		const source = readFileSync(nativeKeyCommandsPath, "utf8");
		expect(source).toMatch(
			/let isBareArrow = specification\.modifierFlags\.isEmpty[\s\S]*?UIKeyCommand\.inputUpArrow[\s\S]*?UIKeyCommand\.inputDownArrow/,
		);
		expect(source).toMatch(/wantsPriorityOverSystemBehavior = !isBareArrow/);
	});
});
