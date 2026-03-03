import { useRef, useEffect } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  autocompletion,
  acceptCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import { cn } from "@/lib/utils";
import { cmTheme } from "@/lib/codemirror-theme";

export interface IndexTarget {
  name: string;
  kind: "index" | "alias";
}

function indexCompletions(targets: IndexTarget[]) {
  const options: Completion[] = targets.map((t) => ({
    label: t.name,
    type: "variable",
    detail: t.kind,
  }));

  return (context: CompletionContext): CompletionResult | null => {
    // Match the current segment (after the last comma if present)
    const line = context.state.doc.sliceString(0, context.pos);
    const lastComma = line.lastIndexOf(",");
    const segmentStart = lastComma + 1;
    const segment = line.slice(segmentStart).trimStart();
    const from = context.pos - segment.length;

    if (segment.length === 0 && !context.explicit) return null;

    return { from, options, filter: true };
  };
}

interface IndexPatternEditorProps {
  targets: IndexTarget[];
  defaultValue: string;
  placeholder?: string;
  onExecute: () => void;
  onChange: (value: string) => void;
  className?: string;
  vimMode?: boolean;
}

export function IndexPatternEditor({
  targets,
  defaultValue,
  placeholder = "index-*,other-index",
  onExecute,
  onChange,
  className,
  vimMode,
}: IndexPatternEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const existingDoc = viewRef.current?.state.doc.toString();

    const state = EditorState.create({
      doc: existingDoc ?? defaultValue,
      extensions: [
        ...(vimMode ? [vim()] : []),
        history(),
        keymap.of(historyKeymap),
        cmTheme,
        autocompletion({
          override: [indexCompletions(targets)],
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
            run: () => {
              onExecuteRef.current();
              return true;
            },
          }]),
        ]),
        ...(vimMode ? [keymap.of([{
          key: "Ctrl-Enter",
          run: () => { onExecuteRef.current(); return true; },
        }, {
          key: "Mod-Enter",
          run: () => { onExecuteRef.current(); return true; },
        }])] : []),
        cmPlaceholder(placeholder),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.lineWrapping,
        EditorState.transactionFilter.of((tr) => {
          if (tr.newDoc.lines > 1) return [];
          return tr;
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [targets, defaultValue, placeholder, vimMode]);

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
