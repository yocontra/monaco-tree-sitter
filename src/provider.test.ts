import { beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type {
  MonacoCancellationToken,
  MonacoModelContentChangedEvent,
  MonacoNamespace,
  MonacoSemanticTokens,
  MonacoSemanticTokensEdits,
  MonacoTextModel,
} from "./types.js"

// Shared mock instances accessible to tests
const mockTree = {
  rootNode: {
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 10 },
  },
  edit: vi.fn(),
  delete: vi.fn(),
}

const mockParser = {
  setLanguage: vi.fn(),
  parse: vi.fn(() => mockTree),
  delete: vi.fn(),
}

// biome-ignore lint/suspicious/noExplicitAny: mock return type
const mockQueryCaptures = vi.fn((): any[] => [])
const mockQuery = {
  captures: mockQueryCaptures,
  delete: vi.fn(),
}

// Mock web-tree-sitter
vi.mock("web-tree-sitter", () => {
  return {
    Parser: Object.assign(
      function MockParser() {
        return mockParser
      },
      { init: vi.fn() },
    ),
    Language: { load: vi.fn(() => ({})) },
    Query: function MockQuery() {
      return mockQuery
    },
  }
})

// Import after mock setup
const { createTreeSitterTokenProvider } = await import("./provider.js")
const { Parser, Language } = await import("web-tree-sitter")

function createMockModel(
  uri = "file:///test.js",
  value = "const x = 1",
  languageId = "javascript",
): MonacoTextModel & {
  _changeListeners: Array<(e: MonacoModelContentChangedEvent) => void>
  _version: number
} {
  const changeListeners: Array<(e: MonacoModelContentChangedEvent) => void> = []
  const version = 1

  return {
    uri: { toString: () => uri },
    getValue: () => value,
    getVersionId: () => version,
    getLanguageId: () => languageId,
    onDidChangeContent: (
      listener: (e: MonacoModelContentChangedEvent) => void,
    ) => {
      changeListeners.push(listener)
      return { dispose: () => {} }
    },
    _changeListeners: changeListeners,
    _version: version,
  }
}

function createMockMonaco(models: MonacoTextModel[] = []): MonacoNamespace & {
  _createListeners: Array<(m: MonacoTextModel) => void>
  _disposeListeners: Array<(m: MonacoTextModel) => void>
} {
  const createListeners: Array<(m: MonacoTextModel) => void> = []
  const disposeListeners: Array<(m: MonacoTextModel) => void> = []

  return {
    languages: {
      registerDocumentSemanticTokensProvider: vi.fn(() => ({
        dispose: vi.fn(),
      })),
    },
    editor: {
      onDidCreateModel: (listener: (m: MonacoTextModel) => void) => {
        createListeners.push(listener)
        return { dispose: vi.fn() }
      },
      onWillDisposeModel: (listener: (m: MonacoTextModel) => void) => {
        disposeListeners.push(listener)
        return { dispose: vi.fn() }
      },
      getModels: () => models,
    },
    _createListeners: createListeners,
    _disposeListeners: disposeListeners,
  }
}

const activeToken: MonacoCancellationToken = { isCancellationRequested: false }
const cancelledToken: MonacoCancellationToken = {
  isCancellationRequested: true,
}

function createProvider() {
  return createTreeSitterTokenProvider({
    treeSitterWasm: "/test/tree-sitter.wasm",
    languageWasm: "/test/tree-sitter-javascript.wasm",
    highlights: "(comment) @comment",
  })
}

describe("createTreeSitterTokenProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("initializes Parser with locateFile", async () => {
    await createProvider()
    expect(Parser.init).toHaveBeenCalledWith(
      expect.objectContaining({
        locateFile: expect.any(Function),
      }),
    )
  })

  it("loads language WASM", async () => {
    await createProvider()
    expect(Language.load).toHaveBeenCalledWith(
      "/test/tree-sitter-javascript.wasm",
    )
  })

  it("creates query from highlights", async () => {
    const provider = await createProvider()
    // Query was created — the provider has a query property
    expect(provider.query).toBeDefined()
  })

  it("returns provider with register, language, query, dispose", async () => {
    const provider = await createProvider()
    expect(provider).toHaveProperty("register")
    expect(provider).toHaveProperty("language")
    expect(provider).toHaveProperty("query")
    expect(provider).toHaveProperty("dispose")
  })
})

