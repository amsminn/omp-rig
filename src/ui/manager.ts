import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent"
import {
  Container,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
} from "@oh-my-pi/pi-tui"
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme"
import { baselineView,
  applyRig,
  turnOff,
  type EngineEnvironment,
} from "../engine"
import type { Rig } from "../rig-file"
import {
  effective,
  readMarkers,
  type RigSource,
  type Scope,
} from "../scope"
import * as store from "../store"
import { healthOf, type RigHealth } from "../validate"
import * as actionsUi from "./actions"
import * as builderUi from "./builder"

const PRIMARY_ROLES = ["default", "smol", "slow", "plan", "task"] as const
const SCOPES = ["session", "project", "global"] as const

type SourceInput = Readonly<{
  name: string
  rig?: Rig
  errors?: readonly Readonly<{ message: string }>[]
  health?: RigHealth
}>

export type ManagerItem =
  | Readonly<SelectItem & {
      kind: "source"
      source: RigSource | null
      healthDetail: string
    }>
  | Readonly<SelectItem & {
      kind: "separator"
      healthDetail: ""
    }>
  | Readonly<SelectItem & {
      kind: "action"
      action: "save" | "build" | "off" | "check"
      healthDetail: string
    }>

export type ManagerItemsInput = Readonly<{
  defaultRig: Rig
  rigs: readonly SourceInput[]
  profiles: readonly SourceInput[]
  active: RigSource | null
  activeScope?: Scope
}>

type ManagerRowStyle = Readonly<{
  prefix?: (text: string) => string
  label?: (text: string) => string
  description?: (text: string) => string
}>

export function renderManagerRow(
  item: SelectItem,
  width: number,
  selected = false,
  style: ManagerRowStyle = {},
): string {
  const maxWidth = Math.max(0, Math.trunc(width))
  if (maxWidth === 0) return ""

  const prefixText = truncateToWidth(selected ? "> " : "  ", maxWidth)
  const prefix = (style.prefix ?? (text => text))(prefixText)
  const available = maxWidth - visibleWidth(prefixText)
  if (available <= 0) return prefix

  const styleLabel = style.label ?? (text => text)
  const styleDescription = style.description ?? (text => text)
  if (item.description === undefined || available < 4) {
    return `${prefix}${styleLabel(truncateToWidth(item.label, available))}`
  }

  const gapWidth = 2
  const preferredPrimaryWidth = Math.min(
    40,
    Math.max(12, Math.floor(maxWidth / 4)),
  )
  const primaryWidth = Math.min(
    preferredPrimaryWidth,
    Math.max(1, available - gapWidth - 1),
  )
  const descriptionWidth = available - primaryWidth - gapWidth
  if (descriptionWidth <= 0) {
    return `${prefix}${styleLabel(truncateToWidth(item.label, available))}`
  }

  const rawLabel = truncateToWidth(item.label, primaryWidth)
  const label = `${rawLabel}${" ".repeat(
    Math.max(0, primaryWidth - visibleWidth(rawLabel)),
  )}`
  const description = truncateToWidth(item.description, descriptionWidth)
  return `${prefix}${styleLabel(label)}  ${styleDescription(description)}`
}

function orderedRoles(rig: Rig): readonly string[] {
  const roles = Object.keys(rig.modelRoles)
  const primary = PRIMARY_ROLES.filter(role => roles.includes(role))
  const remaining = roles
    .filter(role => !(PRIMARY_ROLES as readonly string[]).includes(role))
    .sort((left, right) => left.localeCompare(right))
  return [...primary, ...remaining]
}

export function previewLine(rig: Rig, width?: number): string {
  const roles = orderedRoles(rig)
    .map(role => `${role}=${rig.modelRoles[role]}`)
  const pool = rig.enabledModels === undefined || rig.enabledModels.length === 0
    ? "all"
    : rig.enabledModels.join(",")
  const line = [...roles, `pool=${pool}`].join("  ")
  return width === undefined ? line : truncateToWidth(line, width)
}

function activeSuffix(
  source: RigSource | null,
  active: RigSource | null,
  scope?: Scope,
): string {
  const selected = source === null
    ? active === null
    : active?.kind === source.kind && active.name === source.name
  return selected ? `  ●${scope === undefined ? "" : ` ${scope}`}` : ""
}

function healthLabel(input: SourceInput): string {
  if (input.errors !== undefined) return "invalid"
  switch (input.health) {
    case "missing-credentials":
      return "missing credentials"
    case "unknown-model":
      return "unknown model"
    case "empty-pool":
      return "empty pool"
    default:
      return "ok"
  }
}

