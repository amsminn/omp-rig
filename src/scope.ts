import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const SESSION_MARKER_TYPE = "omp-rig.active"

export type Scope = "session" | "project" | "global"

export type RigSource = Readonly<{
  kind: "rig" | "profile"
  name: string
}>

export type Marker =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "source"; source: RigSource }>

export type ScopeMarkers = Readonly<Record<Scope, Marker>>

export type EffectiveRig =
  | Readonly<{ source: null }>
  | Readonly<{
    source: RigSource | Readonly<RigSource & { missing: true }>
    scope: Scope
  }>

export type ScopeEnvironment = Readonly<{
  cwd: string
  agentDir: string
  getBranch: () => readonly unknown[]
  appendEntry: <T>(customType: string, data: T) => void
}>

type SessionMarkerData = Readonly<{
  source?: RigSource | null | undefined
  cleared?: true
}>

export class MarkerFormatError extends Error {
  readonly value: string

  constructor(value: string) {
    super(`invalid omp-rig marker: ${JSON.stringify(value)}`)
    this.name = "MarkerFormatError"
    this.value = value
  }
}

const MISSING = { kind: "missing" } as const satisfies Marker
const DEFAULT = { kind: "default" } as const satisfies Marker

function assertNever(value: never): never {
  throw new MarkerFormatError(JSON.stringify(value))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sourceFrom(value: unknown): RigSource | undefined {
  if (!isRecord(value)) return undefined
  const kind = value["kind"]
  const name = value["name"]
  if ((kind !== "rig" && kind !== "profile") || typeof name !== "string" || name.length === 0) {
    return undefined
  }
  return { kind, name }
}

function markerFile(scope: Exclude<Scope, "session">, environment: ScopeEnvironment): string {
  switch (scope) {
    case "project":
      return join(environment.cwd, ".omp", "rig")
    case "global":
      return join(environment.agentDir, "rig.active")
    default:
      return assertNever(scope)
  }
}

function markerLine(choice: RigSource | "default"): string {
  if (choice === "default") return "default"
  if (choice.name.length === 0 || choice.name.includes("\n") || choice.name.includes("\r")) {
    throw new MarkerFormatError(`${choice.kind}:${choice.name}`)
  }
  return `${choice.kind}:${choice.name}`
}

function parseMarkerLine(value: string): Marker {
  const line = value.endsWith("\n") ? value.slice(0, -1) : value
  if (line === "default") return DEFAULT
  if (line.includes("\n") || line.includes("\r")) throw new MarkerFormatError(value)

  const separator = line.indexOf(":")
  const kind = line.slice(0, separator)
  const name = line.slice(separator + 1)
  if ((kind !== "rig" && kind !== "profile") || separator < 0 || name.length === 0) {
    throw new MarkerFormatError(value)
  }
  return { kind: "source", source: { kind, name } }
}

export function readSessionMarker(entries: readonly unknown[]): Marker {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SESSION_MARKER_TYPE) {
      continue
    }
    const data = entry["data"]
    if (!isRecord(data)) continue
    if (data["cleared"] === true && data["source"] === undefined) return MISSING
    if (data["source"] === null) return DEFAULT
    const source = sourceFrom(data["source"])
    if (source !== undefined) return { kind: "source", source }
  }
  return MISSING
}

export async function readFileMarker(file: string): Promise<Marker> {
  try {
    return parseMarkerLine(await readFile(file, "utf8"))
  } catch (error) {
    if (error instanceof MarkerFormatError) throw error
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return MISSING
    throw error
  }
}

export async function readMarkers(environment: ScopeEnvironment): Promise<ScopeMarkers> {
  const [project, global] = await Promise.all([
    readFileMarker(markerFile("project", environment)),
    readFileMarker(markerFile("global", environment)),
  ])
  return {
    session: readSessionMarker(environment.getBranch()),
    project,
    global,
  }
}

export function effective(
  markers: ScopeMarkers,
  sourceExists: (source: RigSource) => boolean = () => true,
): EffectiveRig {
  const ordered = [
    ["session", markers.session],
    ["project", markers.project],
    ["global", markers.global],
  ] as const

  for (const [scope, marker] of ordered) {
    switch (marker.kind) {
      case "missing":
        continue
      case "default":
        return { source: null }
      case "source":
        return sourceExists(marker.source)
          ? { source: marker.source, scope }
          : { source: { ...marker.source, missing: true }, scope }
      default:
        return assertNever(marker)
    }
  }
  return { source: null }
}

export async function setMarker(
  scope: Scope,
  choice: RigSource | "default",
  environment: ScopeEnvironment,
): Promise<void> {
  switch (scope) {
    case "session": {
      const data: SessionMarkerData = {
        source: choice === "default" ? null : choice,
      }
      environment.appendEntry(SESSION_MARKER_TYPE, data)
      return
    }
    case "project":
    case "global": {
      const file = markerFile(scope, environment)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${markerLine(choice)}\n`, "utf8")
      return
    }
    default:
      return assertNever(scope)
  }
}

export async function clearMarker(
  scope: Scope,
  environment: ScopeEnvironment,
): Promise<void> {
  switch (scope) {
    case "session": {
      const data: SessionMarkerData = { source: undefined, cleared: true }
      environment.appendEntry(SESSION_MARKER_TYPE, data)
      return
    }
    case "project":
    case "global":
      await rm(markerFile(scope, environment), { force: true })
      return
    default:
      return assertNever(scope)
  }
}
