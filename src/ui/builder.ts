import type { Model } from "@oh-my-pi/pi-ai/types"
import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent"
import {
  SelectList,
  SettingsList,
  type Component,
  type SelectItem,
  type SettingItem,
} from "@oh-my-pi/pi-tui"
import {
  applyRig,
  effectivePool,
  type EngineEnvironment,
} from "../engine"
import {
  parseModelSpec,
  parseRig,
  serializeRig,
  THINKING_LEVELS,
  validateRigName,
  type Rig,
} from "../rig-file"
import * as store from "../store"
import { validateRig } from "../validate"

// allow: SIZE_OK — this module owns the single guided builder and editor state machine required by the host UI.
export type BuilderBase =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "rig"; name: string; rig: Rig }>

export type BuildRigOptions = Readonly<{
  base?: "empty" | "current" | Rig
  name?: string
}>

type RoleEditorResult =
  | Readonly<{ kind: "done"; roles: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "yaml" }>
  | Readonly<{ kind: "cancel" }>

type PoolResult =
  | Readonly<{ kind: "providers"; providers: readonly string[] }>
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "cancel" }>

const LEVEL_CHOICES = ["inherit", ...THINKING_LEVELS] as const

export function rolesFromBase(
  currentRoles: Readonly<Record<string, string>>,
  base: BuilderBase,
): Readonly<Record<string, string>> {
  switch (base.kind) {
    case "empty":
      return { ...currentRoles }
    case "current":
      return { ...currentRoles }
    case "rig":
      return { ...currentRoles, ...base.rig.modelRoles }
  }
}

export function applyModelToRoles(
  roles: Readonly<Record<string, string>>,
  model: string,
): Readonly<Record<string, string>> {
  const names = Object.keys(roles)
  if (!names.includes("default")) names.unshift("default")
  return Object.fromEntries(names.map(role => [role, model]))
}

export function enabledModelsForProviders(
  providers: readonly string[],
  showAll: boolean,
): readonly string[] | undefined {
  if (showAll) return undefined
  return [...new Set(providers)].sort().map(provider => `${provider}/*`)
}

function currentRoles(environment: EngineEnvironment): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment.settings.getModelRoles())
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function authenticatedModels(ctx: ExtensionCommandContext): readonly Model[] {
  return ctx.modelRegistry.getAll()
    .filter(model => ctx.modelRegistry.hasConfiguredAuth(model))
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
}

function modelId(model: Model): string {
  return `${model.provider}/${model.id}`
}

function modelItems(models: readonly Model[]): SelectItem[] {
  return models.map(model => ({
    value: modelId(model),
    label: modelId(model),
    ...(model.name === model.id ? {} : { description: model.name }),
    searchText: `${model.provider} ${model.id} ${model.name}`,
  }))
}

function titledComponent(
  title: string,
  body: Component,
  requestRender: () => void,
  accent: (text: string) => string,
): Component {
  return {
    render(width: number): readonly string[] {
      return [accent(title), "", ...body.render(width)]
    },
    invalidate(): void {
      body.invalidate?.()
    },
    handleInput(data: string): void {
      body.handleInput?.(data)
      requestRender()
    },
  }
}

async function selectValue(
  ctx: ExtensionCommandContext,
  title: string,
  items: readonly SelectItem[],
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    return ctx.ui.select(title, items.map(item => ({
      label: item.label,
      ...(item.description === undefined ? {} : { description: item.description }),
    })))
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const list = new SelectList([...items], Math.min(Math.max(items.length, 4), 15), getSelectListTheme(), {
      search: "always",
    })
    list.onSelect = item => done(item.value)
    list.onCancel = () => done(undefined)
    return titledComponent(
      title,
      list,
      () => tui.requestRender(),
      text => theme.fg("accent", theme.bold(text)),
    )
  })
}

function withLevel(model: string, level: (typeof LEVEL_CHOICES)[number]): string {
  return level === "inherit" ? model : `${model}:${level}`
}