function sourceItem(
  kind: RigSource["kind"],
  input: SourceInput,
  active: RigSource | null,
  activeScope?: Scope,
): ManagerItem {
  const source = { kind, name: input.name } as const
  const health = healthLabel(input)
  const detail = input.errors?.map(error => error.message).join("; ")
    ?? (health === "ok" ? "Ready" : health)
  return {
    kind: "source",
    source,
    value: `${kind}:${input.name}`,
    label: `${kind}: ${input.name}${activeSuffix(source, active, activeScope)}  ${health}`,
    description: input.rig === undefined ? "invalid" : previewLine(input.rig),
    healthDetail: detail,
  }
}

export function buildManagerItems(input: ManagerItemsInput): ManagerItem[] {
  const items: ManagerItem[] = [{
    kind: "source",
    source: null,
    value: "default",
    label: `default${activeSuffix(null, input.active, input.activeScope)}`,
    description: previewLine(input.defaultRig),
    healthDetail: "Your omp configuration without a rig",
  }]

  items.push(...input.rigs.map(rig =>
    sourceItem("rig", rig, input.active, input.activeScope)))
  items.push(...input.profiles.map(profile =>
    sourceItem("profile", profile, input.active, input.activeScope)))
  items.push({
    kind: "separator",
    value: "separator",
    label: "─",
    disabled: true,
    healthDetail: "",
  })
  items.push({
    kind: "action",
    action: "save",
    value: "action:save",
    label: "+ Save current setup as new rig",
    healthDetail: "Save the effective model roles and pool",
  })
  items.push({
    kind: "action",
    action: "build",
    value: "action:build",
    label: "+ Build new rig",
    healthDetail: "Build a rig one step at a time",
  })
  if (input.active !== null) {
    items.push({
      kind: "action",
      action: "off",
      value: "action:off",
      label: "Turn off rig",
      healthDetail: "Use your omp configuration at the target scope",
    })
  }
  items.push({
    kind: "action",
    action: "check",
    value: "action:check",
    label: "Check all rigs",
    healthDetail: "Validate every rig against available models",
  })
  return items
}

async function baselineRig(environment: EngineEnvironment): Promise<Rig> {
  const view = baselineView(environment)
  const modelRoles: Record<string, string> = { ...view.modelRoles }
  const activeModel = environment.ctx.model
  if (modelRoles["default"] === undefined && activeModel !== undefined) {
    modelRoles["default"] = `${activeModel.provider}/${activeModel.id}`
  }
  if (modelRoles["default"] === undefined) {
    throw new Error("Current setup has no default model role")
  }
  return {
    modelRoles,
    enabledModels: [...view.enabledModels],
    disabledProviders: [...view.disabledProviders],
  }
}

async function openActions(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  source: RigSource | null,
): Promise<void> {
  await actionsUi.openActions(ctx, environment, source)
}

async function openBuilder(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  await builderUi.buildRig(ctx, environment, { base: "empty" })
}

async function saveCurrent(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  await actionsUi.saveCurrentSetup(ctx, environment)
}

function reportError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
}

