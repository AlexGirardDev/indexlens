import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView as CmEditorView, ViewPlugin } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";

export interface ViewerSearchState {
  activeMatch: number;
  hasMatches: boolean;
  query: string;
  totalMatches: number;
}

const EMPTY_STATE: ViewerSearchState = {
  activeMatch: 0,
  hasMatches: false,
  query: "",
  totalMatches: 0,
};

function buildQuery(query: string): SearchQuery {
  return new SearchQuery({ search: query });
}

const searchMatchMark = Decoration.mark({ class: "cm-searchMatch" });
const selectedSearchMatchMark = Decoration.mark({
  class: "cm-searchMatch cm-searchMatch-selected",
});

function collectSearchDecorations(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!query.valid || !query.search) return Decoration.none;

  const cursor = query.getCursor(view.state.doc);
  const builder = new RangeSetBuilder<Decoration>();
  const selectedRanges = view.state.selection.ranges;

  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from, to } = next.value;
    const isSelected = selectedRanges.some((range) => range.from === from && range.to === to);
    builder.add(from, to, isSelected ? selectedSearchMatchMark : searchMatchMark);
  }

  return builder.finish();
}

const viewerSearchDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = collectSearchDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) {
      this.decorations = collectSearchDecorations(update.view);
      return;
    }

    const prevQuery = getSearchQuery(update.startState);
    const nextQuery = getSearchQuery(update.state);
    if (
      prevQuery.search !== nextQuery.search ||
      prevQuery.caseSensitive !== nextQuery.caseSensitive ||
      prevQuery.literal !== nextQuery.literal ||
      prevQuery.regexp !== nextQuery.regexp ||
      prevQuery.wholeWord !== nextQuery.wholeWord
    ) {
      this.decorations = collectSearchDecorations(update.view);
    }
  }
}, {
  decorations: (value) => value.decorations,
});

export function createViewerSearchExtensions(onUpdate: (view: EditorView) => void) {
  return [
    search({ top: false }),
    viewerSearchDecorations,
    CmEditorView.updateListener.of((update) => {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setSearchQuery)))
      ) {
        onUpdate(update.view);
      }
    }),
  ];
}

export function readViewerSearchState(view: EditorView): ViewerSearchState {
  const query = getSearchQuery(view.state);
  if (!query.search) return EMPTY_STATE;

  const cursor = query.getCursor(view.state.doc);
  const selectionHead = view.state.selection.main.head;
  let totalMatches = 0;
  let activeMatch = 0;

  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from, to } = next.value;
    totalMatches += 1;
    if (selectionHead >= from && selectionHead <= to) {
      activeMatch = totalMatches;
    }
  }

  if (totalMatches > 0 && activeMatch === 0) {
    activeMatch = 1;
  }

  return {
    activeMatch,
    hasMatches: totalMatches > 0,
    query: query.search,
    totalMatches,
  };
}

export function setViewerSearchQuery(
  view: EditorView,
  query: string,
  opts?: { scrollToFirst?: boolean },
): ViewerSearchState {
  const nextQuery = buildQuery(query);
  view.dispatch({
    effects: setSearchQuery.of(nextQuery),
  });

  if (query && opts?.scrollToFirst) {
    view.dispatch({
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
    findNext(view);
  }

  return readViewerSearchState(view);
}

export function nextViewerSearchMatch(view: EditorView): ViewerSearchState {
  findNext(view);
  return readViewerSearchState(view);
}

export function previousViewerSearchMatch(view: EditorView): ViewerSearchState {
  findPrevious(view);
  return readViewerSearchState(view);
}