function cycleLevel(
  spec: string,
  direction: -1 | 1,
): string {
  const parsed = parseModelSpec(spec)
  const current = parsed.level ?? "inherit"
  const index = LEVEL_CHOICES.findIndex(level => level === current)
  const next = LEVEL_CHOICES[
    (index + direction + LEVEL_CHOICES.length) % LEVEL_CHOICES.length
  ] ?? "inherit"
  return withLevel(parsed.model, next)
}

async function editRolesTui(
  ctx: ExtensionCommandContext,
  initialRoles: Readonly<Record<string, string>>,
  models: readonly Model[],
  yaml: boolean,
): Promise<RoleEditorResult> {
  let roles = { ...initialRoles }

  while (true) {
    const result = await ctx.ui.custom<RoleEditorResult>((tui, theme, _keybindings, done) => {
      const items: SettingItem[] = Object.keys(roles)
        .sort((left, right) => left.localeCompare(right))
        .map(role => ({
          id: role,
          label: role,
          currentValue: roles[role] ?? "",
          description: "Enter: model · Left/Right: thinking level",
          submenu: (currentValue, selected) => {
            const list = new SelectList(
              modelItems(models),
              Math.min(Math.max(models.length, 4), 15),
              getSelectListTheme(),
              { search: "always" },
            )
            list.setSelectedValue(parseModelSpec(currentValue).model)
            list.onSelect = item => {
              const level = parseModelSpec(currentValue).level ?? "inherit"
              selected(withLevel(item.value, level))
            }
            list.onCancel = () => selected()
            return list
          },
        }))
      items.push({
        id: "$add",
        label: "+ Add role",
        currentValue: "",
        description: "Add a configured or custom role",
      })
      if (yaml) {
        items.push({
          id: "$yaml",
          label: "Edit as YAML",
          currentValue: "",
          description: "Open the complete rig file",
        })
      }
      items.push({
        id: "$done",
        label: "Done",
        currentValue: "",
      })

      const settings = new SettingsList(
        items,
        Math.min(Math.max(items.length, 5), 16),
        getSettingsListTheme(),
        (id, value) => {
          if (!id.startsWith("$")) roles = { ...roles, [id]: value }
        },
        () => done({ kind: "cancel" }),
        {
          layout: "flat",
          hint: "Enter model · Left/Right level · Esc cancel",
        },
      )

      const component: Component = {
        render(width: number): readonly string[] {
          return [
            theme.fg("accent", theme.bold("Role editor")),
            "",
            ...settings.render(width),
          ]
        },
        invalidate(): void {
          settings.invalidate()
        },
        handleInput(data: string): void {
          if (!settings.hasOpenSubmenu()) {
            const selected = settings.getSelectedItem()
            if (data === "\r" || data === "\n") {
              if (selected?.id === "$add") {
                done({ kind: "done", roles: { ...roles, $action: "add" } })
                return
              }
              if (selected?.id === "$yaml") {
                done({ kind: "yaml" })
                return
              }
              if (selected?.id === "$done") {
                done({ kind: "done", roles })
                return
              }
            }
            if (
              selected !== undefined
              && !selected.id.startsWith("$")
              && (data === "\x1b[D" || data === "\x1b[C")
            ) {
              const spec = roles[selected.id]
              if (spec !== undefined) {
                const next = cycleLevel(spec, data === "\x1b[D" ? -1 : 1)
                roles = { ...roles, [selected.id]: next }
                selected.currentValue = next
                tui.requestRender()
              }
              return
            }
          }
          settings.handleInput(data)
          tui.requestRender()
        },
      }
      return component
    })

    if (result.kind !== "done" || result.roles["$action"] !== "add") return result
    const role = await ctx.ui.input("Add role", "role name")
    if (role === undefined) continue
    const trimmed = role.trim()
    if (trimmed.length === 0) {
      ctx.ui.notify("Role name cannot be empty", "error")
      continue
    }
    if (roles[trimmed] !== undefined) {
      ctx.ui.notify(`Role '${trimmed}' already exists`, "error")
      continue
    }
    const firstModel = models[0]
    const fallback = roles["default"] ?? (firstModel === undefined ? "" : modelId(firstModel))
    roles = { ...roles, [trimmed]: fallback }
  }
}

