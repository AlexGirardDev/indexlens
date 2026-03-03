import { useRef, useEffect, useMemo } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  autocompletion,
  acceptCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import { cn } from "@/lib/utils";
import { cmTheme } from "@/lib/codemirror-theme";
import { fieldCompletions } from "@/lib/es-query-completions";
import type { MappingField } from "@/lib/es-mapping";

const NUMERIC_TYPES = new Set([
  "long", "integer", "short", "byte", "float", "double",
  "half_float", "scaled_float",
]);

function buildPlaceholder(fields: MappingField[]): string {
  if (fields.length === 0) return "field: value && other > 10";

  const keyword = fields.find(
    (f) => f.type === "keyword" && !f.isSubfield,
  ) ?? fields.find((f) => f.type === "keyword");
  const numeric = fields.find((f) => NUMERIC_TYPES.has(f.type));

  const parts: string[] = [];
  if (keyword) parts.push(`${keyword.path}: example`);
  if (numeric) parts.push(`${numeric.path} > 10`);

  if (parts.length === 0) {
    const first = fields.find((f) => !f.isSubfield) ?? fields[0];
    parts.push(`${first.path}: value`);
  }

  return parts.join(" && ");
}

interface QueryEditorProps {
  fields: MappingField[];
  onExecute: (query: string) => void;
  onChange?: (value: string) => void;
  className?: string;
  vimMode?: boolean;
  autoFocus?: boolean;
}

export function QueryEditor({
  fields,
  onExecute,
  onChange,
  className,
  vimMode,
  autoFocus,
}: QueryEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const hint = useMemo(() => buildPlaceholder(fields), [fields]);

  useEffect(() => {
    if (!containerRef.current) return;

    const existingDoc = viewRef.current?.state.doc.toString();

    const state = EditorState.create({
      doc: existingDoc ?? "",
      extensions: [
        ...(vimMode ? [vim()] : []),
        history(),
        keymap.of(historyKeymap),
        cmTheme,
        autocompletion({
          override: [fieldCompletions(fields)],
          activateOnTyping: true,
        }),
        keymap.of([
          {
            key: "Tab",
            run: (view) => {
              if (acceptCompletion(view)) return true;
              startCompletion(view);
              return true;
            },
          },
          ...(vimMode ? [] : [{
            key: "Enter" as const,
            run: (view: EditorView) => {
              onExecuteRef.current(view.state.doc.toString());
              return true;
            },
          }]),
        ]),
        ...(vimMode ? [keymap.of([{
          key: "Ctrl-Enter",
          run: (view: EditorView) => { onExecuteRef.current(view.state.doc.toString()); return true; },
        }, {
          key: "Mod-Enter",
          run: (view: EditorView) => { onExecuteRef.current(view.state.doc.toString()); return true; },
        }])] : []),
        cmPlaceholder(hint),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
        EditorView.lineWrapping,
        // Prevent multi-line input
        EditorState.transactionFilter.of((tr) => {
          if (tr.newDoc.lines > 1) return [];
          return tr;
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    if (autoFocus) { view.focus(); }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [fields, hint, vimMode]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "rounded-md border overflow-hidden [&_.cm-editor]:outline-none [&_.cm-panels]:hidden",
        className,
      )}
    />
  );
}