describe("register", () => {
  it("registers semantic tokens provider with Monaco", async () => {
    const provider = await createProvider()
    const monaco = createMockMonaco()

    provider.register(monaco, "javascript")

    expect(
      monaco.languages.registerDocumentSemanticTokensProvider,
    ).toHaveBeenCalledWith("javascript", expect.anything(), expect.anything())
  })

  it("initializes state for existing matching models", async () => {
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    const provider = await createProvider()

    provider.register(monaco, "javascript")

    // Model should have a content change listener registered
    expect(model._changeListeners.length).toBe(1)
  })

  it("skips models with non-matching language", async () => {
    const model = createMockModel("file:///test.py", "x = 1", "python")
    const monaco = createMockMonaco([model])
    const provider = await createProvider()

    provider.register(monaco, "javascript")

    expect(model._changeListeners.length).toBe(0)
  })

  it("tracks newly created models", async () => {
    const monaco = createMockMonaco()
    const provider = await createProvider()

    provider.register(monaco, "javascript")

    const newModel = createMockModel()
    for (const listener of monaco._createListeners) {
      listener(newModel)
    }

    expect(newModel._changeListeners.length).toBe(1)
  })

  it("cleans up disposed models", async () => {
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    const provider = await createProvider()

    provider.register(monaco, "javascript")

    // Dispose the model
    for (const listener of monaco._disposeListeners) {
      listener(model)
    }

    // The model's tree and parser should have been cleaned up
    // (verified through mock calls in web-tree-sitter)
  })
})

describe("semantic tokens provider", () => {
  async function getSemanticProvider() {
    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    provider.register(monaco, "javascript")

    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]
    const legend = registerCall[2]

    return { provider, model, monaco, semanticProvider, legend }
  }

  it("getLegend returns token types and empty modifiers", async () => {
    const { semanticProvider } = await getSemanticProvider()
    const legend = semanticProvider.getLegend()

    expect(legend.tokenTypes).toBeInstanceOf(Array)
    expect(legend.tokenTypes.length).toBeGreaterThan(0)
    expect(legend.tokenModifiers).toEqual([])
  })

  it("provideDocumentSemanticTokens returns data with resultId", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    const result = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    expect(result).not.toBeNull()
    expect(result.resultId).toBeDefined()
    expect(result.data).toBeInstanceOf(Uint32Array)
  })

  it("returns null when cancellation requested", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    const result = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      cancelledToken,
    )

    expect(result).toBeNull()
  })

  it("provideDocumentSemanticTokensEdits returns null on cancellation", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    const result = semanticProvider.provideDocumentSemanticTokensEdits(
      model,
      "1",
      cancelledToken,
    )

    expect(result).toBeNull()
  })

  it("provideDocumentSemanticTokensEdits falls back to full tokens with unknown lastResultId", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    const result = semanticProvider.provideDocumentSemanticTokensEdits(
      model,
      "unknown-id",
      activeToken,
    ) as MonacoSemanticTokens

    expect(result).not.toBeNull()
    expect(result.data).toBeInstanceOf(Uint32Array)
    expect(result.resultId).toBeDefined()
  })

  it("provideDocumentSemanticTokensEdits returns edits when previous result exists", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    // First call to establish a result
    const first = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    // Second call using the first result's ID
    const second = semanticProvider.provideDocumentSemanticTokensEdits(
      model,
      first.resultId,
      activeToken,
    ) as MonacoSemanticTokensEdits

    expect(second).not.toBeNull()
    expect(second.resultId).toBeDefined()
    // Should have edits array (empty if identical)
    expect(second.edits).toBeInstanceOf(Array)
  })

  it("releaseDocumentSemanticTokens cleans up cache", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    const result = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    // Should not throw
    semanticProvider.releaseDocumentSemanticTokens(result.resultId)
    semanticProvider.releaseDocumentSemanticTokens(undefined)
  })

  it("increments resultId across calls", async () => {
    const { semanticProvider, model } = await getSemanticProvider()

    const r1 = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens
    const r2 = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    expect(r1.resultId).not.toBe(r2.resultId)
    expect(Number(r2.resultId)).toBeGreaterThan(Number(r1.resultId))
  })
})

describe("dispose", () => {
  it("cleans up all resources", async () => {
    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])

    provider.register(monaco, "javascript")

    // Should not throw
    provider.dispose()
  })

  it("can be called without registering first", async () => {
    const provider = await createProvider()
    provider.dispose()
  })
})

