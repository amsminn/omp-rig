import { homedir } from "node:os"
import { resolve } from "node:path"
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent"
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"
import {
  Container,
  Input,
  SelectList,
  Text,
  type SelectItem,
} from "@oh-my-pi/pi-tui"
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme"
import {
  applyRig,
  effectivePool,
  inherit,
  turnOff,
  type EngineEnvironment,
  type EngineResult,
} from "../engine"
import { maskRoles } from "../host"
import { validateRigName, type Rig } from "../rig-file"
import {
  readMarkers,
  type RigSource,
  type Scope,
  type ScopeMarkers,
} from "../scope"
import * as store from "../store"

// allow: SIZE_OK — this module owns the plan's complete action-menu and dialog state machine.
export type ActionId =
  | "apply-session"
  | "apply-project"
  | "apply-global"
  | "edit"
  | "update"
  | "rename"
  | "duplicate"
  | "export"
  | "remove"
  | "default-session"
  | "default-project"
  | "default-global"
  | "inherit-project"
  | "inherit-session"
  | "save"
  | "show"

export type ActionItem = Readonly<{
  id: ActionId
  label: string
}>

export type ActionUi = Readonly<{
  input: (title: string, initial?: string) => Promise<string | undefined>
  confirm: (title: string, message: string) => Promise<boolean>
  notify: (message: string, type?: "info" | "warning" | "error") => void
}>

export type ActionRuntime = Readonly<{
  ui: ActionUi
  source: RigSource | null
  rig: Rig
  markers: ScopeMarkers
  detailLines: readonly string[]
  roleCount: () => number
  currentRig: (description?: string) => Rig
  listRigNames: () => Promise<readonly string[]>
  apply: (source: RigSource, scope: Scope) => Promise<EngineResult>
  turnOff: (scope: Scope) => Promise<EngineResult>
  inherit: (scope: Scope) => Promise<EngineResult>
  write: (name: string, rig: Rig) => Promise<void>
  rename: (oldName: string, newName: string) => Promise<void>
  duplicate: (source: string, destination: string) => Promise<void>
  export: (name: string, path: string) => Promise<void>
  remove: (name: string) => Promise<void>
  edit: (name: string) => Promise<void>
}>

export type ActionOutcome = "close" | "refresh"

const APPLY_ACTIONS = [
  { id: "apply-session", label: "Apply (this session)" },
  { id: "apply-project", label: "Apply to this project" },
  { id: "apply-global", label: "Apply as global default" },
] as const satisfies readonly ActionItem[]

function sourceMatches(
  marker: ScopeMarkers[Scope],
  source: RigSource,
): boolean {
  return marker.kind === "source"
    && marker.source.kind === source.kind
    && marker.source.name === source.name
}

export function buildActionItems(
  source: RigSource | null,
  markers: ScopeMarkers,
): readonly ActionItem[] {
  if (source === null) {
    return [
      { id: "default-session", label: "Use default (this session)" },
      { id: "default-project", label: "Use default for this project" },
      { id: "default-global", label: "Use default globally" },
      ...(markers.project.kind === "missing"
        ? []
        : [{
            id: "inherit-project",
            label: "Inherit (clear this project's choice)",
          } as const]),
      ...(markers.session.kind === "missing"
        ? []
        : [{
            id: "inherit-session",
            label: "Inherit (clear this session's choice)",
          } as const]),
      { id: "save", label: "Save as rig" },
    ]
  }

  if (source.kind === "profile") {
    return [
      ...APPLY_ACTIONS,
      { id: "save", label: "Save as rig" },
      { id: "show", label: "Show" },
    ]
  }

  return [
    ...APPLY_ACTIONS,
    { id: "edit", label: "Edit" },
    { id: "update", label: "Update with current setup" },
    { id: "rename", label: "Rename" },
    { id: "duplicate", label: "Duplicate" },
    { id: "export", label: "Export" },
    { id: "remove", label: "Remove" },
  ]
}

