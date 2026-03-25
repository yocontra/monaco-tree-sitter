import { Language, Parser, Query, type Tree } from "web-tree-sitter"

import {
  buildCaptureMapping,
  buildLegend,
  resolveCaptureName,
} from "./capture-mapping.js"

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
} from "./types.js"

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
  await Parser.init({
    locateFile(_scriptName: string, _scriptDirectory: string) {
      return options.treeSitterWasm
    },
  })

  const language = await Language.load(options.languageWasm)
  const query = new Query(language, options.highlights)
  const mapping = buildCaptureMapping(options.captureMapping)
  const { tokenTypes, tokenTypeIndex } = buildLegend(mapping)

  const legend: MonacoSemanticTokensLegend = {
    tokenTypes,
    tokenModifiers: [],
  }

  const models = new Map<string, ModelState>()
  const disposables: MonacoDisposable[] = []

  let resultCounter = 0
  const MaxCachedResults = 10
  const resultCache = new Map<string, Uint32Array>()

  function getOrCreateModelState(model: MonacoTextModel): ModelState {
    const uri = model.uri.toString()
    const existing = models.get(uri)
    if (existing) {
      return existing
    }

    const parser = new Parser()
    parser.setLanguage(language)

    const text = model.getValue()
    const tree = parser.parse(text)
    if (!tree) {
      throw new Error(`Failed to parse model: ${uri}`)
    }

    const disposable = model.onDidChangeContent((event) => {
      const state = models.get(uri)
      if (!state) {
        return
      }

      for (const change of event.changes) {
        applyTreeEdit(state.tree, change)
      }

      const newText = model.getValue()
      const newTree = state.parser.parse(newText, state.tree)
      if (newTree) {
        state.tree.delete()
        state.tree = newTree
        state.version = model.getVersionId()
      }
    })

    const state: ModelState = {
      tree,
      parser,
      version: model.getVersionId(),
      disposable,
    }
    models.set(uri, state)
    disposables.push(disposable)

    return state
  }

  function applyTreeEdit(tree: Tree, change: MonacoModelContentChange): void {
    const newLines = change.text.split("\n")
    const startRow = change.range.startLineNumber - 1
    const startCol = change.range.startColumn - 1

    tree.edit({
      startIndex: change.rangeOffset,
      oldEndIndex: change.rangeOffset + change.rangeLength,
      newEndIndex: change.rangeOffset + change.text.length,
      startPosition: { row: startRow, column: startCol },
      oldEndPosition: {
        row: change.range.endLineNumber - 1,
        column: change.range.endColumn - 1,
      },
      newEndPosition: {
        row: startRow + newLines.length - 1,
        column:
          newLines.length === 1
            ? startCol + change.text.length
            : newLines[newLines.length - 1]?.length,
      },
    })
  }

  function resolveTokenTypeIndex(captureName: string): number | undefined {
    const monacoType = resolveCaptureName(captureName, mapping)
    if (monacoType === undefined) {
      return undefined
    }
    return tokenTypeIndex.get(monacoType)
  }

  function pushDeltaToken(
    state: { buffer: number[]; prevLine: number; prevChar: number },
    row: number,
    col: number,
    length: number,
    typeIdx: number,
  ): void {
    if (length <= 0) {
      return
    }
    const deltaLine = row - state.prevLine
    const deltaChar = deltaLine === 0 ? col - state.prevChar : col
    state.buffer.push(deltaLine, deltaChar, length, typeIdx, 0)
    state.prevLine = row
    state.prevChar = col
  }

  function sortCapturesByPosition(
    captures: ReturnType<Query["captures"]>,
  ): void {
    captures.sort((a, b) => {
      const aStart = a.node.startPosition
      const bStart = b.node.startPosition
      return aStart.row !== bStart.row
        ? aStart.row - bStart.row
        : aStart.column - bStart.column
    })
  }

  function emitCaptureTokens(
    capture: ReturnType<Query["captures"]>[number],
    typeIdx: number,
    state: { buffer: number[]; prevLine: number; prevChar: number },
  ): void {
    const { startPosition, endPosition } = capture.node

    if (startPosition.row === endPosition.row) {
      pushDeltaToken(
        state,
        startPosition.row,
        startPosition.column,
        endPosition.column - startPosition.column,
        typeIdx,
      )
      return
    }

    for (const [i, line] of capture.node.text.split("\n").entries()) {
      pushDeltaToken(
        state,
        startPosition.row + i,
        i === 0 ? startPosition.column : 0,
        line.length,
        typeIdx,
      )
    }
  }

  function encodeTokens(tree: Tree): Uint32Array {
    const captures = query.captures(tree.rootNode)
    sortCapturesByPosition(captures)

    const state = { buffer: [] as number[], prevLine: 0, prevChar: 0 }

    for (const capture of captures) {
      const typeIdx = resolveTokenTypeIndex(capture.name)
      if (typeIdx === undefined) {
        continue
      }
      emitCaptureTokens(capture, typeIdx, state)
    }

    return new Uint32Array(state.buffer)
  }

  function findFirstDiff(a: Uint32Array, b: Uint32Array): number {
    const minLen = Math.min(a.length, b.length)
    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) {
        return i
      }
    }
    return -1
  }

  function computeEdits(
    oldData: Uint32Array,
    newData: Uint32Array,
  ): MonacoSemanticTokensEdits["edits"] | null {
    const firstDiff = findFirstDiff(oldData, newData)

    if (firstDiff === -1) {
      if (oldData.length === newData.length) {
        return null
      }
      return [
        {
          start: Math.min(oldData.length, newData.length),
          deleteCount: Math.max(0, oldData.length - newData.length),
          data:
            oldData.length < newData.length
              ? newData.slice(oldData.length)
              : undefined,
        },
      ]
    }

    let oldEnd = oldData.length
    let newEnd = newData.length
    while (
      oldEnd > firstDiff &&
      newEnd > firstDiff &&
      oldData[oldEnd - 1] === newData[newEnd - 1]
    ) {
      oldEnd--
      newEnd--
    }

    return [
      {
        start: firstDiff,
        deleteCount: oldEnd - firstDiff,
        data: newData.slice(firstDiff, newEnd),
      },
    ]
  }

  function cleanResultCache(): void {
    if (resultCache.size > MaxCachedResults) {
      const keys = Array.from(resultCache.keys())
      for (const key of keys.slice(0, keys.length - MaxCachedResults)) {
        resultCache.delete(key)
      }
    }
  }

  function ensureTreeUpToDate(model: MonacoTextModel, state: ModelState): void {
    if (model.getVersionId() !== state.version) {
      const newText = model.getValue()
      const newTree = state.parser.parse(newText, state.tree)
      if (newTree) {
        state.tree.delete()
        state.tree = newTree
        state.version = model.getVersionId()
      }
    }
  }

  const semanticTokensProvider: MonacoDocumentSemanticTokensProvider = {
    getLegend(): MonacoSemanticTokensLegend {
      return legend
    },

    provideDocumentSemanticTokens(
      model: MonacoTextModel,
      _lastResultId: string | null,
      token: MonacoCancellationToken,
    ): MonacoSemanticTokens | null {
      if (token.isCancellationRequested) {
        return null
      }

      const state = getOrCreateModelState(model)
      ensureTreeUpToDate(model, state)

      const data = encodeTokens(state.tree)
      const resultId = String(++resultCounter)

      resultCache.set(resultId, data)
      cleanResultCache()

      return { resultId, data }
    },

    provideDocumentSemanticTokensEdits(
      model: MonacoTextModel,
      lastResultId: string,
      token: MonacoCancellationToken,
    ): MonacoSemanticTokensEdits | MonacoSemanticTokens | null {
      if (token.isCancellationRequested) {
        return null
      }

      const state = getOrCreateModelState(model)
      ensureTreeUpToDate(model, state)

      const newData = encodeTokens(state.tree)
      const resultId = String(++resultCounter)

      const oldData = resultCache.get(lastResultId)
      resultCache.set(resultId, newData)

      if (oldData) {
        const edits = computeEdits(oldData, newData)
        cleanResultCache()

        if (edits === null) {
          return { resultId, edits: [] }
        }
        return { resultId, edits }
      }

      cleanResultCache()

      return { resultId, data: newData }
    },

    releaseDocumentSemanticTokens(resultId: string | undefined): void {
      if (resultId) {
        resultCache.delete(resultId)
      }
    },
  }

  function register(monaco: MonacoNamespace, languageId: string): void {
    const providerDisposable =
      monaco.languages.registerDocumentSemanticTokensProvider(
        languageId,
        semanticTokensProvider,
        legend,
      )
    disposables.push(providerDisposable)

    for (const model of monaco.editor.getModels()) {
      if (model.getLanguageId() === languageId) {
        getOrCreateModelState(model)
      }
    }

    const modelDisposable = monaco.editor.onDidCreateModel(
      (model: MonacoTextModel) => {
        if (model.getLanguageId() === languageId) {
          getOrCreateModelState(model)
        }
      },
    )
    disposables.push(modelDisposable)

    const disposeModelListener = monaco.editor.onWillDisposeModel(
      (model: MonacoTextModel) => {
        const uri = model.uri.toString()
        const state = models.get(uri)
        if (state) {
          state.tree.delete()
          state.parser.delete()
          state.disposable.dispose()
          models.delete(uri)
        }
      },
    )
    disposables.push(disposeModelListener)
  }

  function dispose(): void {
    for (const d of disposables) {
      d.dispose()
    }
    disposables.length = 0

    for (const [, state] of models) {
      state.tree.delete()
      state.parser.delete()
    }
    models.clear()
    resultCache.clear()
    query.delete()
  }

  return {
    register,
    language,
    query,
    dispose,
  }
}
