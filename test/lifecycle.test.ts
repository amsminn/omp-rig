import { afterEach, describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent"
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"
import { type EngineResult } from "../src/engine"
import { resolveHandles } from "../src/host"
import {
  omprig,
  type LifecycleDependencies,
} from "../src/index"

type ReconcileOptions = NonNullable<
  Parameters<LifecycleDependencies["reconcile"]>[1]
>

type EventName =
  | "session_start"
  | "session_switch"
  | "session_branch"
  | "session_tree"
  | "session_shutdown"

type Handler = (
  event: unknown,
  ctx: ExtensionContext,
) => void | Promise<void>

type Harness = Readonly<{
  pi: ExtensionAPI
  context: ExtensionContext
  handlers: ReadonlyMap<EventName, Handler>
  calls: {
    labels: string[]
    flags: Array<Readonly<{ name: string; options: unknown }>>
    flagReads: string[]
    reconciles: Array<ReconcileOptions>
    runtimeOwned: number
    statuses: Array<string | undefined>
    notifications: Array<Readonly<{ message: string; level: string | undefined }>>
  }
  trigger: (event: EventName, context?: ExtensionContext) => Promise<void>
  subagentContext: () => ExtensionContext
  acpContext: () => ExtensionContext
}>

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.trigger("session_shutdown")
  }
})

function success(
  source: Readonly<{ kind: "rig" | "profile"; name: string }> | null,
  drift: readonly string[] = [],
): EngineResult {
  return {
    ok: true,
    summary: source === null ? "default" : `${source.kind}: ${source.name}`,
    source,
    drift,
  }
}

function failure(message: string): EngineResult {
  return {
    ok: false,
    errors: [message],
    warnings: [],
    drift: [],
  }
}

async function createHarness(
  options: Readonly<{
    flag?: string
    results?: readonly EngineResult[]
  }> = {},
): Promise<Harness> {
  const settings = Settings.isolated()
  const handles = await resolveHandles()
  const handlers = new Map<EventName, Handler>()
  const results = [...(options.results ?? [success(null)])]
  const calls: Harness["calls"] = {
    labels: [],
    flags: [],
    flagReads: [],
    reconciles: [],
    runtimeOwned: 0,
    statuses: [],
    notifications: [],
  }

  const ui = {
    setStatus: (_key: string, value: string | undefined) => {
      calls.statuses.push(value)
    },
    notify: (message: string, level?: string) => {
      calls.notifications.push({ message, level })
    },
  }
  const context = {
    ui,
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/rigqa-project",
    sessionManager: {
      getBranch: () => [],
    },
    modelRegistry: {},
    model: undefined,
    agent: {
      kind: "main",
      id: "main",
      name: "main",
      depth: 0,
    },
  } as unknown as ExtensionContext

  const pi = {
    pi: { settings },
    setLabel: (label: string) => {
      calls.labels.push(label)
    },
    registerFlag: (name: string, flagOptions: unknown) => {
      calls.flags.push({ name, options: flagOptions })
    },
    getFlag: (name: string) => {
      calls.flagReads.push(name)
      return options.flag
    },
    on: (event: EventName, handler: Handler) => {
      handlers.set(event, handler)
    },
    appendEntry: () => {},
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => {},
    setModel: async () => true,
  } as unknown as ExtensionAPI

  const dependencies: LifecycleDependencies = {
    resolveHandles: async () => handles,
    runtimeOwnedRoles: () => {
      calls.runtimeOwned += 1
      return { smol: "inferhub/glm-5.3" }
    },
    reconcile: async (_environment, reconcileOptions = {}) => {
      calls.reconciles.push(reconcileOptions)
      return results.shift() ?? success(null)
    },
    drift: async () => [],
    getSettings: () => settings,
    getAgentDir: () => "/tmp/rigqa-home/.omp/agent",
    store: {
      read: async name => {
        throw new Error(`rig "${name}" not found`)
      },
      listProfiles: async () => [],
    },
  }

  omprig(pi, dependencies)

  const harness: Harness = {
    pi,
    context,
    handlers,
    calls,
    trigger: async (event, selectedContext = context) => {
      const handler = handlers.get(event)
      if (handler === undefined) throw new Error(`${event} handler not registered`)
      await handler({ type: event }, selectedContext)
    },
    subagentContext: () => ({
      ...context,
      agent: {
        kind: "sub",
        id: "1-task",
        name: "task",
        depth: 1,
        parentId: "main",
      },
    }),
    acpContext: () => ({
      ...context,
      mode: "rpc",
      agent: {
        kind: "main",
        id: "acp:test-session",
        name: "main",
        depth: 0,
      },
    }),
  }
  harnesses.push(harness)
  return harness
}

describe("omp-rig lifecycle", () => {
  test("registers the label and string flag without a command", async () => {
    const harness = await createHarness()

    expect(harness.calls.labels).toEqual(["omp-rig"])
    expect(harness.calls.flags).toEqual([{
      name: "rig",
      options: {
        type: "string",
        description: "Apply a rig for this session",
      },
    }])
  })

  test("does nothing in a subagent session", async () => {
    const harness = await createHarness({ flag: "cn" })

    await harness.trigger("session_start", harness.subagentContext())

    expect(harness.calls.reconciles).toEqual([])
    expect(harness.calls.runtimeOwned).toBe(0)
    expect(harness.calls.flagReads).toEqual([])
    expect(harness.calls.statuses).toEqual([])
    expect(harness.calls.notifications).toEqual([])
  })

  test("applies the startup flag exactly once", async () => {
    const harness = await createHarness({
      flag: "cn",
      results: [
        success({ kind: "rig", name: "cn" }),
        success({ kind: "rig", name: "cn" }),
        success({ kind: "rig", name: "cn" }),
      ],
    })

    await harness.trigger("session_start")
    await harness.trigger("session_start")
    await harness.trigger("session_switch")

    expect(harness.calls.runtimeOwned).toBe(1)
    expect(harness.calls.flagReads).toEqual(["rig"])
    expect(harness.calls.reconciles).toEqual([
      {
        startup: true,
        runtimeOwned: { smol: "inferhub/glm-5.3" },
        flagRig: "cn",
      },
      {},
      {},
    ])
  })

  test("formats rig, profile, drift, and empty statuses", async () => {
    const harness = await createHarness({
      results: [
        success({ kind: "rig", name: "cn" }),
        success({ kind: "profile", name: "work" }, ["smol"]),
        success(null),
      ],
    })

    await harness.trigger("session_start")
    await harness.trigger("session_switch")
    await harness.trigger("session_branch")

    expect(harness.calls.statuses).toEqual([
      "rig: cn",
      "profile: work*",
      undefined,
    ])
  })

  test("normalizes a missing startup rig and keeps status empty", async () => {
    const harness = await createHarness({
      flag: "nope",
      results: [
        failure("ENOENT: no such file or directory, open '/tmp/rigqa-home/.omp/rigs/nope.yml'"),
      ],
    })

    await harness.trigger("session_start")

    expect(harness.calls.notifications).toEqual([{
      message: "rig \"nope\" not found",
      level: "error",
    }])
    expect(harness.calls.statuses).toEqual([undefined])
  })

  test("reports ACP once and performs no lifecycle work", async () => {
    const harness = await createHarness({ flag: "cn" })
    const context = harness.acpContext()

    await harness.trigger("session_start", context)
    await harness.trigger("session_switch", context)

    expect(harness.calls.reconciles).toEqual([])
    expect(harness.calls.statuses).toEqual([])
    expect(harness.calls.notifications).toEqual([{
      message: "omp-rig: ACP mode not supported",
      level: "warning",
    }])
  })
})