export async function openManager(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  const [defaultRig, rigs, profiles, markers] = await Promise.all([
    baselineRig(environment),
    store.list(),
    store.listProfiles(),
    readMarkers(environment.scope),
  ])
  const selected = effective(markers)
  const active = selected.source === null || "missing" in selected.source
    ? null
    : selected.source
  const activeScope = selected.source === null ? undefined : selected.scope
  const rigInputs = rigs.map(entry => ({
    name: entry.name,
    ...(entry.rig === undefined
      ? { errors: entry.errors }
      : {
          rig: entry.rig,
          health: healthOf(entry.rig, environment.ctx.modelRegistry),
        }),
  }))
  const profileInputs = profiles.map(entry => ({
    name: entry.name,
    ...(entry.rig === undefined
      ? { errors: entry.errors }
      : {
          rig: entry.rig,
          health: healthOf(entry.rig, environment.ctx.modelRegistry),
        }),
  }))
  const items = buildManagerItems({
    defaultRig,
    rigs: rigInputs,
    profiles: profileInputs,
    active,
    ...(activeScope === undefined ? {} : { activeScope }),
  })
  let targetScope: Scope = "session"

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container()
    const header = new Text("", 1, 0)
      .setStyleFn(text => theme.fg("accent", theme.bold(text)))
    const list = new SelectList(
      items,
      Math.min(Math.max(items.length, 6), 18),
      getSelectListTheme(),
      {
        search: "always",
        wrapDescription: false,
        renderItem: ({ item, width, selected, theme: listTheme }) => [
          renderManagerRow(item, width, selected, {
            ...(selected
              ? {
                  prefix: listTheme.selectedPrefix,
                  label: listTheme.selectedText,
                }
              : {}),
            description: listTheme.description,
          }),
        ],
        measureItem: () => 1,
      },
    )
    const detail = new Text(items[0]?.healthDetail ?? "", 1, 0)
      .setStyleFn(text => theme.fg("dim", text))
    const footnote = new Text(
      profiles.length === 0
        ? ""
        : "profile: entries apply only that profile's model settings - login, sessions and other settings stay in the current profile",
      1,
      0,
    ).setStyleFn(text => theme.fg("dim", text))
    const emptyHint = new Text(
      rigs.length === 0 && profiles.length === 0
        ? "No saved rigs yet. Save the current setup or build a new rig."
        : "",
      1,
      0,
    ).setStyleFn(text => theme.fg("dim", text))
    const footer = new Text(
      "↑↓ move  type filter  Enter open  Tab scope  Ctrl+A apply  Ctrl+D remove  Ctrl+E edit  Ctrl+N new  Ctrl+S save  Esc close",
      1,
      0,
    ).setStyleFn(text => theme.fg("dim", text))

    const refreshHeader = (): void => {
      header.setText(`Rigs  target: ${targetScope}`)
    }
    refreshHeader()
    list.onSelectionChange = item => {
      const managerItem = items.find(candidate => candidate.value === item.value)
      detail.setText(managerItem?.healthDetail ?? "")
      tui.requestRender()
    }

    const selectedItem = (): ManagerItem | undefined => {
      const value = list.pickerView().selected
      return items.find(item => item.value === value)
    }

    const run = (operation: () => Promise<void>): void => {
      void operation().catch(error => reportError(ctx, error))
    }

    const activate = async (item: ManagerItem): Promise<void> => {
      if (item.kind === "source") {
        done(undefined)
        await openActions(ctx, environment, item.source)
        return
      }
      if (item.kind !== "action") return
      switch (item.action) {
        case "save":
          done(undefined)
          await saveCurrent(ctx, environment)
          return
        case "build":
          done(undefined)
          await openBuilder(ctx, environment)
          return
        case "off": {
          if (!await ctx.ui.confirm(
            "Turn off rig",
            `Use the default setup for ${targetScope} scope?`,
          )) return
          const result = await turnOff(targetScope, environment)
          if (!result.ok) throw new Error([...result.errors, ...result.warnings].join("\n"))
          done(undefined)
          ctx.ui.notify(`Rig turned off for ${targetScope} scope`, "info")
          return
        }
        case "check": {
          const lines = rigInputs.map(rig => `${rig.name}: ${healthLabel(rig)}`)
          ctx.ui.notify(lines.length === 0 ? "No rigs found" : lines.join("\n"), "info")
        }
      }
    }

    list.onSelect = item => {
      const managerItem = items.find(candidate => candidate.value === item.value)
      if (managerItem !== undefined) run(() => activate(managerItem))
    }
    list.onCancel = () => done(undefined)

    container.addChild(header)
    container.addChild(list)
    container.addChild(detail)
    container.addChild(footnote)
    container.addChild(emptyHint)
    container.addChild(footer)

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "tab")) {
          const index = SCOPES.indexOf(targetScope)
          targetScope = SCOPES[(index + 1) % SCOPES.length] ?? "session"
          refreshHeader()
          tui.requestRender()
          return
        }

        const item = selectedItem()
        if (list.getFilter().length === 0 && item !== undefined) {
          if (matchesKey(data, "ctrl+a") && item.kind === "source") {
            run(async () => {
              const result = item.source === null
                ? await turnOff(targetScope, environment)
                : await applyRig(item.source, targetScope, environment)
              if (!result.ok) throw new Error([...result.errors, ...result.warnings].join("\n"))
              done(undefined)
              ctx.ui.notify(`Applied ${item.label} for ${targetScope} scope`, "info")
            })
            return
          }
          if (
            matchesKey(data, "ctrl+d")
            && item.kind === "source"
            && item.source?.kind === "rig"
          ) {
            const source = item.source
            run(async () => {
              if (!await ctx.ui.confirm("Remove rig", `Remove rig '${source.name}'?`)) return
              await store.remove(source.name)
              done(undefined)
              ctx.ui.notify(`Rig '${source.name}' removed`, "info")
            })
            return
          }
          if (
            matchesKey(data, "ctrl+e")
            && item.kind === "source"
            && item.source?.kind === "rig"
          ) {
            const source = item.source
            done(undefined)
            run(async () => {
              await builderUi.editRig(ctx, environment, source.name)
            })
            return
          }
          if (matchesKey(data, "ctrl+n")) {
            done(undefined)
            run(() => openBuilder(ctx, environment))
            return
          }
          if (matchesKey(data, "ctrl+s")) {
            done(undefined)
            run(() => saveCurrent(ctx, environment))
            return
          }
        }

        list.handleInput(data)
        tui.requestRender()
      },
    }
  })
}
