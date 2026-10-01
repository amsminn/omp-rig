import type { Model } from "@oh-my-pi/pi-ai/types"
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking"
import { MODEL_ROLES } from "@oh-my-pi/pi-coding-agent/config/model-roles"
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"

type ModelSettingsModule = typeof import("@oh-my-pi/pi-coding-agent/config/model-settings")

export type HostHandles = Readonly<{
  modelRoles: ModelSettingsModule["cfgModelRoles"]
  enabledModels: ModelSettingsModule["cfgEnabledModels"]
  disabledProviders: ModelSettingsModule["cfgDisabledProviders"]
}>

export type EffectiveSettings = Readonly<{
  modelRoles: Readonly<Record<string, string>>
  enabledModels: readonly string[]
  disabledProviders: readonly string[]
}>

export type RuntimeModelRoles = Readonly<Record<string, string>> &
  Readonly<{
    default: string
  }>

export type RuntimeSettings = Readonly<{
  modelRoles: RuntimeModelRoles
  enabledModels?: readonly string[]
  disabledProviders?: readonly string[]
}>

export type RuntimeBaseline = Readonly<{
  modelRoles: Readonly<Record<string, string>> | undefined
  enabledModels: readonly string[] | undefined
  disabledProviders: readonly string[] | undefined
  thinkingLevel: ThinkingLevel | undefined
}>

export class HostUnsupportedError extends Error {
  readonly requiredRange = ">=18.3.1 <19"

  constructor() {
    super("omp-rig needs omp >=18.3.1 <19")
    this.name = "HostUnsupportedError"
  }
}

const CHAT_MODEL = {
  id: "omp-rig-role-probe",
  identity: { class: "unknown" },
  name: "omp-rig-role-probe",
  api: "openai-completions",
  provider: "omp-rig",
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
} satisfies Model

const CHAT_BUILT_IN_ROLES = Object.entries(MODEL_ROLES)
  .filter(([, definition]) => definition.accepts(CHAT_MODEL))
  .map(([role]) => role)

const NON_CHAT_BUILT_IN_ROLES = new Set(
  Object.entries(MODEL_ROLES)
    .filter(([, definition]) => !definition.accepts(CHAT_MODEL))
    .map(([role]) => role),
)

let handlesPromise: Promise<HostHandles> | undefined

function copyRoles(roles: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const [role, value] of Object.entries(roles)) {
    if (value !== undefined) copy[role] = value
  }
  return copy
}

export function resolveHandles(): Promise<HostHandles> {
  handlesPromise ??= import("@oh-my-pi/pi-coding-agent/config/model-settings").then(module => {
    const handles = {
      modelRoles: module.cfgModelRoles,
      enabledModels: module.cfgEnabledModels,
      disabledProviders: module.cfgDisabledProviders,
    }

    if (
      typeof handles.modelRoles?.override !== "function" ||
      typeof handles.enabledModels?.override !== "function" ||
      typeof handles.disabledProviders?.override !== "function"
    ) {
      throw new HostUnsupportedError()
    }

    return handles
  })

  return handlesPromise
}

export function runtimeOwnedRoles(settings: Settings): Readonly<Record<string, string>> {
  const owned: Record<string, string> = {}
  for (const [role, value] of Object.entries(copyRoles(settings.getModelRoles()))) {
    if (settings.getModelRoleProvenance(role) === "runtime") owned[role] = value
  }
  return owned
}

export async function readEffective(settings: Settings): Promise<EffectiveSettings> {
  const handles = await resolveHandles()
  return {
    modelRoles: copyRoles(settings.getModelRoles()),
    enabledModels: [...handles.enabledModels.get(settings)],
    disabledProviders: [...handles.disabledProviders.get(settings)],
  }
}

export function maskRoles(settings: Settings): readonly string[] {
  const roles = new Set(CHAT_BUILT_IN_ROLES)
  for (const role of Object.keys(settings.getModelRoles())) {
    if (!NON_CHAT_BUILT_IN_ROLES.has(role)) roles.add(role)
  }
  return [...roles]
}

export function writeRuntime(settings: Settings, handles: HostHandles, runtime: RuntimeSettings): void {
  const maskedRoles: Record<string, string> = {}
  for (const role of maskRoles(settings)) maskedRoles[role] = runtime.modelRoles.default
  Object.assign(maskedRoles, runtime.modelRoles)

  handles.modelRoles.override(settings, maskedRoles)
  // omp 18.4.4 accepts plain string[] values for path-scoped overrides.
  handles.enabledModels.override(settings, [...(runtime.enabledModels ?? [])])
  handles.disabledProviders.override(settings, [...(runtime.disabledProviders ?? [])])
}

export function captureBaseline(
  settings: Settings,
  handles: HostHandles,
  thinkingLevel?: ThinkingLevel,
): RuntimeBaseline {
  return {
    modelRoles:
      settings.getProvenance(handles.modelRoles) === "runtime" ? { ...runtimeOwnedRoles(settings) } : undefined,
    enabledModels:
      settings.getProvenance(handles.enabledModels) === "runtime"
        ? [...handles.enabledModels.get(settings)]
        : undefined,
    disabledProviders:
      settings.getProvenance(handles.disabledProviders) === "runtime"
        ? [...handles.disabledProviders.get(settings)]
        : undefined,
    thinkingLevel,
  }
}

export function restoreBaseline(settings: Settings, handles: HostHandles, baseline: RuntimeBaseline): void {
  if (baseline.modelRoles === undefined) handles.modelRoles.clearOverride(settings)
  else handles.modelRoles.override(settings, { ...baseline.modelRoles })

  if (baseline.enabledModels === undefined) handles.enabledModels.clearOverride(settings)
  else handles.enabledModels.override(settings, [...baseline.enabledModels])

  if (baseline.disabledProviders === undefined) handles.disabledProviders.clearOverride(settings)
  else handles.disabledProviders.override(settings, [...baseline.disabledProviders])
}

export const clearRuntime = restoreBaseline
