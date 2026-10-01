import { describe, expect, test } from "bun:test"
import {
  parseModelSpec,
  parseRig,
  serializeRig,
  validateRigName,
} from "../src/rig-file"

describe("parseRig", () => {
  test("returns a rig when every supported field is valid", () => {
    const text = `description: Chinese models only
modelRoles:
  default: inferhub/glm-5.3-flash:high
  smol: inferhub/deepseek-v4.1-flash:low
enabledModels:
  - inferhub/*
disabledProviders:
  - anthropic
`

    const result = parseRig(text, "cn.yml")

    expect(result).toEqual({
      ok: true,
      rig: {
        description: "Chinese models only",
        modelRoles: {
          default: "inferhub/glm-5.3-flash:high",
          smol: "inferhub/deepseek-v4.1-flash:low",
        },
        enabledModels: ["inferhub/*"],
        disabledProviders: ["anthropic"],
      },
    })
  })

  test.each(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"])(
    "accepts the %s thinking level",
    (level) => {
      const result = parseRig(`modelRoles:\n  default: provider/model:${level}\n`, "levels.yml")

      expect(result.ok).toBe(true)
    },
  )

  test("rejects a missing modelRoles map", () => {
    const result = parseRig("description: no roles\n", "missing.yml")

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "modelRoles", message: "modelRoles is required" }],
    })
  })

  test("rejects an empty modelRoles map", () => {
    const result = parseRig("modelRoles: {}\n", "empty.yml")

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "modelRoles", message: "modelRoles must be a non-empty record" }],
    })
  })

  test("rejects modelRoles without default", () => {
    const result = parseRig("modelRoles:\n  smol: p/m\n", "no-default.yml")

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "modelRoles.default", message: "default model role is required" }],
    })
  })

  test.each([
    ["modelRoles", "modelRoles: []\n", "modelRoles must be a non-empty record"],
    ["modelRoles.default", "modelRoles:\n  default: ''\n", "model role must be a non-empty string"],
    ["modelRoles.smol", "modelRoles:\n  default: p/m\n  smol: 42\n", "model role must be a non-empty string"],
    ["enabledModels", "modelRoles:\n  default: p/m\nenabledModels: p/*\n", "enabledModels must be an array of strings"],
    [
      "disabledProviders.1",
      "modelRoles:\n  default: p/m\ndisabledProviders: [p, 2]\n",
      "disabledProviders entries must be strings",
    ],
    ["description", "modelRoles:\n  default: p/m\ndescription: 42\n", "description must be a string"],
  ])("rejects an invalid %s value", (path, text, message) => {
    const result = parseRig(text, "invalid.yml")

    expect(result).toEqual({ ok: false, errors: [{ path, message }] })
  })

  test("rejects descriptions longer than 120 characters", () => {
    const result = parseRig(
      `modelRoles:\n  default: p/m\ndescription: ${"x".repeat(121)}\n`,
      "description.yml",
    )

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "description", message: "description must be at most 120 characters" }],
    })
  })

  test("rejects unknown top-level keys by name", () => {
    const result = parseRig("modelRoles:\n  default: p/m\nmodels: []\n", "unknown.yml")

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "models", message: "unknown top-level key: models" }],
    })
  })

  test.each(["provider/", "/model", "provider model", "provider/model "])(
    "rejects the invalid role spec %s",
    (spec) => {
      const result = parseRig(`modelRoles:\n  default: '${spec}'\n`, "spec.yml")

      expect(result).toEqual({
        ok: false,
        errors: [{
          path: "modelRoles.default",
          message: "model role must use provider/model[:level]",
        }],
      })
    },
  )

  test("reports a line for malformed YAML", () => {
    const result = parseRig("modelRoles:\n  default: [\n", "broken.yml")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("broken.yml")
      expect(result.errors[0]?.line).toBeNumber()
    }
  })
})

describe("parseModelSpec", () => {
  test("splits only a trailing known thinking level", () => {
    expect(parseModelSpec("provider/model:xhigh")).toEqual({
      model: "provider/model",
      level: "xhigh",
    })
  })

  test("treats an unknown trailing segment as part of the model id", () => {
    expect(parseModelSpec("provider/model:none")).toEqual({
      model: "provider/model:none",
    })
  })
})

describe("serializeRig", () => {
  test("uses stable key order and round-trips to the same rig", () => {
    const rig = {
      description: "A rig",
      modelRoles: {
        default: "provider/main:high",
        smol: "provider/small:minimal",
      },
      enabledModels: ["provider/*"],
      disabledProviders: ["other"],
    }

    const serialized = serializeRig(rig)
    const result = parseRig(serialized, "round-trip.yml")

    expect([
      serialized.indexOf("description"),
      serialized.indexOf("modelRoles"),
      serialized.indexOf("enabledModels"),
      serialized.indexOf("disabledProviders"),
    ]).toEqual([...serialized.matchAll(/description|modelRoles|enabledModels|disabledProviders/g)].map(
      (match) => match.index,
    ))
    expect(result).toEqual({ ok: true, rig })
  })
})

describe("validateRigName", () => {
  test.each([
    "new",
    "edit",
    "update",
    "rename",
    "duplicate",
    "clone",
    "delete",
    "rm",
    "remove",
    "off",
    "clear",
    "default",
    "list",
    "show",
    "current",
    "diff",
    "next",
    "prev",
    "doctor",
    "import",
    "export",
    "help",
    "save",
    "apply",
  ])("rejects the reserved name %s", (name) => {
    expect(validateRigName(name)).toEqual({
      path: "name",
      message: `reserved rig name: ${name}`,
    })
  })

  test.each(["Upper", "-leading", "two words", "a".repeat(65)])(
    "rejects the invalid name %s",
    (name) => {
      expect(validateRigName(name)?.path).toBe("name")
    },
  )

  test("accepts a lowercase name within 64 characters", () => {
    expect(validateRigName("cn.fast_1")).toBeUndefined()
  })
})

describe("rig file writing", () => {
  test("writes block-style YAML that reads back unchanged", () => {
    const rig = {
      description: "Claude for everyday work",
      modelRoles: { default: "anthropic/claude-sonnet-4-5:medium", smol: "anthropic/claude-haiku-4-5:low" },
      enabledModels: ["anthropic/*"],
    }

    const text = serializeRig(rig)

    expect(text).toBe([
      "description: Claude for everyday work",
      "modelRoles:",
      "  default: anthropic/claude-sonnet-4-5:medium",
      "  smol: anthropic/claude-haiku-4-5:low",
      "enabledModels:",
      "  - anthropic/*",
      "",
    ].join("\n"))
    const parsed = parseRig(text, "cc.yml")
    expect(parsed.ok && parsed.rig).toEqual(rig)
  })
})
