/**
 * Monaco, bundled with the app (no CDN): the gateway's CSP allows only same-origin scripts,
 * workers and fonts. Only the editor core and a few features are loaded, and only when the Files tab is opened.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
// Opt-in features: the icon font (a .ttf served by the gateway), find, clipboard and brackets.
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/bracketMatching/register";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };
