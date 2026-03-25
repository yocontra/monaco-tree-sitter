# monaco-tree-sitter

Use any [tree-sitter](https://tree-sitter.github.io/) grammar with [Monaco Editor](https://microsoft.github.io/monaco-editor/) for syntax highlighting. Works entirely in the browser via WASM — no server required.

This library registers a Monaco `DocumentSemanticTokensProvider` powered by tree-sitter's incremental parsing and highlights queries. It supports any language with a tree-sitter grammar and a `highlights.scm` file.

## Install

```bash
npm install @plazafyi/monaco-tree-sitter
```

Peer dependencies:

```bash
npm install monaco-editor web-tree-sitter
```

## Usage

```typescript
import * as monaco from "monaco-editor"
import { createTreeSitterTokenProvider } from "@plazafyi/monaco-tree-sitter"

// Load your highlights.scm file however you prefer
const highlightsScm = await fetch("/grammars/highlights.scm").then((r) =>
  r.text()
)

// Create the provider (async — initializes WASM)
const provider = await createTreeSitterTokenProvider({
  treeSitterWasm: "/wasm/tree-sitter.wasm",
  languageWasm: "/wasm/tree-sitter-javascript.wasm",
  highlights: highlightsScm,
})

// Register the language with Monaco (if not already registered)
monaco.languages.register({ id: "javascript", extensions: [".js"] })

// Register the tree-sitter token provider
provider.register(monaco, "javascript")

// Create an editor — it will automatically use tree-sitter highlighting
monaco.editor.create(document.getElementById("editor")!, {
  value: 'console.log("Hello, world!")',
  language: "javascript",
  "semanticHighlighting.enabled": true,
})
```

## How It Works

1. **Initialization** — loads the web-tree-sitter WASM runtime and your language grammar, then compiles `highlights.scm` into a tree-sitter Query.

2. **Parsing** — when Monaco requests semantic tokens, the provider parses the document and runs the highlights query to get capture names for each syntax node.

3. **Incremental updates** — on content changes, the provider uses `tree.edit()` followed by incremental re-parsing, making updates near-instant even for large files.

4. **Token encoding** — captures are mapped to Monaco semantic token types and delta-encoded as `Uint32Array` values. The provider implements `provideDocumentSemanticTokensEdits` to send only changed tokens on updates.

## Custom Capture Mapping

By default, tree-sitter capture names are mapped to Monaco semantic token types using sensible defaults (e.g. `keyword` → `keyword`, `string.special` → `string`, `function.builtin` → `function`). You can override any mapping:

```typescript
const provider = await createTreeSitterTokenProvider({
  treeSitterWasm: "/wasm/tree-sitter.wasm",
  languageWasm: "/wasm/tree-sitter-mylang.wasm",
  highlights: highlightsScm,
  captureMapping: {
    // Override: map "tag" captures to "type" instead of the default "keyword"
    tag: "type",
    // Add a custom capture not in the defaults
    "my_custom.capture": "variable",
  },
})
```

Capture names are resolved in order: exact match first (`string.special`), then base name (`string`). Unmatched captures are silently ignored.

## WASM Files

You need two WASM files:

1. **`tree-sitter.wasm`** — the web-tree-sitter runtime. Copy from `node_modules/web-tree-sitter/tree-sitter.wasm`.
2. **Your language WASM** — built with `tree-sitter build --wasm`. Many languages publish pre-built WASM on npm.

These must be served as static assets accessible by URL in the browser.

## Cleanup

Call `dispose()` when you're done to free all WASM resources, parsers, and Monaco registrations:

```typescript
provider.dispose()
```

## API

### `createTreeSitterTokenProvider(options)`

Async factory that initializes tree-sitter and returns a provider.

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `treeSitterWasm` | `string` | URL to `tree-sitter.wasm` runtime |
| `languageWasm` | `string` | URL to language WASM grammar |
| `highlights` | `string` | Contents of `highlights.scm` |
| `captureMapping` | `Record<string, string>` | Optional custom capture-to-token-type mapping |

**Returns:** `Promise<TreeSitterTokenProvider>`

### `TreeSitterTokenProvider`

| Member | Type | Description |
|--------|------|-------------|
| `register(monaco, languageId)` | `void` | Register the provider with Monaco for a language |
| `language` | `Language` | The tree-sitter Language instance |
| `query` | `Query` | The compiled highlights Query |
| `dispose()` | `void` | Clean up all resources |

### `DEFAULT_CAPTURE_MAPPING`

The default mapping from tree-sitter capture names to Monaco semantic token types. Exported so you can inspect or extend it.

## License

MIT
