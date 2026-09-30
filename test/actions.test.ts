import { describe, expect, test } from "bun:test"
import type { EngineResult } from "../src/engine"
import type { Rig } from "../src/rig-file"
import type { RigSource, ScopeMarkers } from "../src/scope"
import {
  buildActionItems,
  buildDetailLines,
  dispatchAction,
  type ActionRuntime,
} from "../src/ui/actions"

const RIG: Rig = {
  description: "Chinese models",
  modelRoles: {
    default: "inferhub/glm-5.3-flash:high",
    smol: "inferhub/deepseek-v4.1-flash:low",
  },
  enabledModels: ["inferhub/*"],
}

const MISSING_MARKERS: ScopeMarkers = {
  session: { kind: "missing" },
  project: { kind: "missing" },
  global: { kind: "missing" },
}

const SOURCE: RigSource = { kind: "rig", name: "cn" }

type Calls = {
  inputs: Array<Readonly<{ title: string; initial: string | undefined }>>
  confirmations: Array<Readonly<{ title: string; message: string }>>
  notifications: Array<Readonly<{
    message: string
    type: "info" | "warning" | "error" | undefined
  }>>
  applies: Array<Readonly<{ source: RigSource; scope: string }>>
  turnOffs: string[]
  inherits: string[]
  writes: Array<Readonly<{ name: string; rig: Rig }>>
  renames: Array<readonly [string, string]>
  duplicates: Array<readonly [string, string]>
  exports: Array<readonly [string, string]>
  removes: string[]
  edits: string[]
}

function success(summary = "ok"): EngineResult {
  return { ok: true, summary, source: SOURCE, drift: [] }
}

function failure(...errors: string[]): EngineResult {
  return { ok: false, errors, warnings: [], drift: [] }
}

function harness(options: Readonly<{
  source?: RigSource | null
  markers?: ScopeMarkers
  inputs?: readonly (string | undefined)[]
  confirms?: readonly boolean[]
  rigNames?: readonly string[]
  applyResult?: EngineResult
}> = {}): Readonly<{ runtime: ActionRuntime; calls: Calls }> {
  const inputResults = [...(options.inputs ?? [])]
  const confirmResults = [...(options.confirms ?? [])]
  const calls: Calls = {
    inputs: [],
    confirmations: [],
    notifications: [],
    applies: [],
    turnOffs: [],
    inherits: [],
    writes: [],
    renames: [],
    duplicates: [],
    exports: [],
    removes: [],
    edits: [],
  }
  const runtime: ActionRuntime = {
    ui: {
      input: async (title, initial) => {
        calls.inputs.push({ title, initial })
        return inputResults.shift()
      },
      confirm: async (title, message) => {
        calls.confirmations.push({ title, message })
        return confirmResults.shift() ?? false
      },
      notify: (message, type) => {
        calls.notifications.push({ message, type })
      },
    },
    source: options.source === undefined ? SOURCE : options.source,
    rig: RIG,
    markers: options.markers ?? MISSING_MARKERS,
    detailLines: ["default  inferhub/glm-5.3-flash:high", "pool  inferhub/*"],
    roleCount: () => 11,
    currentRig: description => ({
      ...(description === undefined ? {} : { description }),
      modelRoles: { default: "inferhub/glm-5.3" },
      enabledModels: ["inferhub/*"],
    }),
    listRigNames: async () => options.rigNames ?? [],
    apply: async (source, scope) => {
      calls.applies.push({ source, scope })
      return options.applyResult ?? success()
    },
    turnOff: async scope => {
      calls.turnOffs.push(scope)
      return success("default")
    },
    inherit: async scope => {
      calls.inherits.push(scope)
      return success("inherited")
    },
    write: async (name, rig) => {
      calls.writes.push({ name, rig })
    },
    rename: async (oldName, newName) => {
      calls.renames.push([oldName, newName])
    },
    duplicate: async (source, destination) => {
      calls.duplicates.push([source, destination])
    },
    export: async (name, path) => {
      calls.exports.push([name, path])
    },
    remove: async name => {
      calls.removes.push(name)
    },
    edit: async name => {
      calls.edits.push(name)
    },
  }
  return { runtime, calls }
}

