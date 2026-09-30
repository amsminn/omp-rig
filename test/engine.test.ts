import { afterEach, describe, expect, test } from "bun:test"
import type { Model, ModelKind } from "@oh-my-pi/pi-catalog/types"
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking"
import { MODEL_ROLES } from "@oh-my-pi/pi-coding-agent/config/model-roles"
import {
  cfgDisabledProviders,
  cfgEnabledModels,
  cfgModelRoles,
} from "@oh-my-pi/pi-coding-agent/config/model-settings"
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyRig,
  drift,
  effectivePool,
  inherit,
  reconcile,
  turnOff,
  type EngineEnvironment,
  type EngineStore,
} from "../src/engine"
import { captureBaseline, maskRoles, resolveHandles, type HostHandles } from "../src/host"
import type { Rig } from "../src/rig-file"
import { readMarkers, setMarker, type RigSource, type ScopeEnvironment } from "../src/scope"
import type { ProfileSource } from "../src/store"
import { validateRig } from "../src/validate"

// allow: SIZE_OK — the plan requires the full engine behavior matrix in this single test file.
const CHAT_A = model("p1", "a")
const CHAT_B = model("p1", "b")
const CHAT_C = model("p2", "c")
const CHAT_D = model("p3", "d")
const IMAGE = model("images", "artist", "image")

function model(provider: string, id: string, kind?: ModelKind): Model {
  return {
    id,
    ...(kind === undefined ? {} : { kind }),
    identity: { class: `${provider}-${kind ?? "chat"}` },
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: null,
    maxTokens: null,
    compat: undefined,
  }
}

class FakeRegistry {
  readonly #models: readonly Model[]
  readonly #authenticated: ReadonlySet<string>
  readonly #settings: Settings

  constructor(settings: Settings, models: readonly Model[] = [CHAT_A, CHAT_B, CHAT_C, CHAT_D, IMAGE]) {
    this.#settings = settings
    this.#models = models
    this.#authenticated = new Set(models.map(entry => `${entry.provider}/${entry.id}`))
  }