export function buildDetailLines(
  rig: Rig,
  inheritedRoles: readonly string[],
  disabledProviders: readonly string[],
): readonly string[] {
  const roleNames = [...new Set([
    ...inheritedRoles,
    ...Object.keys(rig.modelRoles),
  ])]
  roleNames.sort((left, right) => {
    if (left === "default") return -1
    if (right === "default") return 1
    return left.localeCompare(right)
  })

  const roles = roleNames.map(role => {
    const spec = rig.modelRoles[role]
    return `${role}  ${spec ?? "(inherits default)"}`
  })
  const pool = rig.enabledModels === undefined || rig.enabledModels.length === 0
    ? "all"
    : rig.enabledModels.join(", ")
  const blocked = disabledProviders.length === 0
    ? "none"
    : disabledProviders.join(", ")
  return [...roles, `pool  ${pool}`, `blocked  ${blocked}`]
}

function resultText(result: EngineResult): string {
  return result.ok
    ? result.summary
    : [...result.errors, ...result.warnings].join("\n")
}

function scopeForAction(action: ActionId): Scope | undefined {
  switch (action) {
    case "apply-session":
    case "default-session":
    case "inherit-session":
      return "session"
    case "apply-project":
    case "default-project":
    case "inherit-project":
      return "project"
    case "apply-global":
    case "default-global":
      return "global"
    default:
      return undefined
  }
}

async function inputRigName(
  runtime: ActionRuntime,
  title: string,
  initial: string,
): Promise<string | undefined> {
  let value = initial
  while (true) {
    const answer = await runtime.ui.input(title, value)
    if (answer === undefined) return undefined
    const name = answer.trim()
    const validation = validateRigName(name)
    if (validation !== undefined) {
      runtime.ui.notify(validation.message, "error")
      value = name
      continue
    }
    if ((await runtime.listRigNames()).includes(name)) {
      runtime.ui.notify(`Rig '${name}' already exists`, "error")
      value = name
      continue
    }
    return name
  }
}

async function saveAsRig(runtime: ActionRuntime): Promise<void> {
  const name = await inputRigName(runtime, "Rig name", runtime.source?.name ?? "")
  if (name === undefined) return
  await runtime.write(name, runtime.rig)
  runtime.ui.notify(`Rig '${name}' saved`, "info")
}

async function renameRig(runtime: ActionRuntime, source: RigSource): Promise<void> {
  let initial = source.name
  while (true) {
    const name = await inputRigName(runtime, "Rename rig", initial)
    if (name === undefined) return
    try {
      await runtime.rename(source.name, name)
      runtime.ui.notify(`Rig '${source.name}' renamed to '${name}'`, "info")
      return
    } catch (error) {
      if (!(error instanceof Error)) throw error
      runtime.ui.notify(error.message, "error")
      initial = name
    }
  }
}

async function duplicateRig(runtime: ActionRuntime, source: RigSource): Promise<void> {
  const name = await inputRigName(runtime, "Duplicate rig", `${source.name}-copy`)
  if (name === undefined) return
  await runtime.duplicate(source.name, name)
  runtime.ui.notify(`Rig '${source.name}' duplicated as '${name}'`, "info")
}

async function removeRig(runtime: ActionRuntime, source: RigSource): Promise<void> {
  if (!await runtime.ui.confirm("Remove rig", `Remove rig '${source.name}'?`)) return
  for (const scope of ["session", "project", "global"] as const) {
    if (!sourceMatches(runtime.markers[scope], source)) continue
    const result = await runtime.turnOff(scope)
    if (!result.ok) {
      runtime.ui.notify(resultText(result), "error")
      return
    }
  }
  await runtime.remove(source.name)
  runtime.ui.notify(`Rig '${source.name}' removed`, "info")
}

