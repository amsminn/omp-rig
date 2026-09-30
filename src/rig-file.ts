export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export type Rig = {
  readonly description?: string
  readonly modelRoles: Readonly<Record<string, string>>
  readonly enabledModels?: readonly string[]
  readonly disabledProviders?: readonly string[]
}

export type RigFileError = {
  readonly path: string
  readonly line?: number
  readonly message: string
}

export type ParseRigResult =
  | { readonly ok: true; readonly rig: Rig }
  | { readonly ok: false; readonly errors: readonly RigFileError[] }

export type ParsedModelSpec = {
  readonly model: string
  readonly level?: ThinkingLevel
}

const TOP_LEVEL_KEYS = new Set([
  "description",
  "modelRoles",
  "enabledModels",
  "disabledProviders",
])

const RESERVED_NAMES = new Set([
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
])

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value)
}

function isValidModelId(model: string): boolean {
  const slash = model.indexOf("/")
  return slash > 0 && slash < model.length - 1 && !/\s/.test(model)
}

function validateStringArray(
  value: unknown,
  path: "enabledModels" | "disabledProviders",
  errors: RigFileError[],
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    errors.push({ path, message: `${path} must be an array of strings` })
    return undefined
  }

  const result: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      errors.push({ path: `${path}.${index}`, message: `${path} entries must be strings` })
      continue
    }
    result.push(entry)
  }
  return result
}

export function parseModelSpec(spec: string): ParsedModelSpec {
  const colon = spec.lastIndexOf(":")
  const suffix = colon === -1 ? "" : spec.slice(colon + 1)
  if (isThinkingLevel(suffix)) {
    return { model: spec.slice(0, colon), level: suffix }
  }
  return { model: spec }
}

export function validateRigName(name: string): RigFileError | undefined {
  if (!NAME_PATTERN.test(name)) {
    return {
      path: "name",
      message: "rig name must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens",
    }
  }
  if (RESERVED_NAMES.has(name)) {
    return { path: "name", message: `reserved rig name: ${name}` }
  }
  return undefined
}

export function parseRig(text: string, fileName: string): ParseRigResult {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    const line = Reflect.get(error, "line")
    return {
      ok: false,
      errors: [{
        path: fileName,
        ...(typeof line === "number" ? { line } : {}),
        message: error.message,
      }],
    }
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      errors: [{ path: fileName, message: "rig file must contain a mapping" }],
    }
  }

  const errors: RigFileError[] = []
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push({ path: key, message: `unknown top-level key: ${key}` })
    }
  }

  const rolesValue = parsed["modelRoles"]
  const modelRoles: Record<string, string> = {}
  if (rolesValue === undefined) {
    errors.push({ path: "modelRoles", message: "modelRoles is required" })
  } else if (!isRecord(rolesValue) || Object.keys(rolesValue).length === 0) {
    errors.push({ path: "modelRoles", message: "modelRoles must be a non-empty record" })
  } else {
    for (const [role, spec] of Object.entries(rolesValue)) {
      if (typeof spec !== "string" || spec.trim().length === 0) {
        errors.push({
          path: `modelRoles.${role}`,
          message: "model role must be a non-empty string",
        })
        continue
      }
      if (!isValidModelId(parseModelSpec(spec).model)) {
        errors.push({
          path: `modelRoles.${role}`,
          message: "model role must use provider/model[:level]",
        })
        continue
      }
      modelRoles[role] = spec
    }
    if (!Object.hasOwn(rolesValue, "default")) {
      errors.push({
        path: "modelRoles.default",
        message: "default model role is required",
      })
    }
  }

  const descriptionValue = parsed["description"]
  let description: string | undefined
  if (descriptionValue !== undefined) {
    if (typeof descriptionValue !== "string") {
      errors.push({ path: "description", message: "description must be a string" })
    } else if (descriptionValue.length > 120) {
      errors.push({
        path: "description",
        message: "description must be at most 120 characters",
      })
    } else {
      description = descriptionValue
    }
  }

  const enabledModels = validateStringArray(parsed["enabledModels"], "enabledModels", errors)
  const disabledProviders = validateStringArray(
    parsed["disabledProviders"],
    "disabledProviders",
    errors,
  )

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    rig: {
      ...(description === undefined ? {} : { description }),
      modelRoles,
      ...(enabledModels === undefined ? {} : { enabledModels }),
      ...(disabledProviders === undefined ? {} : { disabledProviders }),
    },
  }
}

export function serializeRig(rig: Rig): string {
  return `${Bun.YAML.stringify({
    ...(rig.description === undefined ? {} : { description: rig.description }),
    modelRoles: rig.modelRoles,
    ...(rig.enabledModels === undefined ? {} : { enabledModels: rig.enabledModels }),
    ...(rig.disabledProviders === undefined
      ? {}
      : { disabledProviders: rig.disabledProviders }),
  })}\n`
}
