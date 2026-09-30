import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking"
import type { Model, ModelKind } from "@oh-my-pi/pi-catalog/types"
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"
import {
  captureBaseline,
  maskRoles,
  restoreBaseline,
  writeRuntime,
  type HostHandles,
  type RuntimeBaseline,
} from "./host"
import { parseModelSpec, type Rig } from "./rig-file"
import {
  clearMarker,
  effective,
  readMarkers,
  setMarker,
  type Marker,
  type RigSource,
  type Scope,
  type ScopeEnvironment,
  type ScopeMarkers,
} from "./scope"
import type { ProfileSource } from "./store"
import { validateRig, type ValidationRegistry } from "./validate"

// allow: SIZE_OK — the plan keeps transactional apply, reconciliation, and rollback in one engine module.
export interface EngineRegistry extends ValidationRegistry {
  getAll(kind?: ModelKind | "all"): Model[]
  find?(provider: string, id: string): Model | undefined
}

export interface EngineStore {
  read(name: string): Promise<Rig>
  listProfiles(): Promise<readonly ProfileSource[]>
}

export type EnginePi = Readonly<{
  appendEntry: ScopeEnvironment["appendEntry"]
  getThinkingLevel: () => ThinkingLevel | undefined
  setThinkingLevel: (level: ThinkingLevel) => void
  setModel: (model: Model) => Promise<boolean>
}>

export type EngineContext = Readonly<{
  readonly model: Model | undefined
  modelRegistry: EngineRegistry
}>

export type EngineEnvironment = Readonly<{
  pi: EnginePi
  ctx: EngineContext
  settings: Settings
  handles: HostHandles
  store: EngineStore
  scope: ScopeEnvironment
  argv?: readonly string[]
}>

export type EffectivePool = Readonly<{
  enabledModels: readonly string[]
  disabledProviders: readonly string[]
  providerGranular: boolean
}>

export type EngineSuccess = Readonly<{
  ok: true
  summary: string
  source: RigSource | null
  drift: readonly string[]
}>

export type EngineFailure = Readonly<{
  ok: false
  errors: readonly string[]
  warnings: readonly string[]
  drift: readonly string[]
}>

export type EngineResult = EngineSuccess | EngineFailure

type EngineState = {
  baseline: RuntimeBaseline
  pluginWrote: boolean
  runtimeOwned: Readonly<Record<string, string>>
}

type RuntimeSnapshot = Readonly<{
  modelRoles: Readonly<Record<string, string>> | undefined
  enabledModels: readonly string[] | undefined
  disabledProviders: readonly string[] | undefined
  model: Model | undefined
  thinkingLevel: ThinkingLevel | undefined
}>

type ReconcileOptions = Readonly<{
  startup?: boolean
  runtimeOwned?: Readonly<Record<string, string>>
  flagRig?: string
}>

const states = new WeakMap<Settings, EngineState>()

function stateFor(environment: EngineEnvironment): EngineState {
  const current = states.get(environment.settings)
  if (current !== undefined) return current
  const created: EngineState = {
    baseline: captureBaseline(
      environment.settings,
      environment.handles,
      environment.pi.getThinkingLevel(),
    ),
    pluginWrote: false,
    runtimeOwned: {},
  }
  states.set(environment.settings, created)
  return created
}

function matches(pattern: string, model: Model): boolean {
  const glob = new Bun.Glob(pattern.toLowerCase())
  const qualified = `${model.provider}/${model.id}`.toLowerCase()
  return glob.match(qualified) || glob.match(model.id.toLowerCase())
}