async function editRolesRpc(
  ctx: ExtensionCommandContext,
  initialRoles: Readonly<Record<string, string>>,
  models: readonly Model[],
): Promise<RoleEditorResult> {
  let roles = { ...initialRoles }
  while (true) {
    const choice = await ctx.ui.select("Role editor", [
      ...Object.entries(roles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, spec]) => ({ label: role, description: spec })),
      "+ Add role",
      "Done",
    ])
    if (choice === undefined) return { kind: "cancel" }
    if (choice === "Done") return { kind: "done", roles }
    if (choice === "+ Add role") {
      const role = await ctx.ui.input("Add role", "role name")
      if (role === undefined) continue
      const trimmed = role.trim()
      if (trimmed.length === 0 || roles[trimmed] !== undefined) {
        ctx.ui.notify(
          trimmed.length === 0 ? "Role name cannot be empty" : `Role '${trimmed}' already exists`,
          "error",
        )
        continue
      }
      const firstModel = models[0]
      roles = {
        ...roles,
        [trimmed]: roles["default"] ?? (firstModel === undefined ? "" : modelId(firstModel)),
      }
      continue
    }

    const selectedModel = await selectValue(ctx, `Model for ${choice}`, modelItems(models))
    if (selectedModel === undefined) continue
    const level = await ctx.ui.select("Thinking level", [...LEVEL_CHOICES])
    if (level === undefined) continue
    const selectedLevel = LEVEL_CHOICES.find(candidate => candidate === level)
    if (selectedLevel === undefined) continue
    roles = { ...roles, [choice]: withLevel(selectedModel, selectedLevel) }
  }
}

async function editRoles(
  ctx: ExtensionCommandContext,
  roles: Readonly<Record<string, string>>,
  models: readonly Model[],
  yaml: boolean,
): Promise<RoleEditorResult> {
  return ctx.mode === "tui"
    ? editRolesTui(ctx, roles, models, yaml)
    : editRolesRpc(ctx, roles, models)
}

async function choosePoolTui(
  ctx: ExtensionCommandContext,
  providers: readonly string[],
  usedProviders: readonly string[],
  roles: Readonly<Record<string, string>>,
  environment: EngineEnvironment,
): Promise<PoolResult> {
  const included = new Set(usedProviders)
  return ctx.ui.custom<PoolResult>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = providers.map(provider => ({
      id: provider,
      label: provider,
      currentValue: included.has(provider) ? "included" : "excluded",
      values: ["included", "excluded"],
    }))
    items.push(
      {
        id: "$all",
        label: "Show all models",
        currentValue: "",
      },
      {
        id: "$done",
        label: "Done",
        currentValue: "Only providers used by this rig",
      },
    )
    const settings = new SettingsList(
      items,
      Math.min(Math.max(items.length, 5), 15),
      getSettingsListTheme(),
      (id, value) => {
        if (id.startsWith("$")) return
        if (value === "included") included.add(id)
        else included.delete(id)
      },
      () => done({ kind: "cancel" }),
      {
        layout: "flat",
        hint: "Enter toggles provider · Done keeps this pool · Esc cancel",
      },
    )
    return {
      render(width: number): readonly string[] {
        const enabledModels = enabledModelsForProviders([...included], false)
        const pool = effectivePool(
          { modelRoles: roles, ...(enabledModels === undefined ? {} : { enabledModels }) },
          environment.ctx.modelRegistry,
        )
        const blocked = pool.disabledProviders.length === 0
          ? "none"
          : pool.disabledProviders.join(", ")
        return [
          theme.fg("accent", theme.bold("Model pool")),
          theme.fg("dim", `Engine will block: ${blocked}`),
          "",
          ...settings.render(width),
        ]
      },
      invalidate(): void {
        settings.invalidate()
      },
      handleInput(data: string): void {
        const selected = settings.getSelectedItem()
        if (!settings.hasOpenSubmenu() && (data === "\r" || data === "\n")) {
          if (selected?.id === "$all") {
            done({ kind: "all" })
            return
          }
          if (selected?.id === "$done") {
            done({ kind: "providers", providers: [...included].sort() })
            return
          }
        }
        settings.handleInput(data)
        tui.requestRender()
      },
    }
  })
}

