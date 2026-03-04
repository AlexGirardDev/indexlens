import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// ---------------------------------------------------------------------------
// Dracula palette
// ---------------------------------------------------------------------------

const bg = "#282a36";
const currentLine = "#44475a";
const fg = "#f8f8f2";
const comment = "#6272a4";
const cyan = "#8be9fd";
const green = "#50fa7b";
const orange = "#ffb86c";
const pink = "#ff79c6";
const purple = "#bd93f9";
const red = "#ff5555";
const yellow = "#f1fa8c";

// ---------------------------------------------------------------------------
// Syntax highlighting (shared between search bar + viewer)
// ---------------------------------------------------------------------------

const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: cyan },
  { tag: tags.string, color: yellow },
  { tag: tags.number, color: purple },
  { tag: tags.bool, color: purple },
  { tag: tags.null, color: comment },
  { tag: tags.punctuation, color: fg },
  { tag: tags.brace, color: fg },
  { tag: tags.keyword, color: pink },
]);

const cmHighlighting = syntaxHighlighting(highlightStyle);

// ---------------------------------------------------------------------------
// Search bar editor theme (single-line, no gutters)
// ---------------------------------------------------------------------------

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: bg,
    color: fg,
    fontSize: "13px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    caretColor: fg,
    padding: "6px 8px",
    fontFamily:
      "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: fg,
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: currentLine,
    },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-tooltip": {
    backgroundColor: bg,
    color: fg,
    border: `1px solid ${currentLine}`,
    borderRadius: "6px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily:
      "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: "13px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "2px 8px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: currentLine,
    color: fg,
  },
  ".cm-tooltip-autocomplete .cm-completionDetail": {
    color: comment,
    fontStyle: "normal",
    marginLeft: "8px",
  },
  ".cm-tooltip-autocomplete .cm-completionMatchedText": {
    textDecoration: "none",
    color: green,
    fontWeight: "600",
  },
  ".cm-placeholder": {
    color: comment,
  },
  ".cm-scroller": {
    overflow: "hidden",
  },
});

// ---------------------------------------------------------------------------
// JSON viewer theme (multi-line, with gutters, scrollable)
// ---------------------------------------------------------------------------

const viewerTheme = EditorView.theme({
  "&": {
    backgroundColor: bg,
    color: fg,
    fontSize: "13px",
    height: "100%",
    minHeight: "0",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    caretColor: fg,
    padding: "8px 0",
    fontFamily:
      "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  },
  ".cm-line": {
    padding: "0 8px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: fg,
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: currentLine,
    },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-gutters": {
    backgroundColor: bg,
    color: comment,
    borderRight: `1px solid ${currentLine}`,
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-foldGutter .cm-gutterElement": {
    color: comment,
  },
  ".cm-scroller": {
    overflow: "auto",
    maxHeight: "100%",
  },
  ".cm-matchingBracket": {
    backgroundColor: currentLine,
    outline: `1px solid ${orange}`,
  },
  ".cm-tooltip": {
    backgroundColor: bg,
    color: fg,
    border: `1px solid ${currentLine}`,
    borderRadius: "6px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily:
      "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: "13px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "2px 8px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: currentLine,
    color: fg,
  },
  ".cm-tooltip-autocomplete .cm-completionDetail": {
    color: comment,
    fontStyle: "normal",
    marginLeft: "8px",
  },
  ".cm-tooltip-autocomplete .cm-completionMatchedText": {
    textDecoration: "none",
    color: green,
    fontWeight: "600",
  },
  // Lint diagnostics
  ".cm-diagnostic": {
    fontFamily:
      "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: "12px",
    padding: "4px 8px",
  },
  ".cm-diagnostic-error": {
    borderLeft: `3px solid ${red}`,
    color: fg,
  },
  ".cm-tooltip-lint": {
    backgroundColor: bg,
    color: fg,
    border: `1px solid ${currentLine}`,
    borderRadius: "6px",
  },
  ".cm-lintRange-error": {
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='%23ff5555' fill='none' stroke-width='.7'/%3E%3C/svg%3E")`,
  },
  ".cm-lint-marker-error": {
    content: `"!"`,
    color: red,
  },
});

export const cmTheme = [editorTheme, cmHighlighting];
export const cmViewerTheme = [viewerTheme, cmHighlighting];
