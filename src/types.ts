import type { Language, Parser, Query, Tree } from "web-tree-sitter"

/**
 * Maps tree-sitter capture names (from highlights.scm) to Monaco semantic token types.
 *
 * Keys are capture names like "keyword", "string", "comment", etc.
 * Values are Monaco semantic token type strings like "keyword", "string", "comment", etc.
 *
 * Dotted capture names (e.g. "string.special") are looked up first by their full name,
 * then by their base name (e.g. "string").
 */
export type CaptureMapping = Record<string, string>

/**
 * Options for creating a tree-sitter token provider.
 */
export interface CreateTreeSitterTokenProviderOptions {
  /**
   * URL or path to the web-tree-sitter runtime WASM file (tree-sitter.wasm).
   * This is passed to `Parser.init({ locateFile: () => treeSitterWasm })`.
   */
  treeSitterWasm: string

  /**
   * URL or path to the language-specific WASM file (e.g. tree-sitter-javascript.wasm).
   * This is passed to `Language.load(languageWasm)`.
   */
  languageWasm: string

  /**
   * The contents of a highlights.scm file for the language.
   * This defines which syntax nodes map to which highlight capture names.
   */
  highlights: string

  /**
   * Optional custom mapping from tree-sitter capture names to Monaco semantic token types.
   * Merged on top of the default mapping — your entries take precedence.
   */
  captureMapping?: CaptureMapping
}

/**
 * A managed tree-sitter token provider that can be registered with Monaco.
 */
export interface TreeSitterTokenProvider {
  /**
   * Register this provider with a Monaco instance for a given language.
   *
   * This registers a `DocumentSemanticTokensProvider` and sets up incremental
   * parsing via content change listeners.
   *
   * @param monaco - The Monaco editor namespace (typically `import * as monaco from "monaco-editor"`)
   * @param languageId - The language ID to register for (e.g. "javascript", "plazaql")
   */
  register(monaco: MonacoNamespace, languageId: string): void

  /**
   * The tree-sitter Language instance, for advanced use cases.
   */
  readonly language: Language

  /**
   * The tree-sitter Query instance created from the highlights.scm, for advanced use cases.
   */
  readonly query: Query

  /**
   * Dispose of all resources: parsers, trees, queries, and Monaco registrations.
   * After calling dispose(), this provider cannot be used again.
   */
  dispose(): void
}

/**
 * Minimal subset of the Monaco namespace required by this library.
 * This avoids requiring the full monaco-editor types at runtime.
 */
export interface MonacoNamespace {
  languages: {
    registerDocumentSemanticTokensProvider(
      languageSelector: string,
      provider: MonacoDocumentSemanticTokensProvider,
      legend: MonacoSemanticTokensLegend,
    ): MonacoDisposable
  }
  editor: {
    onDidCreateModel(
      listener: (model: MonacoTextModel) => void,
    ): MonacoDisposable
    onWillDisposeModel(
      listener: (model: MonacoTextModel) => void,
    ): MonacoDisposable
    getModels(): MonacoTextModel[]
  }
}

/** @internal */
export interface MonacoSemanticTokensLegend {
  readonly tokenTypes: string[]
  readonly tokenModifiers: string[]
}

/** @internal */
export interface MonacoSemanticTokens {
  readonly resultId?: string
  readonly data: Uint32Array
}

/** @internal */
export interface MonacoSemanticTokensEdits {
  readonly resultId?: string
  readonly edits: MonacoSemanticTokensEdit[]
}

/** @internal */
export interface MonacoSemanticTokensEdit {
  readonly start: number
  readonly deleteCount: number
  readonly data?: Uint32Array
}

/** @internal */
export interface MonacoDocumentSemanticTokensProvider {
  getLegend(): MonacoSemanticTokensLegend
  provideDocumentSemanticTokens(
    model: MonacoTextModel,
    lastResultId: string | null,
    token: MonacoCancellationToken,
  ): MonacoSemanticTokens | null
  provideDocumentSemanticTokensEdits?(
    model: MonacoTextModel,
    lastResultId: string,
    token: MonacoCancellationToken,
  ): MonacoSemanticTokensEdits | MonacoSemanticTokens | null
  releaseDocumentSemanticTokens(resultId: string | undefined): void
}

/** @internal */
export interface MonacoCancellationToken {
  readonly isCancellationRequested: boolean
}

/** @internal */
export interface MonacoDisposable {
  dispose(): void
}

/** @internal */
export interface MonacoTextModel {
  readonly uri: { toString(): string }
  getValue(): string
  getVersionId(): number
  getLanguageId(): string
  onDidChangeContent(
    listener: (e: MonacoModelContentChangedEvent) => void,
  ): MonacoDisposable
}

/** @internal */
export interface MonacoModelContentChangedEvent {
  readonly changes: MonacoModelContentChange[]
}

/** @internal */
export interface MonacoModelContentChange {
  readonly range: {
    readonly startLineNumber: number
    readonly startColumn: number
    readonly endLineNumber: number
    readonly endColumn: number
  }
  readonly rangeOffset: number
  readonly rangeLength: number
  readonly text: string
}

/** @internal Stored state for a single editor model */
export interface ModelState {
  tree: Tree
  parser: Parser
  version: number
  disposable: MonacoDisposable
}
