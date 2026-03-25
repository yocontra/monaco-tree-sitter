import {
  type Edit,
  Language,
  type Node,
  Parser,
  type Point,
  Query,
  type QueryCapture,
  type Tree,
} from "web-tree-sitter";

import {
  buildCaptureMapping,
  buildLegend,
  resolveCaptureName,
} from "./capture-mapping.js";

import type {
  CreateTreeSitterTokenProviderOptions,
  ModelState,
  MonacoCancellationToken,
  MonacoDisposable,
  MonacoDocumentSemanticTokensProvider,
  MonacoModelContentChange,
  MonacoNamespace,
  MonacoSemanticTokens,
  MonacoSemanticTokensEdits,
  MonacoSemanticTokensLegend,
  MonacoTextModel,
  TreeSitterTokenProvider,
} from "./types.js";

/**
 * Create a tree-sitter-powered semantic token provider for Monaco Editor.
 *
 * This initializes web-tree-sitter, loads the language grammar, compiles
 * the highlights query, and returns a provider you can register with Monaco.
 *
 * @example
 * ```ts
 * const provider = await createTreeSitterTokenProvider({
 *   treeSitterWasm: "/assets/tree-sitter.wasm",
 *   languageWasm: "/assets/tree-sitter-javascript.wasm",
 *   highlights: highlightsScmString,
 * });
 * monaco.languages.register({ id: "javascript" });
 * provider.register(monaco, "javascript");
 * ```
 */
