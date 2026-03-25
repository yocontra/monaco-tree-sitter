import { describe, expect, it } from "vitest"
import {
  buildCaptureMapping,
  buildLegend,
  DEFAULT_CAPTURE_MAPPING,
  resolveCaptureName,
} from "./capture-mapping.js"

describe("buildCaptureMapping", () => {
  it("returns default mapping when no overrides", () => {
    expect(buildCaptureMapping()).toBe(DEFAULT_CAPTURE_MAPPING)
  })

  it("returns default mapping when overrides is undefined", () => {
    expect(buildCaptureMapping(undefined)).toBe(DEFAULT_CAPTURE_MAPPING)
  })

  it("merges overrides on top of defaults", () => {
    const result = buildCaptureMapping({ tag: "type" })
    expect(result.tag).toBe("type")
    expect(result.comment).toBe("comment")
  })

  it("allows adding new capture names", () => {
    const result = buildCaptureMapping({ "my.custom": "variable" })
    expect(result["my.custom"]).toBe("variable")
    expect(result.keyword).toBe("keyword")
  })
})

describe("resolveCaptureName", () => {
  const mapping = buildCaptureMapping()

  it("resolves exact match", () => {
    expect(resolveCaptureName("comment", mapping)).toBe("comment")
    expect(resolveCaptureName("string.special", mapping)).toBe("string")
    expect(resolveCaptureName("keyword.operator", mapping)).toBe("operator")
  })

  it("falls back to base name for unknown dotted names", () => {
    expect(resolveCaptureName("keyword.unknown_sub", mapping)).toBe("keyword")
    expect(resolveCaptureName("string.new_variant", mapping)).toBe("string")
  })

  it("returns undefined for completely unknown names", () => {
    expect(resolveCaptureName("totally_unknown", mapping)).toBeUndefined()
  })

  it("returns undefined for unknown dotted names with unknown base", () => {
    expect(resolveCaptureName("unknown.sub", mapping)).toBeUndefined()
  })

  it("handles empty string", () => {
    expect(resolveCaptureName("", mapping)).toBeUndefined()
  })

  it("handles name starting with dot", () => {
    expect(resolveCaptureName(".something", mapping)).toBeUndefined()
  })

  it("works with custom mapping", () => {
    const custom = { foo: "variable", "foo.bar": "keyword" }
    expect(resolveCaptureName("foo", custom)).toBe("variable")
    expect(resolveCaptureName("foo.bar", custom)).toBe("keyword")
    expect(resolveCaptureName("foo.baz", custom)).toBe("variable")
  })
})

describe("buildLegend", () => {
  it("deduplicates token types", () => {
    const mapping = { a: "keyword", b: "keyword", c: "string" }
    const { tokenTypes } = buildLegend(mapping)
    expect(tokenTypes).toEqual(["keyword", "string"])
  })

  it("builds correct index map", () => {
    const mapping = { a: "keyword", b: "string", c: "number" }
    const { tokenTypes, tokenTypeIndex } = buildLegend(mapping)
    expect(tokenTypes).toEqual(["keyword", "string", "number"])
    expect(tokenTypeIndex.get("keyword")).toBe(0)
    expect(tokenTypeIndex.get("string")).toBe(1)
    expect(tokenTypeIndex.get("number")).toBe(2)
  })

  it("handles empty mapping", () => {
    const { tokenTypes, tokenTypeIndex } = buildLegend({})
    expect(tokenTypes).toEqual([])
    expect(tokenTypeIndex.size).toBe(0)
  })

  it("handles default mapping", () => {
    const { tokenTypes, tokenTypeIndex } = buildLegend(DEFAULT_CAPTURE_MAPPING)
    expect(tokenTypes.length).toBeGreaterThan(0)
    // All unique Monaco types should be present
    const uniqueTypes = new Set(Object.values(DEFAULT_CAPTURE_MAPPING))
    expect(tokenTypes.length).toBe(uniqueTypes.size)
    // Index should map back correctly
    for (const [i, type] of tokenTypes.entries()) {
      expect(tokenTypeIndex.get(type)).toBe(i)
    }
  })

  it("preserves insertion order", () => {
    const mapping = { z: "type", a: "function", m: "variable" }
    const { tokenTypes } = buildLegend(mapping)
    expect(tokenTypes).toEqual(["type", "function", "variable"])
  })
})

describe("DEFAULT_CAPTURE_MAPPING", () => {
  it("maps standard capture names", () => {
    expect(DEFAULT_CAPTURE_MAPPING.comment).toBe("comment")
    expect(DEFAULT_CAPTURE_MAPPING.string).toBe("string")
    expect(DEFAULT_CAPTURE_MAPPING.keyword).toBe("keyword")
    expect(DEFAULT_CAPTURE_MAPPING.number).toBe("number")
    expect(DEFAULT_CAPTURE_MAPPING.function).toBe("function")
    expect(DEFAULT_CAPTURE_MAPPING.variable).toBe("variable")
    expect(DEFAULT_CAPTURE_MAPPING.type).toBe("type")
    expect(DEFAULT_CAPTURE_MAPPING.operator).toBe("operator")
    expect(DEFAULT_CAPTURE_MAPPING.property).toBe("property")
  })

  it("maps dotted capture names", () => {
    expect(DEFAULT_CAPTURE_MAPPING["string.regex"]).toBe("regexp")
    expect(DEFAULT_CAPTURE_MAPPING["function.method"]).toBe("method")
    expect(DEFAULT_CAPTURE_MAPPING["variable.parameter"]).toBe("parameter")
    expect(DEFAULT_CAPTURE_MAPPING["keyword.directive"]).toBe("macro")
  })
})