function providerOf(spec: string): string {
  return parseModelSpec(spec).model.split("/", 1)[0] ?? ""
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export function effectivePool(
  rig: Rig,
  registry: EngineRegistry,
  runtimeOwned: Readonly<Record<string, string>> = {},
): EffectivePool {
  const authenticated = registry.getAll().filter(model => registry.hasConfiguredAuth(model))
  const enabledModels = [...(rig.enabledModels ?? [])]
  const disabledProviders = new Set(rig.disabledProviders ?? [])

  if (rig.enabledModels !== undefined) {
    for (const provider of unique(authenticated.map(model => model.provider))) {
      const providerHasMatch = authenticated
        .filter(model => model.provider === provider)
        .some(model => rig.enabledModels?.some(pattern => matches(pattern, model)) === true)
      if (!providerHasMatch) disabledProviders.add(provider)
    }
  }

  for (const spec of Object.values(runtimeOwned)) {
    const model = parseModelSpec(spec).model
    disabledProviders.delete(providerOf(model))
    if (rig.enabledModels !== undefined && !enabledModels.includes(model)) enabledModels.push(model)
  }

  return {
    enabledModels,
    disabledProviders: [...disabledProviders],
    providerGranular: enabledModels.some(pattern => {
      const slash = pattern.indexOf("/")
      return slash >= 0 && pattern.slice(slash + 1) !== "*"
    }),
  }
}

function snapshot(environment: EngineEnvironment): RuntimeSnapshot {
  const { settings, handles } = environment
  const effectiveRoles: Record<string, string> = {}
  for (const [role, spec] of Object.entries(settings.getModelRoles())) {
    if (spec !== undefined) effectiveRoles[role] = spec
  }
  return {
    modelRoles:
      settings.getProvenance(handles.modelRoles) === "runtime"
        ? effectiveRoles
        : undefined,
    enabledModels:
      settings.getProvenance(handles.enabledModels) === "runtime"
        ? [...handles.enabledModels.get(settings)]
        : undefined,
    disabledProviders:
      settings.getProvenance(handles.disabledProviders) === "runtime"
        ? [...handles.disabledProviders.get(settings)]
        : undefined,
    model: environment.ctx.model,
    thinkingLevel: environment.pi.getThinkingLevel(),
  }
}

function restoreSnapshot(environment: EngineEnvironment, value: RuntimeSnapshot): void {
  const { settings, handles } = environment
  if (value.modelRoles === undefined) handles.modelRoles.clearOverride(settings)
  else handles.modelRoles.override(settings, { ...value.modelRoles })
  if (value.enabledModels === undefined) handles.enabledModels.clearOverride(settings)
  else handles.enabledModels.override(settings, [...value.enabledModels])
  if (value.disabledProviders === undefined) handles.disabledProviders.clearOverride(settings)
  else handles.disabledProviders.override(settings, [...value.disabledProviders])
}

function coreThinkingLevel(level: ReturnType<typeof parseModelSpec>["level"]): ThinkingLevel | undefined {
  switch (level) {
    case undefined:
      return undefined
    case "auto":
      return ThinkingLevel.Inherit
    case "off":
      return ThinkingLevel.Off
    case "minimal":
      return ThinkingLevel.Minimal
    case "low":
      return ThinkingLevel.Low
    case "medium":
      return ThinkingLevel.Medium
    case "high":
      return ThinkingLevel.High
    case "xhigh":
      return ThinkingLevel.XHigh
    case "max":
      return ThinkingLevel.Max
  }
}

function exactModel(spec: string, registry: EngineRegistry): Model | undefined {
  const parsed = parseModelSpec(spec).model
  const slash = parsed.indexOf("/")
  if (slash < 1) return undefined
  const provider = parsed.slice(0, slash)
  const id = parsed.slice(slash + 1)
  return registry.getAll("all").find(model => model.provider === provider && model.id === id)
}

async function loadSource(source: RigSource, store: EngineStore): Promise<Rig> {
  if (source.kind === "rig") return store.read(source.name)
  const profile = (await store.listProfiles()).find(entry => entry.name === source.name)
  if (profile?.rig !== undefined) return profile.rig
  const detail = profile?.errors.map(error => error.message).join("; ")
  throw new Error(detail ?? `profile "${source.name}" not found`)
}

function markerFor(source: RigSource): Marker {
  return { kind: "source", source }
}

function withMarker(markers: ScopeMarkers, scope: Scope, source: RigSource): ScopeMarkers {
  return { ...markers, [scope]: markerFor(source) }
}

function pinnedModels(argv: readonly string[]): Readonly<{ raw: string; patterns: readonly string[] }> | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--models") {
      const raw = argv[index + 1]
      if (raw !== undefined) return { raw, patterns: raw.split(",").filter(Boolean) }
    }
    if (argument?.startsWith("--models=") === true) {
      const raw = argument.slice("--models=".length)
      return { raw, patterns: raw.split(",").filter(Boolean) }
    }
  }
  return undefined
}