async function choosePool(
  ctx: ExtensionCommandContext,
  models: readonly Model[],
  roles: Readonly<Record<string, string>>,
  environment: EngineEnvironment,
): Promise<PoolResult> {
  const providers = [...new Set(models.map(model => model.provider))].sort()
  const usedProviders = [...new Set(
    Object.values(roles).map(spec => parseModelSpec(spec).model.split("/", 1)[0] ?? ""),
  )].filter(Boolean).sort()

  if (ctx.mode === "tui") {
    return choosePoolTui(ctx, providers, usedProviders, roles, environment)
  }

  const policy = await ctx.ui.select("Model pool", [
    {
      label: "Only providers used by this rig",
      description: usedProviders.join(", "),
    },
    "Show all models",
  ])
  if (policy === undefined) return { kind: "cancel" }
  return policy === "Show all models"
    ? { kind: "all" }
    : { kind: "providers", providers: usedProviders }
}

async function previewRig(
  ctx: ExtensionCommandContext,
  yaml: string,
): Promise<boolean> {
  if (ctx.mode !== "tui") return ctx.ui.confirm("Preview", yaml)
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => ({
    render(): readonly string[] {
      return [
        theme.fg("accent", theme.bold("Preview")),
        "",
        ...yaml.trimEnd().split("\n"),
        "",
        theme.fg("dim", "Enter continue · Esc cancel"),
      ]
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (data === "\r" || data === "\n") done(true)
      else if (data === "\x1b") done(false)
      else tui.requestRender()
    },
  }))
}

async function inputName(
  ctx: ExtensionCommandContext,
  initial: string | undefined,
): Promise<string | undefined> {
  let placeholder = initial ?? "rig name"
  while (true) {
    const value = await ctx.ui.input("Rig name", placeholder)
    if (value === undefined) return undefined
    const name = value.trim()
    const error = validateRigName(name)
    if (error !== undefined) {
      ctx.ui.notify(error.message, "error")
      placeholder = name
      continue
    }
    if ((await store.list()).some(entry => entry.name === name)) {
      ctx.ui.notify(`Rig '${name}' already exists`, "error")
      placeholder = name
      continue
    }
    return name
  }
}

async function inputDescription(
  ctx: ExtensionCommandContext,
): Promise<string | undefined | null> {
  while (true) {
    const value = await ctx.ui.input("Description", "optional")
    if (value === undefined) return null
    if (value.length <= 120) return value.trim().length === 0 ? undefined : value
    ctx.ui.notify("Description must be at most 120 characters", "error")
  }
}

function checkedRig(
  rig: Rig,
  environment: EngineEnvironment,
): Rig | undefined {
  const parsed = parseRig(serializeRig(rig), "preview")
  if (!parsed.ok) return undefined
  const validation = validateRig(parsed.rig, environment.ctx.modelRegistry)
  return validation.ok ? parsed.rig : undefined
}

export function builderBase(base: BuildRigOptions["base"]): BuilderBase | undefined {
  if (base === undefined) return undefined
  if (base === "empty") return { kind: "empty" }
  if (base === "current") return { kind: "current" }
  return { kind: "rig", name: "base", rig: base }
}