describe("action row builder", () => {
  test("builds the complete rig action list in order", () => {
    // Given
    const markers = MISSING_MARKERS

    // When
    const labels = buildActionItems(SOURCE, markers).map(item => item.label)

    // Then
    expect(labels).toEqual([
      "Apply (this session)",
      "Apply to this project",
      "Apply as global default",
      "Edit",
      "Update with current setup",
      "Rename",
      "Duplicate",
      "Export",
      "Remove",
    ])
  })

  test("keeps profile sources read-only", () => {
    // Given
    const source: RigSource = { kind: "profile", name: "work" }

    // When
    const labels = buildActionItems(source, MISSING_MARKERS).map(item => item.label)

    // Then
    expect(labels).toEqual([
      "Apply (this session)",
      "Apply to this project",
      "Apply as global default",
      "Save as rig",
      "Show",
    ])
  })

  test("shows inherit actions only for scopes with a marker", () => {
    // Given
    const markers: ScopeMarkers = {
      session: { kind: "default" },
      project: { kind: "source", source: SOURCE },
      global: { kind: "missing" },
    }

    // When
    const labels = buildActionItems(null, markers).map(item => item.label)

    // Then
    expect(labels).toEqual([
      "Use default (this session)",
      "Use default for this project",
      "Use default globally",
      "Inherit (clear this project's choice)",
      "Inherit (clear this session's choice)",
      "Save as rig",
    ])
  })
})

describe("detail row builder", () => {
  test("renders inherited roles before pool and effective blocked providers", () => {
    // Given
    const inheritedRoles = ["default", "smol", "slow", "task"]

    // When
    const lines = buildDetailLines(RIG, inheritedRoles, ["anthropic", "openai"])

    // Then
    expect(lines).toEqual([
      "default  inferhub/glm-5.3-flash:high",
      "slow  (inherits default)",
      "smol  inferhub/deepseek-v4.1-flash:low",
      "task  (inherits default)",
      "pool  inferhub/*",
      "blocked  anthropic, openai",
    ])
  })

  test("renders unrestricted and unblocked pools plainly", () => {
    // Given
    const rig: Rig = { modelRoles: { default: "p/model" } }

    // When
    const lines = buildDetailLines(rig, ["default"], [])

    // Then
    expect(lines.slice(-2)).toEqual(["pool  all", "blocked  none"])
  })
})

describe("action dispatch", () => {
  test("applies a rig and reports the applied role count", async () => {
    // Given
    const { runtime, calls } = harness()

    // When
    const outcome = await dispatchAction("apply-session", runtime)

    // Then
    expect(outcome).toBe("close")
    expect(calls.applies).toEqual([{ source: SOURCE, scope: "session" }])
    expect(calls.notifications).toEqual([{
      message: "Rig 'cn' applied to 11 roles for session scope",
      type: "info",
    }])
  })

  test("reports every validation error without running another action", async () => {
    // Given
    const { runtime, calls } = harness({
      applyResult: failure("missing credentials for p/a", "unknown model p/b"),
    })

    // When
    const outcome = await dispatchAction("apply-global", runtime)

    // Then
    expect(outcome).toBe("close")
    expect(calls.notifications).toEqual([{
      message: "missing credentials for p/a\nunknown model p/b",
      type: "error",
    }])
    expect(calls.writes).toEqual([])
    expect(calls.removes).toEqual([])
  })

  test("confirms removal and turns off every matching scope first", async () => {
    // Given
    const markers: ScopeMarkers = {
      session: { kind: "source", source: SOURCE },
      project: { kind: "source", source: SOURCE },
      global: { kind: "source", source: { kind: "rig", name: "other" } },
    }
    const { runtime, calls } = harness({ markers, confirms: [true] })

    // When
    const outcome = await dispatchAction("remove", runtime)

    // Then
    expect(outcome).toBe("refresh")
    expect(calls.confirmations).toEqual([{
      title: "Remove rig",
      message: "Remove rig 'cn'?",
    }])
    expect(calls.turnOffs).toEqual(["session", "project"])
    expect(calls.removes).toEqual(["cn"])
  })

  test("keeps the rename dialog open after a collision", async () => {
    // Given
    const { runtime, calls } = harness({
      inputs: ["taken", "fresh"],
      rigNames: ["taken"],
    })

    // When
    await dispatchAction("rename", runtime)

    // Then
    expect(calls.inputs).toEqual([
      { title: "Rename rig", initial: "cn" },
      { title: "Rename rig", initial: "taken" },
    ])
    expect(calls.renames).toEqual([["cn", "fresh"]])
    expect(calls.notifications[0]).toEqual({
      message: "Rig 'taken' already exists",
      type: "error",
    })
  })

  test("does not update a rig when confirmation is declined", async () => {
    // Given
    const { runtime, calls } = harness({ confirms: [false] })

    // When
    const outcome = await dispatchAction("update", runtime)

    // Then
    expect(outcome).toBe("refresh")
    expect(calls.writes).toEqual([])
  })

  test("copies a profile into the rig store", async () => {
    // Given
    const source: RigSource = { kind: "profile", name: "work" }
    const { runtime, calls } = harness({
      source,
      inputs: ["work-copy"],
    })

    // When
    await dispatchAction("save", runtime)

    // Then
    expect(calls.writes).toEqual([{ name: "work-copy", rig: RIG }])
  })
})
