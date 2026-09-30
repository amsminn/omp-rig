import { modelKind, type Model, type ModelKind } from "@oh-my-pi/pi-catalog/types"
import { MODEL_ROLES } from "@oh-my-pi/pi-coding-agent/config/model-roles"
import { parseModelSpec, type Rig } from "./rig-file"

export type RigHealth = "ok" | "missing-credentials" | "unknown-model" | "empty-pool"

export type RigValidationError =
  | Readonly<{
      code: "unknown-model"
      role: string
      model: string
      suggestion?: string
      message: string
    }>
  | Readonly<{
      code: "missing-credentials"
      role: string
      model: string
      message: string
    }>
  | Readonly<{
      code: "kind-mismatch"
      role: string
      model: string
      message: string
    }>
  | Readonly<{
      code: "empty-pool"
      pattern: string
      message: string
    }>
  | Readonly<{
      code: "outside-pool"
      role: string
      model: string
      message: string
    }>

export type RigValidationResult = Readonly<{
  ok: boolean
  errors: readonly RigValidationError[]
  models: Readonly<Record<string, Model>>
}>

export interface ValidationRegistry {
  getAll(kind?: ModelKind | "all"): Model[]
  hasConfiguredAuth(model: Model): boolean
}

function matchesPattern(pattern: string, model: Model): boolean {
  const glob = new Bun.Glob(pattern.toLowerCase())
  return glob.match(`${model.provider}/${model.id}`.toLowerCase())
    || glob.match(model.id.toLowerCase())
}

function roleDefinition(role: string): (typeof MODEL_ROLES)[keyof typeof MODEL_ROLES] | undefined {
  return Object.entries(MODEL_ROLES).find(([name]) => name === role)?.[1]
}

function acceptsRole(role: string, model: Model): boolean {
  const definition = roleDefinition(role)
  return definition === undefined ? modelKind(model) === "chat" : definition.accepts(model)
}

function expectedKind(role: string): string {
  const definition = roleDefinition(role)
  if (definition === undefined || definition.section === "chat") return "chat"
  if (role === "speech") return "tts"
  if (role === "dictation") return "stt"
  if (role === "web") return "search-capable"
  return role
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function suggestionFor(spec: string, catalog: readonly Model[], registry: ValidationRegistry): string | undefined {
  const slash = spec.indexOf("/")
  if (slash < 1) return undefined

  const provider = spec.slice(0, slash).toLowerCase()
  const requestedId = spec.slice(slash + 1).toLowerCase()
  const candidates = catalog
    .filter(model => model.provider.toLowerCase() === provider && registry.hasConfiguredAuth(model))
    .map(model => ({
      model,
      family: model.identity.class === "unknown"
        ? model.provider.toLowerCase()
        : model.identity.class,
      score: sharedPrefixLength(requestedId, model.id.toLowerCase()),
    }))
    .filter(candidate => candidate.score >= 3)
    .sort((left, right) => right.score - left.score || left.family.localeCompare(right.family))

  const candidate = candidates[0]?.model
  return candidate === undefined ? undefined : `${candidate.provider}/${candidate.id}`
}

export function validateRig(rig: Rig, registry: ValidationRegistry): RigValidationResult {
  const catalog = registry.getAll("all")
  const authenticatedChatModels = catalog.filter(
    model => modelKind(model) === "chat" && registry.hasConfiguredAuth(model),
  )
  const errors: RigValidationError[] = []
  const models: Record<string, Model> = {}

  for (const [role, specWithLevel] of Object.entries(rig.modelRoles)) {
    const spec = parseModelSpec(specWithLevel).model
    const slash = spec.indexOf("/")
    const provider = spec.slice(0, slash)
    const id = spec.slice(slash + 1)
    const model = catalog.find(entry => entry.provider === provider && entry.id === id)

    if (model === undefined) {
      const suggestion = suggestionFor(spec, catalog, registry)
      errors.push({
        code: "unknown-model",
        role,
        model: spec,
        ...(suggestion === undefined ? {} : { suggestion }),
        message: suggestion === undefined
          ? `unknown model ${spec} for role ${role}`
          : `unknown model ${spec} for role ${role}; try ${suggestion}`,
      })
      continue
    }

    if (!registry.hasConfiguredAuth(model)) {
      errors.push({
        code: "missing-credentials",
        role,
        model: spec,
        message: `model ${spec} for role ${role} has no configured credentials`,
      })
      continue
    }

    if (!acceptsRole(role, model)) {
      errors.push({
        code: "kind-mismatch",
        role,
        model: spec,
        message: `${role} does not accept ${modelKind(model)} model ${spec}; expected ${expectedKind(role)}`,
      })
      continue
    }

    models[role] = model
  }

  for (const pattern of rig.enabledModels ?? []) {
    if (!authenticatedChatModels.some(model => matchesPattern(pattern, model))) {
      errors.push({
        code: "empty-pool",
        pattern,
        message: `pool pattern ${pattern} matches no authenticated chat model`,
      })
    }
  }

  const disabledProviders = new Set(rig.disabledProviders ?? [])
  for (const [role, model] of Object.entries(models)) {
    const spec = `${model.provider}/${model.id}`
    const enabled = rig.enabledModels === undefined
      || rig.enabledModels.some(pattern => matchesPattern(pattern, model))
    if (!enabled || disabledProviders.has(model.provider)) {
      errors.push({
        code: "outside-pool",
        role,
        model: spec,
        message: `model ${spec} for role ${role} is outside this rig's pool`,
      })
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    models,
  }
}

export function healthOf(rig: Rig, registry: ValidationRegistry): RigHealth {
  const { errors } = validateRig(rig, registry)
  if (errors.some(error => error.code === "unknown-model" || error.code === "kind-mismatch")) {
    return "unknown-model"
  }
  if (errors.some(error => error.code === "missing-credentials")) return "missing-credentials"
  if (errors.some(error => error.code === "empty-pool" || error.code === "outside-pool")) {
    return "empty-pool"
  }
  return "ok"
}
