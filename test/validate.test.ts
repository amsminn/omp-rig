import { describe, expect, test } from "bun:test"
import { modelKind, type Model, type ModelKind } from "@oh-my-pi/pi-catalog/types"
import type { Rig } from "../src/rig-file"
import { healthOf, type RigHealth, validateRig } from "../src/validate"

const CHAT_A = model("p1", "chat-a", "chat-family")
const CHAT_B = model("p2", "chat-b", "chat-family")
const PRIVATE = model("p3", "private", "private-family")
const SWITCHED = model("p4", "switched", "switch-family")
const IMAGE = model("images", "artist", "image-family", "image")

function model(provider: string, id: string, family: string, kind?: ModelKind): Model {
  return {
    id,
    ...(kind === undefined ? {} : { kind }),
    identity: { class: family },
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: null,
    maxTokens: null,
    compat: undefined,
  }
}

class FakeRegistry {
  readonly #models: readonly Model[]
  readonly #authenticated: ReadonlySet<string>
  readonly #disabledProviders: ReadonlySet<string>

  constructor(
    models: readonly Model[],
    authenticated: readonly Model[],
    disabledProviders: readonly string[] = [],
  ) {
    this.#models = models
    this.#authenticated = new Set(authenticated.map(entry => `${entry.provider}/${entry.id}`))
    this.#disabledProviders = new Set(disabledProviders)
  }

  getAll(kind: ModelKind | "all" = "chat"): Model[] {
    if (kind === "all") return [...this.#models]
    return this.#models.filter(entry => modelKind(entry) === kind)
  }

  find(provider: string, id: string): Model | undefined {
    if (this.#disabledProviders.has(provider)) return undefined
    return this.#models.find(entry => entry.provider === provider && entry.id === id)
  }

  hasConfiguredAuth(entry: Model): boolean {
    return this.#authenticated.has(`${entry.provider}/${entry.id}`)
  }
}

function rig(
  modelRoles: Readonly<Record<string, string>>,
  options: Readonly<Pick<Rig, "enabledModels" | "disabledProviders">> = {},
): Rig {
  return { modelRoles, ...options }
}

describe("validateRig", () => {
  test("reports every distinct validation problem in one result", () => {
    // Given
    const registry = new FakeRegistry(
      [CHAT_A, PRIVATE],
      [CHAT_A],
    )
    const candidate = rig(
      {
        default: "missing/nope",
        smol: "p3/private",
      },
      { enabledModels: ["none/*"] },
    )

    // When
    const result = validateRig(candidate, registry)

    // Then
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.errors.map(error => error.code)).toEqual([
      "unknown-model",
      "missing-credentials",
      "empty-pool",
    ])
  })

  test("suggests an authenticated model for an unknown id in the same family", () => {
    // Given
    const registry = new FakeRegistry([CHAT_A], [CHAT_A])

    // When
    const result = validateRig(rig({ default: "p1/chat-a-latest" }), registry)

    // Then
    expect(result.errors).toEqual([{
      code: "unknown-model",
      role: "default",
      model: "p1/chat-a-latest",
      suggestion: "p1/chat-a",
      message: "unknown model p1/chat-a-latest for role default; try p1/chat-a",
    }])
  })

  test("validates an authenticated model hidden by current disabled providers", () => {
    // Given
    const registry = new FakeRegistry([SWITCHED], [SWITCHED], ["p4"])
    expect(registry.find("p4", "switched")).toBeUndefined()

    // When
    const result = validateRig(rig({ default: "p4/switched" }), registry)

    // Then
    expect(result).toEqual({
      ok: true,
      errors: [],
      models: { default: SWITCHED },
    })
  })

  test("accepts an authenticated non-chat model for its matching role", () => {
    // Given
    const registry = new FakeRegistry([CHAT_A, IMAGE], [CHAT_A, IMAGE])
    expect(registry.getAll()).not.toContain(IMAGE)

    // When
    const result = validateRig(
      rig({
        default: "p1/chat-a",
        image: "images/artist",
      }),
      registry,
    )

    // Then
    expect(result).toEqual({
      ok: true,
      errors: [],
      models: {
        default: CHAT_A,
        image: IMAGE,
      },
    })
  })

  test.each([
    ["image", "p1/chat-a", "chat", "image"],
    ["default", "images/artist", "image", "chat"],
  ])(
    "rejects a %s role assigned a %s model",
    (role, spec, actualKind, expectedKind) => {
      // Given
      const registry = new FakeRegistry([CHAT_A, IMAGE], [CHAT_A, IMAGE])

      // When
      const result = validateRig(rig({ default: "p1/chat-a", [role]: spec }), registry)

      // Then
      expect(result.errors).toContainEqual({
        code: "kind-mismatch",
        role,
        model: spec,
        message: `${role} does not accept ${actualKind} model ${spec}; expected ${expectedKind}`,
      })
    },
  )

  test("treats an unknown custom role as chat-only", () => {
    // Given
    const registry = new FakeRegistry([CHAT_A, IMAGE], [CHAT_A, IMAGE])

    // When
    const result = validateRig(
      rig({
        default: "p1/chat-a",
        custom: "images/artist",
      }),
      registry,
    )

    // Then
    expect(result.errors.map(error => error.code)).toContain("kind-mismatch")
  })

  test("reports a role whose model is outside its own pool", () => {
    // Given
    const registry = new FakeRegistry([CHAT_A, CHAT_B], [CHAT_A, CHAT_B])

    // When
    const result = validateRig(
      rig(
        {
          default: "p1/chat-a",
          slow: "p2/chat-b",
        },
        { enabledModels: ["p1/*"] },
      ),
      registry,
    )

    // Then
    expect(result.errors).toContainEqual({
      code: "outside-pool",
      role: "slow",
      model: "p2/chat-b",
      message: "model p2/chat-b for role slow is outside this rig's pool",
    })
  })

  test("reports a role whose provider is blocked by its own rig", () => {
    // Given
    const registry = new FakeRegistry([CHAT_A], [CHAT_A])

    // When
    const result = validateRig(
      rig({ default: "p1/chat-a" }, { disabledProviders: ["p1"] }),
      registry,
    )

    // Then
    expect(result.errors.map(error => error.code)).toContain("outside-pool")
  })

  test("requires pool patterns to match an authenticated chat model", () => {
    // Given
    const registry = new FakeRegistry([PRIVATE, IMAGE], [IMAGE])

    // When
    const result = validateRig(
      rig(
        { default: "p3/private" },
        { enabledModels: ["p3/*", "images/*"] },
      ),
      registry,
    )

    // Then
    expect(result.errors).toContainEqual({
      code: "empty-pool",
      pattern: "p3/*",
      message: "pool pattern p3/* matches no authenticated chat model",
    })
    expect(result.errors).toContainEqual({
      code: "empty-pool",
      pattern: "images/*",
      message: "pool pattern images/* matches no authenticated chat model",
    })
  })
})

describe("healthOf", () => {
  const cases = [
    ["ok", rig({ default: "p1/chat-a" })],
    ["missing-credentials", rig({ default: "p3/private" })],
    ["unknown-model", rig({ default: "missing/nope" })],
    ["empty-pool", rig({ default: "p1/chat-a" }, { enabledModels: ["none/*"] })],
  ] satisfies readonly (readonly [RigHealth, Rig])[]

  test.each(cases)("returns %s for the corresponding validation result", (expected, candidate) => {
    // Given
    const registry = new FakeRegistry([CHAT_A, PRIVATE], [CHAT_A])

    // When
    const health = healthOf(candidate, registry)

    // Then
    expect(health).toBe(expected)
  })
})