export async function buildRig(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  options: BuildRigOptions = {},
): Promise<void> {
  const models = authenticatedModels(ctx)
  if (models.length === 0) {
    ctx.ui.notify("No authenticated chat models are available", "error")
    return
  }

  const current = currentRoles(environment)
  const entries = await store.list()
  let base: BuilderBase | undefined = builderBase(options.base)
  if (base === undefined) {
    const choice = await selectValue(ctx, "Start from", [
      { value: "empty", label: "Empty" },
      { value: "current", label: "Current setup" },
      ...entries
        .filter((entry): entry is typeof entry & { rig: Rig } => entry.rig !== undefined)
        .map(entry => ({
          value: `copy:${entry.name}`,
          label: `Copy of ${entry.name}`,
        })),
    ])
    if (choice === undefined) return
    if (choice === "empty") base = { kind: "empty" }
    else if (choice === "current") base = { kind: "current" }
    else {
      const name = choice.slice("copy:".length)
      const copied = entries.find(entry => entry.name === name)
      if (copied?.rig === undefined) {
        ctx.ui.notify(`Rig '${name}' is unavailable`, "error")
        return
      }
      base = { kind: "rig", name, rig: copied.rig }
    }
  }

  const selectedModel = await selectValue(
    ctx,
    "Pick one model for all roles",
    modelItems(models),
  )
  if (selectedModel === undefined) return
  const initialRoles = applyModelToRoles(rolesFromBase(current, base), selectedModel)
  const edited = await editRoles(ctx, initialRoles, models, false)
  if (edited.kind !== "done") return

  const pool = await choosePool(ctx, models, edited.roles, environment)
  if (pool.kind === "cancel") return
  const enabledModels = enabledModelsForProviders(
    pool.kind === "providers" ? pool.providers : [],
    pool.kind === "all",
  )
  const name = await inputName(ctx, options.name)
  if (name === undefined) return
  const description = await inputDescription(ctx)
  if (description === null) return

  const candidate: Rig = {
    ...(description === undefined ? {} : { description }),
    modelRoles: edited.roles,
    ...(enabledModels === undefined ? {} : { enabledModels }),
  }
  const rig = checkedRig(candidate, environment)
  if (rig === undefined) {
    const validation = validateRig(candidate, environment.ctx.modelRegistry)
    ctx.ui.notify(
      validation.errors.map(error => error.message).join("\n") || "Rig is invalid",
      "error",
    )
    return
  }
  const yaml = serializeRig(rig)
  if (!(await previewRig(ctx, yaml))) return
  if (!(await ctx.ui.confirm("Save rig", `Save rig '${name}'?`))) return

  await store.write(name, rig)
  ctx.ui.notify(`rig:${name} saved`, "info")
  if (await ctx.ui.confirm("Apply now?", `Apply rig '${name}' to this session?`)) {
    const result = await applyRig({ kind: "rig", name }, "session", environment)
    ctx.ui.notify(
      result.ok ? result.summary : result.errors.join("\n"),
      result.ok ? "info" : "error",
    )
  }
}

function rigErrorText(result: ReturnType<typeof parseRig>): string {
  if (result.ok) return ""
  return result.errors.map(error =>
    `${error.path}${error.line === undefined ? "" : `:${error.line}`}: ${error.message}`)
    .join("\n")
}

async function editAsYaml(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  name: string,
  original: Rig,
): Promise<void> {
  let draft = serializeRig(original)
  while (true) {
    const edited = await ctx.ui.editor(`Edit rig: ${name}`, draft)
    if (edited === undefined) return
    draft = edited
    const parsed = parseRig(draft, `${name}.yml`)
    if (!parsed.ok) {
      ctx.ui.notify(rigErrorText(parsed), "error")
      continue
    }
    const validation = validateRig(parsed.rig, environment.ctx.modelRegistry)
    if (!validation.ok) {
      ctx.ui.notify(validation.errors.map(error => error.message).join("\n"), "error")
      continue
    }
    await store.write(name, parsed.rig)
    ctx.ui.notify(`rig:${name} updated`, "info")
    return
  }
}

export async function editRig(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  name: string,
): Promise<void> {
  const original = await store.read(name)
  const models = authenticatedModels(ctx)
  if (models.length === 0) {
    ctx.ui.notify("No authenticated chat models are available", "error")
    return
  }
  const result = await editRoles(ctx, original.modelRoles, models, ctx.mode === "tui")
  if (result.kind === "cancel") return
  if (result.kind === "yaml") {
    await editAsYaml(ctx, environment, name, original)
    return
  }

  const candidate: Rig = { ...original, modelRoles: result.roles }
  const validation = validateRig(candidate, environment.ctx.modelRegistry)
  if (!validation.ok) {
    ctx.ui.notify(validation.errors.map(error => error.message).join("\n"), "error")
    return
  }
  if (!(await ctx.ui.confirm("Save changes", `Update rig '${name}'?`))) return
  await store.write(name, candidate)
  ctx.ui.notify(`rig:${name} updated`, "info")
}