export async function createTreeSitterTokenProvider(
  options: CreateTreeSitterTokenProviderOptions,
): Promise<TreeSitterTokenProvider> {
  // Initialize the tree-sitter WASM runtime
  await Parser.init({
    locateFile(_scriptName: string, _scriptDirectory: string) {
      return options.treeSitterWasm;
    },
  });

  // Load the language
  const language = await Language.load(options.languageWasm);

  // Compile the highlights query
  const query = new Query(language, options.highlights);

  // Build capture mapping and legend
  const mapping = buildCaptureMapping(options.captureMapping);
  const { tokenTypes, tokenTypeIndex } = buildLegend(mapping);

  const legend: MonacoSemanticTokensLegend = {
    tokenTypes,
    tokenModifiers: [],
  };

  // Track per-model state for incremental parsing
  const models = new Map<string, ModelState>();

  // Track all disposables for cleanup
  const disposables: MonacoDisposable[] = [];

  let resultCounter = 0;
  // Map resultId -> encoded token data for computing edits
  const resultCache = new Map<string, Uint32Array>();

  function getOrCreateModelState(model: MonacoTextModel): ModelState {
    const uri = model.uri.toString();
    const existing = models.get(uri);
    if (existing) return existing;

    const parser = new Parser();
    parser.setLanguage(language);

    const text = model.getValue();
    const tree = parser.parse(text);
    if (!tree) {
      throw new Error(`Failed to parse model: ${uri}`);
    }

    const disposable = model.onDidChangeContent((event) => {
      const state = models.get(uri);
      if (!state) return;

      // Apply edits to the old tree for incremental parsing
      for (const change of event.changes) {
        applyTreeEdit(state.tree, change);
      }

      // Re-parse with the edited tree
      const newText = model.getValue();
      const newTree = state.parser.parse(newText, state.tree);
      if (newTree) {
        state.tree.delete();
        state.tree = newTree;
        state.version = model.getVersionId();
      }
    });

    const state: ModelState = {
      tree,
      parser,
      version: model.getVersionId(),
      previousData: null,
      previousResultId: null,
      disposable,
    };
    models.set(uri, state);
    disposables.push(disposable);

    return state;
  }

  function applyTreeEdit(
    tree: Tree,
    change: MonacoModelContentChange,
  ): void {
    const startIndex = change.rangeOffset;
    const oldEndIndex = change.rangeOffset + change.rangeLength;
    const newEndIndex = change.rangeOffset + change.text.length;

    const startPosition: Point = {
      row: change.range.startLineNumber - 1,
      column: change.range.startColumn - 1,
    };

    const oldEndPosition: Point = {
      row: change.range.endLineNumber - 1,
      column: change.range.endColumn - 1,
    };

    // Compute new end position from the inserted text
    const newLines = change.text.split("\n");
    const newEndRow = startPosition.row + newLines.length - 1;
    const newEndColumn =
      newLines.length === 1
        ? startPosition.column + change.text.length
        : newLines[newLines.length - 1]!.length;

    const newEndPosition: Point = {
      row: newEndRow,
      column: newEndColumn,
    };

    const edit: Edit = {
      startIndex,
      oldEndIndex,
      newEndIndex,
      startPosition,
      oldEndPosition,
      newEndPosition,
    };

    tree.edit(edit);
  }

  function encodeTokens(tree: Tree): Uint32Array {
    const captures: QueryCapture[] = query.captures(tree.rootNode);

    // Sort captures by position: line first, then column
    captures.sort((a: QueryCapture, b: QueryCapture) => {
      const aStart = a.node.startPosition;
      const bStart = b.node.startPosition;
      if (aStart.row !== bStart.row) return aStart.row - bStart.row;
      return aStart.column - bStart.column;
    });

    // Build the delta-encoded token array (5 ints per token)
    const buffer: number[] = [];

    let prevLine = 0;
    let prevChar = 0;

    for (const capture of captures) {
      const monacoType = resolveCaptureName(capture.name, mapping);
      if (monacoType === undefined) continue;

      const typeIndex = tokenTypeIndex.get(monacoType);
      if (typeIndex === undefined) continue;

      const node: Node = capture.node;
      const startRow = node.startPosition.row;
      const startCol = node.startPosition.column;
      const endRow = node.endPosition.row;
      const endCol = node.endPosition.column;

      // For multi-line tokens, emit one token per line
      if (startRow === endRow) {
        // Single-line token
        const deltaLine = startRow - prevLine;
        const deltaChar = deltaLine === 0 ? startCol - prevChar : startCol;
        const length = endCol - startCol;

        if (length > 0) {
          buffer.push(deltaLine, deltaChar, length, typeIndex, 0);
          prevLine = startRow;
          prevChar = startCol;
        }
      } else {
        // Multi-line token: split into one token per line
        const text = node.text;
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.length === 0) continue;

          const row = startRow + i;
          const col = i === 0 ? startCol : 0;
          const length = line.length;

          const deltaLine = row - prevLine;
          const deltaChar = deltaLine === 0 ? col - prevChar : col;

          buffer.push(deltaLine, deltaChar, length, typeIndex, 0);
          prevLine = row;
          prevChar = col;
        }
      }
    }

    return new Uint32Array(buffer);
  }

  function computeEdits(
    oldData: Uint32Array,
    newData: Uint32Array,
  ): MonacoSemanticTokensEdits["edits"] | null {
    // Find the first difference
    const minLen = Math.min(oldData.length, newData.length);
    let firstDiff = -1;
    for (let i = 0; i < minLen; i++) {
      if (oldData[i] !== newData[i]) {
        firstDiff = i;
        break;
      }
    }

    // If no differences in the overlapping region
    if (firstDiff === -1) {
      if (oldData.length === newData.length) return null; // Identical
      if (oldData.length < newData.length) {
        // New data is longer — append
        return [
          {
            start: oldData.length,
            deleteCount: 0,
            data: newData.slice(oldData.length),
          },
        ];
      }
      // Old data is longer — truncate
      return [
        {
          start: newData.length,
          deleteCount: oldData.length - newData.length,
        },
      ];
    }

    // Find the last difference (searching from the end)
    let oldEnd = oldData.length;
    let newEnd = newData.length;
    while (
      oldEnd > firstDiff &&
      newEnd > firstDiff &&
      oldData[oldEnd - 1] === newData[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }

    return [
      {
        start: firstDiff,
        deleteCount: oldEnd - firstDiff,
        data: newData.slice(firstDiff, newEnd),
      },
    ];
  }

  function cleanResultCache(): void {
    if (resultCache.size > 10) {
      const keys = Array.from(resultCache.keys());
      for (let i = 0; i < keys.length - 10; i++) {
        resultCache.delete(keys[i]!);
      }
    }
  }

  function ensureTreeUpToDate(model: MonacoTextModel, state: ModelState): void {
    if (model.getVersionId() !== state.version) {
      const newText = model.getValue();
      const newTree = state.parser.parse(newText, state.tree);
      if (newTree) {
        state.tree.delete();
        state.tree = newTree;
        state.version = model.getVersionId();
      }
    }
  }

  const semanticTokensProvider: MonacoDocumentSemanticTokensProvider = {
    getLegend(): MonacoSemanticTokensLegend {
      return legend;
    },

    provideDocumentSemanticTokens(
      model: MonacoTextModel,
      _lastResultId: string | null,
      _token: MonacoCancellationToken,
    ): MonacoSemanticTokens | null {
      const state = getOrCreateModelState(model);
      ensureTreeUpToDate(model, state);

      const data = encodeTokens(state.tree);
      const resultId = String(++resultCounter);

      state.previousData = data;
      state.previousResultId = resultId;
      resultCache.set(resultId, data);
      cleanResultCache();

      return { resultId, data };
    },

    provideDocumentSemanticTokensEdits(
      model: MonacoTextModel,
      lastResultId: string,
      _token: MonacoCancellationToken,
    ): MonacoSemanticTokensEdits | MonacoSemanticTokens | null {
      const state = getOrCreateModelState(model);
      ensureTreeUpToDate(model, state);

      const newData = encodeTokens(state.tree);
      const resultId = String(++resultCounter);

      // Try to compute edits from previous result
      const oldData = resultCache.get(lastResultId);
      if (oldData) {
        const edits = computeEdits(oldData, newData);

        state.previousData = newData;
        state.previousResultId = resultId;
        resultCache.set(resultId, newData);
        cleanResultCache();

        if (edits === null) {
          return { resultId, edits: [] };
        }
        return { resultId, edits };
      }

      // No previous data — fall back to full tokens
      state.previousData = newData;
      state.previousResultId = resultId;
      resultCache.set(resultId, newData);

      return { resultId, data: newData };
    },

    releaseDocumentSemanticTokens(resultId: string | undefined): void {
      if (resultId) {
        resultCache.delete(resultId);
      }
    },
  };

  function register(monaco: MonacoNamespace, languageId: string): void {
    // Register the semantic tokens provider
    const providerDisposable = monaco.languages.registerDocumentSemanticTokensProvider(
      languageId,
      semanticTokensProvider,
      legend,
    );
    disposables.push(providerDisposable);

    // Set up model tracking for existing models
    for (const model of monaco.editor.getModels()) {
      if (model.getLanguageId() === languageId) {
        getOrCreateModelState(model);
      }
    }

    // Track new models
    const modelDisposable = monaco.editor.onDidCreateModel((model: MonacoTextModel) => {
      if (model.getLanguageId() === languageId) {
        getOrCreateModelState(model);
      }
    });
    disposables.push(modelDisposable);

    // Clean up when models are disposed
    const disposeModelListener = monaco.editor.onWillDisposeModel((model: MonacoTextModel) => {
      const uri = model.uri.toString();
      const state = models.get(uri);
      if (state) {
        state.tree.delete();
        state.parser.delete();
        state.disposable.dispose();
        models.delete(uri);
      }
    });
    disposables.push(disposeModelListener);
  }

  function dispose(): void {
    // Dispose all Monaco registrations and listeners
    for (const d of disposables) {
      d.dispose();
    }
    disposables.length = 0;

    // Delete all trees and parsers
    for (const [, state] of models) {
      state.tree.delete();
      state.parser.delete();
    }
    models.clear();

    // Clear result cache
    resultCache.clear();

    // Delete the query
    query.delete();
  }

  return {
    register,
    language,
    query,
    dispose,
  };
}
