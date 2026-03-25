import type { CaptureMapping } from "./types.js"

/**
 * Default mapping from tree-sitter capture names to Monaco semantic token types.
 *
 * Monaco's built-in semantic token types:
 * comment, string, keyword, number, regexp, operator, namespace,
 * type, struct, class, interface, enum, enumMember, typeParameter,
 * function, method, macro, variable, parameter, property, label
 *
 * Tree-sitter captures use a dotted naming convention (e.g. "string.special").
 * We map both the full dotted name and fall back to the base name.
 */
export const DEFAULT_CAPTURE_MAPPING: CaptureMapping = {
  // Comments
  comment: "comment",
  "comment.line": "comment",
  "comment.block": "comment",

  // Strings
  string: "string",
  "string.special": "string",
  "string.regex": "regexp",
  "string.escape": "string",

  // Numbers
  number: "number",
  "number.float": "number",

  // Keywords
  keyword: "keyword",
  "keyword.control": "keyword",
  "keyword.operator": "operator",
  "keyword.function": "keyword",
  "keyword.return": "keyword",
  "keyword.conditional": "keyword",
  "keyword.repeat": "keyword",
  "keyword.import": "keyword",
  "keyword.exception": "keyword",
  "keyword.directive": "macro",

  // Functions
  function: "function",
  "function.builtin": "function",
  "function.call": "function",
  "function.method": "method",
  "function.method.call": "method",
  "function.macro": "macro",

  // Variables
  variable: "variable",
  "variable.builtin": "variable",
  "variable.parameter": "parameter",

  // Types
  type: "type",
  "type.builtin": "type",
  "type.definition": "type",

  // Constants
  constant: "enumMember",
  "constant.builtin": "enumMember",

  // Properties
  property: "property",
  "property.definition": "property",

  // Operators
  operator: "operator",

  // Punctuation — Monaco doesn't have a dedicated punctuation type,
  // so we use "regexp" as a distinguishable fallback.
  punctuation: "regexp",
  "punctuation.bracket": "regexp",
  "punctuation.delimiter": "regexp",
  "punctuation.special": "regexp",

  // Tags (HTML/XML)
  tag: "keyword",
  "tag.attribute": "property",

  // Labels
  label: "label",

  // Namespaces
  namespace: "namespace",
  module: "namespace",

  // Boolean
  boolean: "keyword",

  // Constructors
  constructor: "function",

  // Attributes
  attribute: "macro",
}

/**
 * Merge a user-provided capture mapping on top of the defaults.
 */
export function buildCaptureMapping(
  overrides?: CaptureMapping,
): CaptureMapping {
  if (!overrides) {
    return DEFAULT_CAPTURE_MAPPING
  }
  return { ...DEFAULT_CAPTURE_MAPPING, ...overrides }
}

/**
 * Resolve a capture name to a Monaco semantic token type.
 *
 * Lookup order:
 * 1. Exact match (e.g. "string.special")
 * 2. Base name (e.g. "string")
 * 3. undefined (capture is ignored)
 */
export function resolveCaptureName(
  name: string,
  mapping: CaptureMapping,
): string | undefined {
  // Exact match
  if (name in mapping) {
    return mapping[name]
  }

  // Try base name (everything before the first dot)
  const dotIndex = name.indexOf(".")
  if (dotIndex > 0) {
    const base = name.substring(0, dotIndex)
    if (base in mapping) {
      return mapping[base]
    }
  }

  return undefined
}

/**
 * Build a Monaco SemanticTokensLegend from a capture mapping.
 * Returns the deduplicated token types array and a lookup map from
 * token type string to its index in the legend.
 */
export function buildLegend(mapping: CaptureMapping): {
  tokenTypes: string[]
  tokenTypeIndex: Map<string, number>
} {
  const seen = new Set<string>()
  const tokenTypes: string[] = []

  for (const monacoType of Object.values(mapping)) {
    if (!seen.has(monacoType)) {
      seen.add(monacoType)
      tokenTypes.push(monacoType)
    }
  }

  const tokenTypeIndex = new Map<string, number>()
  for (const [i, type] of tokenTypes.entries()) {
    tokenTypeIndex.set(type, i)
  }

  return { tokenTypes, tokenTypeIndex }
}