export async function dispatchAction(
  action: ActionId,
  runtime: ActionRuntime,
): Promise<ActionOutcome> {
  const scope = scopeForAction(action)
  if (action.startsWith("apply-")) {
    if (runtime.source === null || scope === undefined) return "refresh"
    const result = await runtime.apply(runtime.source, scope)
    if (!result.ok) {
      runtime.ui.notify(resultText(result), "error")
      return "close"
    }
    runtime.ui.notify(
      `Rig '${runtime.source.name}' applied to ${runtime.roleCount()} roles for ${scope} scope`,
      "info",
    )
    return "close"
  }

  if (action.startsWith("default-")) {
    if (scope === undefined) return "refresh"
    const result = await runtime.turnOff(scope)
    runtime.ui.notify(resultText(result), result.ok ? "info" : "error")
    return "refresh"
  }

  if (action.startsWith("inherit-")) {
    if (scope === undefined) return "refresh"
    const result = await runtime.inherit(scope)
    runtime.ui.notify(resultText(result), result.ok ? "info" : "error")
    return "refresh"
  }

  const source = runtime.source
  switch (action) {
    case "edit":
      if (source?.kind === "rig") await runtime.edit(source.name)
      return "refresh"
    case "update":
      if (
        source?.kind === "rig"
        && await runtime.ui.confirm(
          "Update rig",
          `Overwrite rig '${source.name}' with the current setup?`,
        )
      ) {
        await runtime.write(source.name, runtime.currentRig(runtime.rig.description))
        runtime.ui.notify(`Rig '${source.name}' updated`, "info")
      }
      return "refresh"
    case "rename":
      if (source?.kind === "rig") await renameRig(runtime, source)
      return "refresh"
    case "duplicate":
      if (source?.kind === "rig") await duplicateRig(runtime, source)
      return "refresh"
    case "export":
      if (source?.kind === "rig") {
        const suggested = resolve(homedir(), `${source.name}.yml`)
        const path = await runtime.ui.input("Export rig", suggested)
        if (path !== undefined) {
          await runtime.export(source.name, path)
          runtime.ui.notify(`Rig '${source.name}' exported to ${path}`, "info")
        }
      }
      return "refresh"
    case "remove":
      if (source?.kind === "rig") await removeRig(runtime, source)
      return "refresh"
    case "save":
      await saveAsRig(runtime)
      return "refresh"
    case "show":
      runtime.ui.notify(runtime.detailLines.join("\n"), "info")
      return "refresh"
    case "apply-session":
    case "apply-project":
    case "apply-global":
    case "default-session":
    case "default-project":
    case "default-global":
    case "inherit-project":
    case "inherit-session":
      return "refresh"
  }
}

function rigFromSettings(
  settings: EngineEnvironment["settings"],
  environment: EngineEnvironment,
  description?: string,
): Rig {
  const modelRoles = Object.fromEntries(
    Object.entries(settings.getModelRoles())
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (modelRoles["default"] === undefined) {
    const model = environment.ctx.model
    if (model !== undefined) modelRoles["default"] = `${model.provider}/${model.id}`
  }
  if (modelRoles["default"] === undefined) {
    throw new Error("Current setup has no default model role")
  }
  return {
    ...(description === undefined ? {} : { description }),
    modelRoles,
    enabledModels: [...environment.handles.enabledModels.get(settings)],
    disabledProviders: [...environment.handles.disabledProviders.get(settings)],
  }
}

async function loadSource(
  source: RigSource | null,
  environment: EngineEnvironment,
): Promise<Rig> {
  if (source === null) {
    const settings = await Settings.loadReadOnly({
      cwd: environment.scope.cwd,
      agentDir: environment.scope.agentDir,
    })
    return rigFromSettings(settings, environment)
  }
  if (source.kind === "rig") return store.read(source.name)
  const profile = (await store.listProfiles())
    .find(entry => entry.name === source.name)
  if (profile?.rig !== undefined) return profile.rig
  throw new Error(
    profile === undefined
      ? `profile "${source.name}" not found`
      : profile.errors.map(error => error.message).join("\n"),
  )
}

async function inputValue(
  ctx: ExtensionCommandContext,
  title: string,
  initial = "",
): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.input(title, initial)
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const input = new Input()
    input.setValue(initial)
    input.onSubmit = value => done(value)
    input.onEscape = () => done(undefined)
    return {
      render(width: number): readonly string[] {
        return [
          theme.fg("accent", theme.bold(title)),
          "",
          ...input.render(width),
          "",
          theme.fg("dim", "Enter confirm · Esc cancel"),
        ]
      },
      invalidate(): void {
        input.invalidate()
      },
      handleInput(data: string): void {
        input.handleInput(data)
        tui.requestRender()
      },
    }
  })
}

type ActionSelection = Readonly<{
  ctx: ExtensionCommandContext
  title: string
  detailLines: readonly string[]
  items: readonly ActionItem[]
}>

