import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SESSION_MARKER_TYPE,
  clearMarker,
  effective,
  readFileMarker,
  readMarkers,
  readSessionMarker,
  setMarker,
  type Marker,
  type RigSource,
  type Scope,
  type ScopeEnvironment,
} from "../src/scope.ts"

const RIG_SOURCE = { kind: "rig", name: "cn" } as const satisfies RigSource
const PROFILE_SOURCE = { kind: "profile", name: "work" } as const satisfies RigSource
const MISSING = { kind: "missing" } as const satisfies Marker
const DEFAULT = { kind: "default" } as const satisfies Marker
const RIG = { kind: "source", source: RIG_SOURCE } as const satisfies Marker

let temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
  temporaryDirectories = []
})

async function scopeEnvironment(): Promise<{
  readonly environment: ScopeEnvironment
  readonly entries: unknown[]
  readonly root: string
}> {
  const root = await mkdtemp(join(tmpdir(), "omp-rig-scope-"))
  temporaryDirectories.push(root)
  const entries: unknown[] = []
  return {
    root,
    entries,
    environment: {
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      getBranch: () => entries,
      appendEntry: <T>(customType: string, data: T) => {
        entries.push({ type: "custom", customType, data })
      },
    },
  }
}

describe("effective", () => {
  const cases = [
    ["missing", MISSING],
    ["default", DEFAULT],
    ["rig", RIG],
  ] as const

  for (const [sessionName, session] of cases) {
    for (const [projectName, project] of cases) {
      for (const [globalName, global] of cases) {
        test(`resolves ${sessionName}/${projectName}/${globalName} by scope precedence`, () => {
          // Given
          const markers = { session, project, global }
          const ordered: readonly (readonly [Scope, Marker])[] = [
            ["session", session],
            ["project", project],
            ["global", global],
          ]
          const selected = ordered.find(([, marker]) => marker.kind !== "missing")

          // When
          const result = effective(markers)

          // Then
          if (selected?.[1].kind === "source") {
            expect(result).toEqual({ source: RIG_SOURCE, scope: selected[0] })
          } else {
            expect(result).toEqual({ source: null })
          }
        })
      }
    }
  }

  test("lets an explicit project default mask a global rig", () => {
    // Given
    const markers = { session: MISSING, project: DEFAULT, global: RIG }

    // When
    const result = effective(markers)

    // Then
    expect(result).toEqual({ source: null })
  })

  test("lets an explicit session default mask lower scopes", () => {
    // Given
    const markers = { session: DEFAULT, project: RIG, global: RIG }

    // When
    const result = effective(markers)

    // Then
    expect(result).toEqual({ source: null })
  })

  test("marks a selected deleted rig missing without falling through", () => {
    // Given
    const markers = {
      session: MISSING,
      project: RIG,
      global: { kind: "source", source: PROFILE_SOURCE } as const,
    }

    // When
    const result = effective(markers, (source: RigSource) => source.kind === "profile")

    // Then
    expect(result).toEqual({
      source: { kind: "rig", name: "cn", missing: true },
      scope: "project",
    })
  })
})

describe("session markers", () => {
  test("reads the last marker on the active branch", () => {
    // Given
    const entries = [
      {
        type: "custom",
        customType: SESSION_MARKER_TYPE,
        data: { source: RIG_SOURCE },
      },
      { type: "message", data: {} },
      {
        type: "custom",
        customType: SESSION_MARKER_TYPE,
        data: { source: PROFILE_SOURCE },
      },
    ]

    // When
    const marker = readSessionMarker(entries)

    // Then
    expect(marker).toEqual({ kind: "source", source: PROFILE_SOURCE })
  })

  test("reads a null source as an explicit default", () => {
    // Given
    const entries = [{
      type: "custom",
      customType: SESSION_MARKER_TYPE,
      data: { source: null },
    }]

    // When
    const marker = readSessionMarker(entries)

    // Then
    expect(marker).toEqual(DEFAULT)
  })

  test("reads a cleared entry as no session choice", () => {
    // Given
    const entries = [{
      type: "custom",
      customType: SESSION_MARKER_TYPE,
      data: { source: undefined, cleared: true },
    }]

    // When
    const marker = readSessionMarker(entries)

    // Then
    expect(marker).toEqual(MISSING)
  })
})

describe("file markers", () => {
  test("returns missing when the marker file does not exist", async () => {
    // Given
    const { root } = await scopeEnvironment()

    // When
    const marker = await readFileMarker(join(root, "missing"))

    // Then
    expect(marker).toEqual(MISSING)
  })

  test("keeps rig and profile names in separate namespaces", async () => {
    // Given
    const { environment } = await scopeEnvironment()
    await setMarker("project", RIG_SOURCE, environment)

    // When
    const rigMarkers = await readMarkers(environment)
    await setMarker("project", { kind: "profile", name: "cn" }, environment)
    const profileMarkers = await readMarkers(environment)

    // Then
    expect(rigMarkers.project).toEqual({ kind: "source", source: RIG_SOURCE })
    expect(profileMarkers.project).toEqual({
      kind: "source",
      source: { kind: "profile", name: "cn" },
    })
  })

  test("writes each file marker as one line", async () => {
    // Given
    const { environment } = await scopeEnvironment()

    // When
    await setMarker("project", PROFILE_SOURCE, environment)
    await setMarker("global", "default", environment)

    // Then
    expect(await readFile(join(environment.cwd, ".omp", "rig"), "utf8")).toBe("profile:work\n")
    expect(await readFile(join(environment.agentDir, "rig.active"), "utf8")).toBe("default\n")
  })

  test("restores a global rig after clearing the project marker", async () => {
    // Given
    const { environment } = await scopeEnvironment()
    await setMarker("global", RIG_SOURCE, environment)
    await setMarker("project", "default", environment)

    // When
    await clearMarker("project", environment)
    const result = effective(await readMarkers(environment))

    // Then
    expect(result).toEqual({ source: RIG_SOURCE, scope: "global" })
  })
})

describe("marker writes", () => {
  test("appends the documented session payloads", async () => {
    // Given
    const { environment, entries } = await scopeEnvironment()

    // When
    await setMarker("session", RIG_SOURCE, environment)
    await setMarker("session", "default", environment)
    await clearMarker("session", environment)

    // Then
    expect(entries).toEqual([
      {
        type: "custom",
        customType: SESSION_MARKER_TYPE,
        data: { source: RIG_SOURCE },
      },
      {
        type: "custom",
        customType: SESSION_MARKER_TYPE,
        data: { source: null },
      },
      {
        type: "custom",
        customType: SESSION_MARKER_TYPE,
        data: { source: undefined, cleared: true },
      },
    ])
  })
})