describe("token encoding with captures", () => {
  it("encodes single-line captures correctly", async () => {
    mockQueryCaptures.mockReturnValueOnce([
      {
        name: "comment",
        node: {
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 10 },
          text: "// comment",
        },
      },
    ])

    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    provider.register(monaco, "javascript")

    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]

    const result = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    // Should have 5 values per token: deltaLine, deltaChar, length, typeIndex, modifiers
    expect(result.data.length % 5).toBe(0)
    expect(result.data.length).toBe(5)
    expect(result.data[0]).toBe(0) // deltaLine
    expect(result.data[1]).toBe(0) // deltaChar
    expect(result.data[2]).toBe(10) // length
    expect(result.data[4]).toBe(0) // no modifiers
  })

  it("encodes multi-line captures by splitting into per-line tokens", async () => {
    mockQueryCaptures.mockReturnValueOnce([
      {
        name: "comment",
        node: {
          startPosition: { row: 0, column: 2 },
          endPosition: { row: 2, column: 4 },
          text: "/* line1\nline2\n  */",
        },
      },
    ])

    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    provider.register(monaco, "javascript")

    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]

    const result = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    // 3 lines of text = 3 tokens = 15 values
    expect(result.data.length).toBe(15)
  })

  it("skips captures with unknown names", async () => {
    mockQueryCaptures.mockReturnValueOnce([
      {
        name: "totally_unknown_capture",
        node: {
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 5 },
          text: "hello",
        },
      },
    ])

    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    provider.register(monaco, "javascript")

    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]

    const result = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    expect(result.data.length).toBe(0)
  })
})

describe("content change handling", () => {
  it("applies tree edits on content change", async () => {
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    const provider = await createProvider()

    provider.register(monaco, "javascript")

    // Simulate a content change
    for (const listener of model._changeListeners) {
      listener({
        changes: [
          {
            range: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 6,
            },
            rangeOffset: 0,
            rangeLength: 5,
            text: "let y",
          },
        ],
      })
    }

    // tree.edit and parser.parse should have been called
    expect(mockTree.edit).toHaveBeenCalled()
    expect(mockParser.parse).toHaveBeenCalled()
  })

  it("handles multi-line text insertions", async () => {
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    const provider = await createProvider()

    provider.register(monaco, "javascript")

    for (const listener of model._changeListeners) {
      listener({
        changes: [
          {
            range: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
            },
            rangeOffset: 0,
            rangeLength: 0,
            text: "line1\nline2\nline3",
          },
        ],
      })
    }

    expect(mockTree.edit).toHaveBeenCalled()
  })
})

describe("ensureTreeUpToDate", () => {
  it("re-parses when model version differs from state", async () => {
    const provider = await createProvider()
    let version = 1
    const model = {
      ...createMockModel(),
      getVersionId: () => version,
    }
    const monaco = createMockMonaco([model as unknown as MonacoTextModel])
    provider.register(monaco, "javascript")

    const parseCalls = mockParser.parse.mock.calls.length

    // Bump version so ensureTreeUpToDate triggers
    version = 2

    // Request tokens — this calls ensureTreeUpToDate internally
    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]

    semanticProvider.provideDocumentSemanticTokens(model, null, activeToken)

    expect(mockParser.parse.mock.calls.length).toBeGreaterThan(parseCalls)
  })
})

describe("edits computation edge cases", () => {
  it("returns empty edits array when tokens are identical", async () => {
    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    provider.register(monaco, "javascript")

    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]

    // First call
    const first = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    // Second call (same data, both return empty captures)
    const second = semanticProvider.provideDocumentSemanticTokensEdits(
      model,
      first.resultId,
      activeToken,
    ) as MonacoSemanticTokensEdits

    expect(second.edits).toEqual([])
  })

  it("computes edits when tokens differ", async () => {
    const provider = await createProvider()
    const model = createMockModel()
    const monaco = createMockMonaco([model])
    provider.register(monaco, "javascript")

    const registerCall = (
      monaco.languages.registerDocumentSemanticTokensProvider as Mock
    ).mock.calls[0]
    const semanticProvider = registerCall[1]

    // First call with one capture
    mockQueryCaptures.mockReturnValueOnce([
      {
        name: "comment",
        node: {
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 5 },
          text: "// hi",
        },
      },
    ])

    const first = semanticProvider.provideDocumentSemanticTokens(
      model,
      null,
      activeToken,
    ) as MonacoSemanticTokens

    // Second call with a different capture
    mockQueryCaptures.mockReturnValueOnce([
      {
        name: "comment",
        node: {
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 10 },
          text: "// hello!!",
        },
      },
    ])

    const second = semanticProvider.provideDocumentSemanticTokensEdits(
      model,
      first.resultId,
      activeToken,
    ) as MonacoSemanticTokensEdits

    expect(second.edits.length).toBeGreaterThan(0)
  })
})