async function selectAction(
  selection: ActionSelection,
): Promise<ActionId | undefined> {
  const { ctx, title, detailLines, items } = selection
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select(title, items.map(item => item.label))
    return items.find(item => item.label === selected)?.id
  }
  return ctx.ui.custom<ActionId | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container()
    const header = new Text(title, 1, 0)
      .setStyleFn(text => theme.fg("accent", theme.bold(text)))
    const details = new Text(detailLines.join("\n"), 1, 0)
      .setStyleFn(text => theme.fg("dim", text))
    const selectItems: SelectItem[] = items.map(item => ({
      value: item.id,
      label: item.label,
    }))
    const list = new SelectList(
      selectItems,
      Math.min(Math.max(selectItems.length, 4), 14),
      getSelectListTheme(),
      { search: "never" },
    )
    list.onSelect = item => {
      const selected = items.find(action => action.id === item.value)
      done(selected?.id)
    }
    list.onCancel = () => done(undefined)
    const footer = new Text("↑↓ move  Enter select  Esc back", 1, 0)
      .setStyleFn(text => theme.fg("dim", text))
    container.addChild(header)
    container.addChild(details)
    container.addChild(list)
    container.addChild(footer)
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data)
        tui.requestRender()
      },
    }
  })
}

async function openManager(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  const modulePath = "./manager"
  const module = await import(modulePath) as Readonly<{
    openManager?: (
      context: ExtensionCommandContext,
      env: EngineEnvironment,
    ) => Promise<void>
  }>
  if (module.openManager === undefined) throw new Error("Rig manager is unavailable")
  await module.openManager(ctx, environment)
}

async function editRig(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  name: string,
): Promise<void> {
  const modulePath = "./builder"
  const module = await import(modulePath) as Readonly<{
    editRig?: (
      context: ExtensionCommandContext,
      env: EngineEnvironment,
      rigName: string,
    ) => Promise<void>
  }>
  if (module.editRig === undefined) throw new Error("Rig editor is unavailable")
  await module.editRig(ctx, environment, name)
}

export async function saveCurrentSetup(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  const runtime = await createRuntime({
    ctx,
    environment,
    source: null,
    rig: rigFromSettings(environment.settings, environment),
  })
  const name = await inputRigName(runtime, "Rig name", "")
  if (name === undefined) return
  const description = await inputValue(ctx, "Description")
  if (description === undefined) return
  const rig = runtime.currentRig(description.trim() || undefined)
  await runtime.write(name, rig)
  runtime.ui.notify(`Rig '${name}' saved`, "info")
  if (await runtime.ui.confirm("Apply now?", `Apply rig '${name}' to this session?`)) {
    const result = await runtime.apply({ kind: "rig", name }, "session")
    runtime.ui.notify(resultText(result), result.ok ? "info" : "error")
  }
}

type RuntimeInput = Readonly<{
  ctx: ExtensionCommandContext
  environment: EngineEnvironment
  source: RigSource | null
  rig: Rig
}>

async function createRuntime(
  input: RuntimeInput,
): Promise<ActionRuntime> {
  const { ctx, environment, source, rig } = input
  const markers = await readMarkers(environment.scope)
  const pool = effectivePool(rig, environment.ctx.modelRegistry)
  const detailLines = buildDetailLines(
    rig,
    maskRoles(environment.settings),
    pool.disabledProviders,
  )
  return {
    ui: {
      input: (title, initial) => inputValue(ctx, title, initial),
      confirm: (title, message) => ctx.ui.confirm(title, message),
      notify: (message, type) => ctx.ui.notify(message, type),
    },
    source,
    rig,
    markers,
    detailLines,
    roleCount: () => Object.keys(environment.settings.getModelRoles()).length,
    currentRig: description =>
      rigFromSettings(environment.settings, environment, description),
    listRigNames: async () => (await store.list()).map(entry => entry.name),
    apply: (selected, scope) => applyRig(selected, scope, environment),
    turnOff: scope => turnOff(scope, environment),
    inherit: scope => inherit(scope, environment),
    write: store.write,
    rename: store.rename,
    duplicate: store.duplicate,
    export: (name, path) => store.exportFile(name, path),
    remove: store.remove,
    edit: name => editRig(ctx, environment, name),
  }
}

export async function openActions(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  source: RigSource | null,
): Promise<void> {
  const rig = await loadSource(source, environment)
  const runtime = await createRuntime({ ctx, environment, source, rig })
  const title = source === null ? "default" : `${source.kind}: ${source.name}`
  const items = buildActionItems(source, runtime.markers)
  const action = await selectAction({
    ctx,
    title,
    detailLines: runtime.detailLines,
    items,
  })
  if (action === undefined) {
    await openManager(ctx, environment)
    return
  }
  const outcome = await dispatchAction(action, runtime)
  if (outcome === "refresh") await openManager(ctx, environment)
}