function poolCoversPattern(
  pinned: string,
  enabled: readonly string[],
  registry: EngineRegistry,
): boolean {
  if (enabled.some(pattern => new Bun.Glob(pattern.toLowerCase()).match(pinned.toLowerCase()))) {
    return true
  }
  const pinnedModels = registry.getAll().filter(model => matches(pinned, model))
  return pinnedModels.length > 0
    && pinnedModels.every(model => enabled.some(pattern => matches(pattern, model)))
}

function conflictError(
  name: string,
  rig: Rig,
  environment: EngineEnvironment,
): string | undefined {
  const pinned = pinnedModels(environment.argv ?? process.argv)
  if (pinned === undefined || rig.enabledModels === undefined) return undefined
  if (pinned.patterns.every(pattern =>
    poolCoversPattern(pattern, rig.enabledModels ?? [], environment.ctx.modelRegistry)
  )) {
    return undefined
  }
  return `rig "${name}" restricts models but omp was started with --models ${pinned.raw}; restart without --models`
}

function expandedRoles(
  rig: Rig,
  environment: EngineEnvironment,
  runtimeOwned: Readonly<Record<string, string>>,
): Record<string, string> {
  const roles: Record<string, string> = {}
  const defaultSpec = rig.modelRoles["default"]
  if (defaultSpec === undefined) return roles
  for (const role of maskRoles(environment.settings)) roles[role] = defaultSpec
  Object.assign(roles, rig.modelRoles, runtimeOwned)
  return roles
}

function changedKeys(
  rig: Rig,
  environment: EngineEnvironment,
  runtimeOwned: Readonly<Record<string, string>>,
): string[] {
  const current = environment.settings.getModelRoles()
  const expected = expandedRoles(rig, environment, runtimeOwned)
  const rigRoles = expandedRoles(rig, environment, {})
  const changed = Object.entries(expected)
    .filter(([role, spec]) => current[role] !== spec)
    .map(([role]) => role)
  for (const [role, spec] of Object.entries(runtimeOwned)) {
    if (rigRoles[role] !== spec && !changed.includes(role)) changed.push(role)
  }
  const pool = effectivePool(rig, environment.ctx.modelRegistry, runtimeOwned)
  if (!Bun.deepEquals(environment.handles.enabledModels.get(environment.settings), pool.enabledModels)) {
    changed.push("enabledModels")
  }
  if (!Bun.deepEquals(
    environment.handles.disabledProviders.get(environment.settings),
    pool.disabledProviders,
  )) {
    changed.push("disabledProviders")
  }
  return changed
}

function failure(errors: readonly string[], warnings: readonly string[] = []): EngineFailure {
  return { ok: false, errors, warnings, drift: [] }
}