  getAll(kind: ModelKind | "all" = "chat"): Model[] {
    if (kind === "all") return [...this.#models]
    return this.#models.filter(entry => (entry.kind ?? "chat") === kind)
  }

  getAvailable(): Model[] {
    const disabled = new Set(cfgDisabledProviders.get(this.#settings))
    return this.getAll().filter(entry => !disabled.has(entry.provider))
  }

  find(provider: string, id: string): Model | undefined {
    return this.getAvailable().find(entry => entry.provider === provider && entry.id === id)
  }

  hasConfiguredAuth(entry: Model): boolean {
    return this.#authenticated.has(`${entry.provider}/${entry.id}`)
  }
}

type Harness = Readonly<{
  env: EngineEnvironment
  handles: HostHandles
  settings: Settings
  scope: ScopeEnvironment
  entries: unknown[]
  calls: {
    models: Model[]
    levels: string[]
  }
  session: {
    model: Model | undefined
    level: ThinkingLevel | undefined
    setModelResult: "ok" | "false" | "reject"
  }
}>

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(
  rigs: Readonly<Record<string, Rig>>,
  options: Readonly<{
    globalRoles?: Readonly<Record<string, string>>
    runtimeRoles?: Readonly<Record<string, string>>
    baselineLevel?: Harness["session"]["level"]
    argv?: readonly string[]
  }> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "omp-rig-engine-"))
  roots.push(root)
  const settings = Settings.isolated()
  cfgModelRoles.set(settings, options.globalRoles ?? { default: "p3/d" })
  if (options.runtimeRoles !== undefined) cfgModelRoles.override(settings, options.runtimeRoles)
  const handles = await resolveHandles()
  const entries: unknown[] = []
  const scope: ScopeEnvironment = {
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
    getBranch: () => entries,
    appendEntry: <T>(customType: string, data: T) => {
      entries.push({ type: "custom", customType, data })
    },
  }
  const calls = { models: [] as Model[], levels: [] as string[] }
  const session: Harness["session"] = {
    model: CHAT_D as Model | undefined,
    level: options.baselineLevel ?? ThinkingLevel.Low,
    setModelResult: "ok" as "ok" | "false" | "reject",
  }
  const store: EngineStore = {
    read: async name => {
      const candidate = rigs[name]
      if (candidate === undefined) throw new Error(`rig "${name}" not found`)
      return candidate
    },
    listProfiles: async (): Promise<readonly ProfileSource[]> => [],
  }
  const registry = new FakeRegistry(settings)
  const env: EngineEnvironment = {
    pi: {
      appendEntry: scope.appendEntry,
      getThinkingLevel: () => session.level,
      setThinkingLevel: level => {
        session.level = level
        calls.levels.push(level)
      },
      setModel: async entry => {
        calls.models.push(entry)
        if (session.setModelResult === "reject") throw new Error("setModel rejected")
        if (session.setModelResult === "false") return false
        session.model = entry
        return true
      },
    },
    ctx: {
      get model() {
        return session.model
      },
      modelRegistry: registry,
    },
    settings,
    handles,
    store,
    scope,
    argv: options.argv ?? [],
  }
  return { env, handles, settings, scope, entries, calls, session }
}

const RIG_A: Rig = {
  modelRoles: { default: "p1/a:high", smol: "p1/b", custom: "p1/b" },
  enabledModels: ["p1/*"],
}
const RIG_B: Rig = {
  modelRoles: { default: "p2/c" },
  enabledModels: ["p2/*"],
}

function source(name: string): RigSource {
  return { kind: "rig", name }
}

function state(settings: Settings): unknown {
  return {
    roles: settings.getModelRoles(),
    enabled: cfgEnabledModels.get(settings),
    disabled: cfgDisabledProviders.get(settings),
    provenances: [
      settings.getProvenance(cfgModelRoles),
      settings.getProvenance(cfgEnabledModels),
      settings.getProvenance(cfgDisabledProviders),
    ],
  }
}

describe("effectivePool", () => {
  test("derives blocked providers and reports model-level enforcement", async () => {
    const { env } = await harness({})

    const pool = effectivePool(
      { modelRoles: { default: "p1/a" }, enabledModels: ["p1/a"] },
      env.ctx.modelRegistry,
    )

    expect(pool).toEqual({
      enabledModels: ["p1/a"],
      disabledProviders: ["p2", "p3"],
      providerGranular: true,
    })
  })

  test("keeps runtime-owned providers and models at startup", async () => {
    const { env } = await harness({})

    const pool = effectivePool(RIG_A, env.ctx.modelRegistry, { smol: "p2/c" })

    expect(pool.enabledModels).toEqual(["p1/*", "p2/c"])
    expect(pool.disabledProviders).not.toContain("p2")
  })
})

describe("transactional apply", () => {
  test("switches A to B without retaining A-only roles or pool values", async () => {
    const { env, settings } = await harness({ a: RIG_A, b: RIG_B })

    expect((await applyRig(source("a"), "session", env)).ok).toBe(true)
    expect((await applyRig(source("b"), "session", env)).ok).toBe(true)

    const roles = settings.getModelRoles()
    expect(roles.custom).toBe("p2/c")
    expect(cfgEnabledModels.get(settings)).toEqual(["p2/*"])
    expect(cfgDisabledProviders.get(settings)).toEqual(["p1", "p3"])
  })

  test("sets the exact default model and its thinking suffix", async () => {
    const { env, calls } = await harness({ a: RIG_A })

    await applyRig(source("a"), "session", env)

    expect(calls.models.at(-1)).toBe(CHAT_A)
    expect(calls.levels.at(-1)).toBe("high")
  })

  test("rejects invalid or incomplete rigs without changing state", async () => {
    const invalid: Rig = { modelRoles: { smol: "missing/nope" } }
    const { env, settings, entries, calls } = await harness({ invalid })
    const before = structuredClone(state(settings))

    const result = await applyRig(source("invalid"), "session", env)

    expect(result.ok).toBe(false)
    expect(state(settings)).toEqual(before)
    expect(entries).toEqual([])
    expect(calls.models).toEqual([])
  })

  test('a rig with a role on p2 but enabledModels ["p1/*"] fails validation, and nothing changes', async () => {
    const outsidePool: Rig = {
      modelRoles: { default: "p1/a", smol: "p2/c" },
      enabledModels: ["p1/*"],
    }
    const item = await harness({ outsidePool })
    const settingsBefore = structuredClone(state(item.settings))
    const markersBefore = await readMarkers(item.scope)
    const modelBefore = item.session.model
    const levelBefore = item.session.level

    const result = await applyRig(source("outsidePool"), "session", item.env)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected outside-pool validation to fail")
    expect(result.errors).toContain("model p2/c for role smol is outside this rig's pool")
    expect(state(item.settings)).toEqual(settingsBefore)
    expect(await readMarkers(item.scope)).toEqual(markersBefore)
    expect(item.session.model).toBe(modelBefore)
    expect(item.session.level).toBe(levelBefore)
  })

  test.each(["false", "reject"] as const)(
    "rolls back settings, marker, model and thinking when setModel returns %s",
    async failure => {
      const item = await harness({ a: RIG_A })
      const before = structuredClone(state(item.settings))
      item.session.setModelResult = failure

      const result = await applyRig(source("a"), "session", item.env)

      expect(result.ok).toBe(false)
      expect(state(item.settings)).toEqual(before)
      expect(item.entries).toEqual([])
      expect(item.session.model).toBe(CHAT_D)
      expect(item.session.level).toBe(ThinkingLevel.Low)
    },
  )

  test("rejects a conflicting --models pin before any mutation", async () => {
    const restricted: Rig = {
      modelRoles: { default: "p1/a" },
      enabledModels: ["p1/a"],
    }
    const item = await harness({ a: restricted }, { argv: ["omp", "--models", "p1/b"] })
    const before = structuredClone(state(item.settings))

    const result = await applyRig(source("a"), "session", item.env)

    expect(result).toMatchObject({
      ok: false,
      errors: ['rig "a" restricts models but omp was started with --models p1/b; restart without --models'],
    })
    expect(state(item.settings)).toEqual(before)
    expect(item.calls.models).toEqual([])
    expect(item.entries).toEqual([])
  })

  test("allows a --models pin covered by the rig pool", async () => {
    const restricted: Rig = {
      modelRoles: { default: "p1/a" },
      enabledModels: ["p1/a"],
    }
    const item = await harness({ a: restricted }, { argv: ["omp", "--models=p1/a"] })

    const result = await applyRig(source("a"), "session", item.env)

    expect(result.ok).toBe(true)
  })

  test("switches between providers disabled by the current rig", async () => {
    const a: Rig = { modelRoles: { default: "p1/a" }, disabledProviders: ["p2"] }
    const b: Rig = { modelRoles: { default: "p2/c" }, enabledModels: ["p2/*"] }
    const item = await harness({ a, b })

    expect((await applyRig(source("a"), "session", item.env)).ok).toBe(true)
    expect(item.env.ctx.modelRegistry.find?.("p2", "c")).toBeUndefined()
    expect((await applyRig(source("b"), "session", item.env)).ok).toBe(true)
    expect((await applyRig(source("a"), "session", item.env)).ok).toBe(true)
  })
})

describe("role masking", () => {
  test("masks every chat role from empty settings and excludes non-chat roles", async () => {
    const item = await harness({ plain: { modelRoles: { default: "p1/a" } } }, {
      globalRoles: {},
    })

    await applyRig(source("plain"), "session", item.env)

    const roles = item.settings.getModelRoles()
    expect(roles.advisor).toBe("p1/a")
    for (const [role, definition] of Object.entries(MODEL_ROLES)) {
      const acceptsChat = definition.accepts(CHAT_A)
      expect(Object.hasOwn(roles, role)).toBe(acceptsChat)
    }
  })

  test("preserves configured non-chat roles unless the rig assigns one", async () => {
    const plain: Rig = { modelRoles: { default: "p1/a" } }
    const explicit: Rig = { modelRoles: { default: "p1/a", image: "images/artist" } }
    const item = await harness({ plain, explicit }, {
      globalRoles: { default: "p3/d", image: "images/artist" },
    })

    expect((await applyRig(source("plain"), "session", item.env)).ok).toBe(true)
    expect(item.settings.getModelRoles().image).toBe("images/artist")
    expect((await applyRig(source("explicit"), "session", item.env)).ok).toBe(true)
    expect(item.settings.getModelRoles().image).toBe("images/artist")
  })

  test("rejects a chat model assigned to a non-chat role", async () => {
    const wrong: Rig = { modelRoles: { default: "p1/a", image: "p1/b" } }
    const item = await harness({ wrong })
    const before = structuredClone(state(item.settings))

    const result = await applyRig(source("wrong"), "session", item.env)

    expect(result.ok).toBe(false)
    expect(state(item.settings)).toEqual(before)
  })
})

describe("reconcile, off and drift", () => {
  test("applies a project marker when the session has no marker", async () => {
    const item = await harness({ a: RIG_A })
    await setMarker("project", source("a"), item.scope)

    const result = await reconcile(item.env)

    expect(result.ok).toBe(true)
    expect(item.settings.getModelRoles().default).toBe("p1/a:high")
  })

  test("detects direct runtime edits after apply", async () => {
    const item = await harness({ a: RIG_A })
    await applyRig(source("a"), "session", item.env)
    item.handles.modelRoles.override(item.settings, {
      ...item.settings.getModelRoles(),
      smol: "p2/c",
    })

    const changed = await drift(item.env)

    expect(changed).toContain("smol")
  })

  test("turning off restores global values and baseline thinking", async () => {
    const item = await harness({ a: RIG_A }, { baselineLevel: ThinkingLevel.Low })
    const before = structuredClone(state(item.settings))
    await applyRig(source("a"), "session", item.env)

    await turnOff("session", item.env)

    expect(state(item.settings)).toEqual(before)
    expect(item.calls.models.at(-1)).toBe(CHAT_D)
    expect(item.calls.levels.at(-1)).toBe("low")
  })

  test("inherit clears the selected marker and applies the lower scope", async () => {
    const item = await harness({ a: RIG_A, b: RIG_B })
    await setMarker("global", source("b"), item.scope)
    await applyRig(source("a"), "project", item.env)

    await inherit("project", item.env)

    expect(item.settings.getModelRoles().default).toBe("p2/c")
    expect((await readMarkers(item.scope)).project).toEqual({ kind: "missing" })
  })

  test("branch cleanup restores the underlying model and thinking", async () => {
    const item = await harness({ a: RIG_A }, { baselineLevel: ThinkingLevel.Low })
    await applyRig(source("a"), "session", item.env)
    item.entries.splice(0)

    await reconcile(item.env)

    expect(item.calls.models.at(-1)).toBe(CHAT_D)
    expect(item.calls.levels.at(-1)).toBe("low")
  })

  test("startup without a marker leaves runtime roles byte-identical", async () => {
    const item = await harness({}, { runtimeRoles: { smol: "p2/c" } })
    const before = structuredClone(state(item.settings))

    const result = await reconcile(item.env, {
      startup: true,
      runtimeOwned: { smol: "p2/c" },
    })

    expect(result.ok).toBe(true)
    expect(state(item.settings)).toEqual(before)
  })

  test("startup keeps runtime roles, expands the pool and reports drift", async () => {
    const item = await harness({ a: RIG_A }, { runtimeRoles: { smol: "p2/c" } })

    const result = await reconcile(item.env, {
      startup: true,
      runtimeOwned: { smol: "p2/c" },
      flagRig: "a",
    })

    expect(result.ok).toBe(true)
    expect(item.settings.getModelRoles().smol).toBe("p2/c")
    expect(cfgEnabledModels.get(item.settings)).toEqual(["p1/*", "p2/c"])
    expect(cfgDisabledProviders.get(item.settings)).not.toContain("p2")
    expect(result.drift).toContain("smol")
  })

  test("startup runtime default skips setModel and reports drift", async () => {
    const item = await harness({ a: RIG_A }, { runtimeRoles: { default: "p3/d" } })

    const result = await reconcile(item.env, {
      startup: true,
      runtimeOwned: { default: "p3/d" },
      flagRig: "a",
    })

    expect(result.ok).toBe(true)
    expect(item.settings.getModelRoles().default).toBe("p3/d")
    expect(item.calls.models).toEqual([])
    expect(result.drift).toContain("default")
  })

  test.each(["false", "reject"] as const)(
    "startup flag remains atomic when setModel returns %s",
    async failure => {
      const item = await harness({ a: RIG_A })
      const before = structuredClone(state(item.settings))
      item.session.setModelResult = failure

      const result = await reconcile(item.env, { startup: true, runtimeOwned: {}, flagRig: "a" })

      expect(result.ok).toBe(false)
      expect(state(item.settings)).toEqual(before)
      expect(item.entries).toEqual([])
      expect(item.session.model).toBe(CHAT_D)
      expect(item.session.level).toBe(ThinkingLevel.Low)
    },
  )

  test("an invalid startup marker warns without touching CLI roles", async () => {
    const invalid: Rig = { modelRoles: { default: "missing/nope" } }
    const item = await harness({ invalid }, { runtimeRoles: { smol: "p2/c" } })
    await setMarker("project", source("invalid"), item.scope)
    const before = structuredClone(state(item.settings))

    const result = await reconcile(item.env, {
      startup: true,
      runtimeOwned: { smol: "p2/c" },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected invalid startup marker to fail")
    expect(result.warnings).not.toEqual([])
    expect(state(item.settings)).toEqual(before)
  })
})

test("validate and baseline capture are non-mutating", async () => {
  const item = await harness({ a: RIG_A })
  const before = structuredClone(state(item.settings))

  captureBaseline(item.settings, item.handles, item.session.level)
  maskRoles(item.settings)
  await applyRig(source("missing"), "session", item.env)

  expect(state(item.settings)).toEqual(before)
})

test("validateRig leaves settings deep-equal before and after", async () => {
  const item = await harness({})
  const before = structuredClone(state(item.settings))
  const problematic: Rig = {
    modelRoles: { default: "missing/nope", image: "p1/a" },
    enabledModels: ["missing/*"],
    disabledProviders: ["p1"],
  }

  const problematicResult = validateRig(problematic, item.env.ctx.modelRegistry)

  expect(problematicResult.ok).toBe(false)
  expect(problematicResult.errors.length).toBeGreaterThan(1)
  expect(state(item.settings)).toEqual(before)

  const validResult = validateRig(RIG_A, item.env.ctx.modelRegistry)

  expect(validResult.ok).toBe(true)
  expect(state(item.settings)).toEqual(before)
})