async function rollback(
  environment: EngineEnvironment,
  previous: RuntimeSnapshot,
): Promise<readonly string[]> {
  const errors: string[] = []
  restoreSnapshot(environment, previous)
  if (previous.model !== undefined) {
    try {
      if (!(await environment.pi.setModel(previous.model))) {
        errors.push("failed to restore the previous model")
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (previous.thinkingLevel !== undefined) {
    environment.pi.setThinkingLevel(previous.thinkingLevel)
  }
  return errors
}

async function applyTransaction(
  source: RigSource,
  scope: Scope,
  environment: EngineEnvironment,
  options: Readonly<{
    runtimeOwned: Readonly<Record<string, string>>
    commitMarker: boolean
    selectedRig?: Rig
  }>,
): Promise<EngineResult> {
  const selectedRig = options.selectedRig ?? await loadSource(source, environment.store)
  const selectedDefault = selectedRig.modelRoles["default"]
  if (selectedDefault === undefined) {
    return failure(["default model role is required"])
  }
  const conflict = conflictError(source.name, selectedRig, environment)
  if (conflict !== undefined) return failure([conflict])

  const selectedValidation = validateRig(selectedRig, environment.ctx.modelRegistry)
  if (!selectedValidation.ok) {
    return failure(selectedValidation.errors.map(error => error.message))
  }

  const markers = await readMarkers(environment.scope)
  const selected = effective(withMarker(markers, scope, source))
  if (selected.source === null || "missing" in selected.source) {
    return failure([`rig "${source.name}" is not applicable at ${scope} scope`])
  }
  const activeRig = selected.source.kind === source.kind && selected.source.name === source.name
    ? selectedRig
    : await loadSource(selected.source, environment.store)
  const validation = validateRig(activeRig, environment.ctx.modelRegistry)
  if (!validation.ok) return failure(validation.errors.map(error => error.message))

  const previous = snapshot(environment)
  const roles = expandedRoles(activeRig, environment, options.runtimeOwned)
  const pool = effectivePool(activeRig, environment.ctx.modelRegistry, options.runtimeOwned)
  const activeDefault = activeRig.modelRoles["default"]
  if (activeDefault === undefined) return failure(["default model role is required"])
  const runtimeDefault = roles["default"] ?? activeDefault
  writeRuntime(environment.settings, environment.handles, {
    modelRoles: {
      ...roles,
      default: runtimeDefault,
    },
    enabledModels: pool.enabledModels,
    disabledProviders: pool.disabledProviders,
  })

  const defaultIsRuntimeOwned = options.runtimeOwned["default"] !== undefined
  const defaultSpec = runtimeDefault
  const model = exactModel(defaultSpec, environment.ctx.modelRegistry)
  if (model === undefined) {
    restoreSnapshot(environment, previous)
    return failure([`unknown default model ${parseModelSpec(defaultSpec).model}`])
  }

  try {
    if (!defaultIsRuntimeOwned && !(await environment.pi.setModel(model))) {
      const rollbackErrors = await rollback(environment, previous)
      return failure([
        `failed to activate model ${model.provider}/${model.id}`,
        ...rollbackErrors,
      ])
    }
    const level = coreThinkingLevel(parseModelSpec(defaultSpec).level)
    if (level !== undefined) environment.pi.setThinkingLevel(level)
    if (options.commitMarker) await setMarker(scope, source, environment.scope)
  } catch (error) {
    const rollbackErrors = await rollback(environment, previous)
    return failure([
      error instanceof Error ? error.message : String(error),
      ...rollbackErrors,
    ])
  }

  const state = stateFor(environment)
  state.pluginWrote = true
  state.runtimeOwned = options.runtimeOwned
  return {
    ok: true,
    summary: `${selected.source.kind}: ${selected.source.name}`,
    source: selected.source,
    drift: changedKeys(activeRig, environment, options.runtimeOwned),
  }
}

export async function applyRig(
  source: RigSource,
  scope: Scope,
  environment: EngineEnvironment,
): Promise<EngineResult> {
  stateFor(environment)
  let result: EngineResult
  try {
    result = await applyTransaction(source, scope, environment, {
      runtimeOwned: {},
      commitMarker: true,
    })
  } catch (error) {
    return failure([error instanceof Error ? error.message : String(error)])
  }
  if (result.ok) stateFor(environment).runtimeOwned = {}
  return result
}

async function restoreSessionState(environment: EngineEnvironment): Promise<void> {
  const state = stateFor(environment)
  restoreBaseline(environment.settings, environment.handles, state.baseline)
  const defaultSpec = environment.settings.getModelRoles()["default"]
  if (defaultSpec !== undefined) {
    const model = exactModel(defaultSpec, environment.ctx.modelRegistry)
    if (model !== undefined) await environment.pi.setModel(model)
    const level = coreThinkingLevel(parseModelSpec(defaultSpec).level)
    if (level !== undefined) environment.pi.setThinkingLevel(level)
    else if (state.baseline.thinkingLevel !== undefined) {
      environment.pi.setThinkingLevel(state.baseline.thinkingLevel)
    }
  } else if (state.baseline.thinkingLevel !== undefined) {
    environment.pi.setThinkingLevel(state.baseline.thinkingLevel)
  }
  state.pluginWrote = false
  state.runtimeOwned = {}
}

export async function reconcile(
  environment: EngineEnvironment,
  options: ReconcileOptions = {},
): Promise<EngineResult> {
  const state = stateFor(environment)
  if (options.startup === true) state.runtimeOwned = options.runtimeOwned ?? {}

  if (options.flagRig !== undefined) {
    const markers = await readMarkers(environment.scope)
    if (markers.session.kind === "missing") {
      try {
        return await applyTransaction(sourceFor(options.flagRig), "session", environment, {
          runtimeOwned: state.runtimeOwned,
          commitMarker: true,
        })
      } catch (error) {
        return failure([error instanceof Error ? error.message : String(error)])
      }
    }
  }

  const selected = effective(await readMarkers(environment.scope))
  if (selected.source === null) {
    if (state.pluginWrote) await restoreSessionState(environment)
    return { ok: true, summary: "default", source: null, drift: [] }
  }
  if ("missing" in selected.source) {
    if (state.pluginWrote) await restoreSessionState(environment)
    const warning = `${selected.source.kind} "${selected.source.name}" not found`
    return failure([], [warning])
  }

  try {
    const result = await applyTransaction(selected.source, selected.scope, environment, {
      runtimeOwned: state.runtimeOwned,
      commitMarker: false,
    })
    if (!result.ok) {
      if (state.pluginWrote) await restoreSessionState(environment)
      return failure([], result.errors)
    }
    return result
  } catch (error) {
    if (state.pluginWrote) await restoreSessionState(environment)
    const warning = error instanceof Error ? error.message : String(error)
    return failure([], [warning])
  }
}

function sourceFor(name: string): RigSource {
  return { kind: "rig", name }
}

export async function turnOff(
  scope: Scope,
  environment: EngineEnvironment,
): Promise<EngineResult> {
  await setMarker(scope, "default", environment.scope)
  return reconcile(environment)
}

export async function inherit(
  scope: Scope,
  environment: EngineEnvironment,
): Promise<EngineResult> {
  await clearMarker(scope, environment.scope)
  return reconcile(environment)
}

export async function drift(environment: EngineEnvironment): Promise<readonly string[]> {
  const selected = effective(await readMarkers(environment.scope))
  if (selected.source === null || "missing" in selected.source) return []
  try {
    const rig = await loadSource(selected.source, environment.store)
    return changedKeys(rig, environment, stateFor(environment).runtimeOwned)
  } catch (error) {
    if (error instanceof Error) return [error.message]
    throw error
  }
}

/** Per-role annotations for the effective rig: inherited from its default, drifted, and saved to global config. */
export async function roleNotes(
  environment: EngineEnvironment,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const selected = effective(await readMarkers(environment.scope))
  if (selected.source === null || "missing" in selected.source) return {}
  const rig = await loadSource(selected.source, environment.store)
  const drifted = new Set(changedKeys(rig, environment, stateFor(environment).runtimeOwned))
  const current = environment.settings.getModelRoles()
  const globalRoles = environment.settings.getGlobalSettings()["modelRoles"] as Record<string, unknown> | undefined
  const notes: Record<string, string[]> = {}
  for (const [role, spec] of Object.entries(current)) {
    if (spec === undefined) continue
    const note: string[] = []
    if (!Object.hasOwn(rig.modelRoles, role) && (spec === rig.modelRoles["default"] || drifted.has(role))) {
      note.push("inherits default")
    }
    if (drifted.has(role)) {
      note.push("drifted")
      if (globalRoles?.[role] === spec) note.push("saved to global config")
    }
    notes[role] = note
  }
  return notes
}

/**
 * The user's own settings with every plugin override removed, computed from the live layers
 * (no settings reload): global, then project, then the runtime values omp owned before the plugin wrote.
 */
export function baselineView(environment: EngineEnvironment): Readonly<{
  modelRoles: Readonly<Record<string, string>>
  enabledModels: readonly string[]
  disabledProviders: readonly string[]
}> {
  const state = stateFor(environment)
  const settings = environment.settings
  if (!state.pluginWrote) {
    return {
      modelRoles: definedRoles(settings.getModelRoles()),
      enabledModels: environment.handles.enabledModels.get(settings),
      disabledProviders: environment.handles.disabledProviders.get(settings),
    }
  }
  const layers = [settings.getGlobalSettings(), settings.getProjectSettings()]
  const modelRoles: Record<string, string> = {}
  let enabledModels: readonly string[] = []
  let disabledProviders: readonly string[] = []
  for (const layer of layers) {
    Object.assign(modelRoles, definedRoles(layer["modelRoles"]))
    if (Array.isArray(layer["enabledModels"])) enabledModels = layer["enabledModels"].filter((item): item is string => typeof item === "string")
    if (Array.isArray(layer["disabledProviders"])) disabledProviders = layer["disabledProviders"].filter((item): item is string => typeof item === "string")
  }
  Object.assign(modelRoles, state.baseline.modelRoles ?? {})
  return {
    modelRoles,
    enabledModels: state.baseline.enabledModels ?? enabledModels,
    disabledProviders: state.baseline.disabledProviders ?? disabledProviders,
  }
}

function definedRoles(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""),
  )
}
