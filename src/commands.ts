import { resolve } from "node:path"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent"
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader"
import type { AutocompleteItem, KeyId } from "@oh-my-pi/pi-tui"
import { currentSetupRig, roleNotes,
  applyRig,
  drift,
  effectivePool,
  inherit,
  turnOff,
  type EngineEnvironment,
  type EngineResult,
} from "./engine"
import type { Rig } from "./rig-file"
import {
  effective,
  readMarkers,
  type Marker,
  type RigSource,
  type Scope,
} from "./scope"
import * as store from "./store"
import { validateRig } from "./validate"
import * as managerUi from "./ui/manager"
import * as builderUi from "./ui/builder"

export const SUBCOMMANDS = [
  "list",
  "show",
  "current",
  "diff",
  "new",
  "edit",
  "update",
  "rename",
  "duplicate",
  "remove",
  "off",
  "clear",
  "next",
  "prev",
  "doctor",
  "import",
  "export",
  "help",
] as const

export type RigSubcommand = typeof SUBCOMMANDS[number]

export type ParsedCommand =
  | Readonly<{ action: "apply"; source: string; scope: Scope }>
  | Readonly<{
    action: RigSubcommand
    args: readonly string[]
    scope: Scope
  }>
  | Readonly<{ action: "manager"; args: readonly []; scope: "session" }>

export type CompletionSource = Readonly<{
  rigs: readonly string[]
  profiles: readonly string[]
}>

export type RigCommandRegistration = Readonly<{
  attach: (ctx: ExtensionContext) => Promise<void>
  refresh: () => Promise<void>
}>

const SCOPES = ["session", "project", "global"] as const
const SCOPE_HINT = "[--scope session|project|global]"
const USAGE: Readonly<Record<RigSubcommand, string>> = {
  list: "/rig list",
  show: "/rig show <name>",
  current: "/rig current",
  diff: "/rig diff",
  new: "/rig new [name]",
  edit: "/rig edit <name>",
  update: "/rig update <name>",
  rename: "/rig rename <name> <new-name>",
  duplicate: "/rig duplicate <name> <new-name>",
  remove: "/rig remove <name>",
  off: `/rig off ${SCOPE_HINT}`,
  clear: `/rig clear ${SCOPE_HINT}`,
  next: "/rig next",
  prev: "/rig prev",
  doctor: "/rig doctor",
  import: "/rig import <file> [name]",
  export: "/rig export <name> [file]",
  help: "/rig help",
}

const DESCRIPTIONS: Readonly<Record<RigSubcommand, string>> = {
  list: "Open the rig list",
  show: "Show a rig or profile",
  current: "Show active rig and effective settings",
  diff: "Show roles changed since the rig was applied",
  new: "Build or snapshot a rig",
  edit: "Edit a rig",
  update: "Replace a rig with the current setup",
  rename: "Rename a rig",
  duplicate: "Duplicate a rig",
  remove: "Remove a rig",
  off: "Use the default setup at a scope",
  clear: "Inherit the lower-scope choice",
  next: "Apply the next rig",
  prev: "Apply the previous rig",
  doctor: "Check all rigs",
  import: "Import a rig file",
  export: "Export a rig file",
  help: "Show command help",
}

const NAME_ARGUMENTS = new Set<RigSubcommand>([
  "show",
  "edit",
  "update",
  "rename",
  "duplicate",
  "remove",
  "export",
])

function tokenize(input: string): string[] {
  const values: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (const character of input.trim()) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        values.push(current)
        current = ""
      }
      continue
    }
    current += character
  }

  if (escaped || quote !== undefined) throw new Error("Unterminated quoted argument")
  if (current.length > 0) values.push(current)
  return values
}

function extractScope(words: readonly string[]): {
  args: string[]
  scope: Scope
} {
  const args: string[] = []
  let scope: Scope = "session"
  let found = false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined) continue
    if (word !== "--scope") {
      args.push(word)
      continue
    }
    if (found) throw new Error("--scope may be specified only once")
    const value = words[index + 1]
    if (!SCOPES.includes(value as Scope)) {
      throw new Error("--scope must be session, project, or global")
    }
    scope = value as Scope
    found = true
    index += 1
  }
  return { args, scope }
}

function requireCount(
  action: RigSubcommand,
  args: readonly string[],
  minimum: number,
  maximum = minimum,
): void {
  if (args.length < minimum || args.length > maximum) {
    throw new Error(`Usage: ${USAGE[action]}`)
  }
}

export function parseCommand(input: string): ParsedCommand {
  const words = tokenize(input)
  if (words.length === 0) return { action: "manager", args: [], scope: "session" }
  const { args: unscoped, scope } = extractScope(words)
  const [head, ...args] = unscoped
  if (head === undefined) throw new Error("Usage: /rig <name> [--scope session|project|global]")

  if (!(SUBCOMMANDS as readonly string[]).includes(head)) {
    requireCount("show", [head], 1)
    return { action: "apply", source: head, scope }
  }

  const action = head as RigSubcommand
  switch (action) {
    case "list":
    case "current":
    case "diff":
    case "next":
    case "prev":
    case "doctor":
    case "help":
      requireCount(action, args, 0)
      break
    case "show":
    case "edit":
    case "update":
    case "remove":
      requireCount(action, args, 1)
      break
    case "rename":
    case "duplicate":
      requireCount(action, args, 2)
      break
    case "new":
      requireCount(action, args, 0, 1)
      break
    case "off":
    case "clear":
      requireCount(action, args, 0)
      break
    case "import":
    case "export":
      requireCount(action, args, 1, 2)
      break
  }
  if (scope !== "session" && action !== "off" && action !== "clear") {
    throw new Error(`Usage: ${USAGE[action]}`)
  }
  return { action, args, scope }
}

function completion(
  value: string,
  label: string,
  description: string,
  hint?: string,
): AutocompleteItem {
  return {
    value,
    label,
    description,
    ...(hint === undefined ? {} : { hint }),
  }
}

function sourceCandidates(sources: CompletionSource): readonly {
  name: string
  description: string
}[] {
  return [
    ...sources.rigs.map(name => ({
      name: `rig:${name}`,
      description: "Rig",
    })),
    ...sources.profiles.map(name => ({
      name: `profile:${name}`,
      description: "Profile model settings",
    })),
    ...sources.rigs.map(name => ({
      name,
      description: "Apply rig",
    })),
  ]
}

export function argumentCompletions(
  argumentPrefix: string,
  sources: CompletionSource,
): AutocompleteItem[] | null {
  const text = argumentPrefix.trimStart()
  const trailingSpace = /\s$/.test(text)
  const words = text.split(/\s+/).filter(Boolean)
  const prefix = trailingSpace ? "" : (words.pop() ?? "")
  const lowerPrefix = prefix.toLowerCase()

  if (words.at(-1) === "--scope") {
    const matches = SCOPES
      .filter(scope => scope.startsWith(lowerPrefix))
      .map(scope => completion(
        `${words.join(" ")} ${scope} `,
        scope,
        `Use ${scope} scope`,
      ))
    return matches.length === 0 ? null : matches
  }
  if (words.includes("--scope")) return null

  if (words.length === 0) {
    const candidates = [
      ...SUBCOMMANDS.map(name => ({
        name,
        description: DESCRIPTIONS[name],
        hint: NAME_ARGUMENTS.has(name) ? "<name>" : undefined,
      })),
      ...sourceCandidates(sources).map(({ name, description }) => ({
        name,
        description,
        hint: SCOPE_HINT,
      })),
    ]
    const matches = candidates
      .filter(({ name }) => name.startsWith(lowerPrefix))
      .map(({ name, description, hint }) =>
        completion(`${name} `, name, description, hint))
    return matches.length === 0 ? null : matches
  }

  const action = words[0]
  if (action !== undefined && NAME_ARGUMENTS.has(action as RigSubcommand)) {
    const argumentIndex = words.length
    const needsName = argumentIndex === 1
      || ((action === "rename" || action === "duplicate") && argumentIndex === 2)
    if (needsName) {
      const candidates = argumentIndex === 2
        ? sources.rigs.map(name => ({ name, description: "New rig name" }))
        : sourceCandidates(sources)
      const matches = candidates
        .filter(({ name }) => name.startsWith(lowerPrefix))
        .map(({ name, description }) =>
          completion(`${words.join(" ")} ${name} `, name, description))
      return matches.length === 0 ? null : matches
    }
  }

  const acceptsScope = words.length === 1
    && (action === "off"
      || action === "clear"
      || sourceCandidates(sources).some(({ name }) => name === action))
  if (!acceptsScope || !"--scope".startsWith(lowerPrefix)) return null
  return [completion(
    `${words.join(" ")} --scope `,
    "--scope",
    "Choose where the rig applies",
    "<session|project|global>",
  )]
}

export function inlineHint(
  argumentText: string,
  sources: CompletionSource,
): string | null {
  const text = argumentText.trimStart()
  if (text.length === 0) return `<rig|profile|command> ${SCOPE_HINT}`
  const trailingSpace = /\s$/.test(text)
  const words = text.split(/\s+/).filter(Boolean)
  const scopeIndex = words.indexOf("--scope")
  if (scopeIndex >= 0) {
    const value = words[scopeIndex + 1]
    if (value === undefined) return trailingSpace
      ? "<session|project|global>"
      : " <session|project|global>"
    if (trailingSpace || scopeIndex !== words.length - 2) return null
    const match = SCOPES.find(scope => scope.startsWith(value))
    return match?.slice(value.length) || null
  }

  if (!trailingSpace && words.length === 1) {
    const prefix = words[0] ?? ""
    const candidate = [
      ...SUBCOMMANDS,
      ...sourceCandidates(sources).map(({ name }) => name),
    ].find(value => value.startsWith(prefix))
    if (candidate === undefined) return null
    const suffix = candidate.slice(prefix.length)
    if (suffix.length > 0) return suffix
  }

  const action = words[0]
  if (action === "rename" || action === "duplicate") {
    if (words.length === 1) return " <name> <new-name>"
    if (words.length === 2) return " <new-name>"
    return null
  }
  if (action === "import") return words.length === 1 ? " <file> [name]" : null
  if (action === "export") return words.length === 1 ? " <name> [file]" : null
  if (action === "new") return words.length === 1 ? " [name]" : null
  if (action !== undefined && NAME_ARGUMENTS.has(action as RigSubcommand)) {
    return words.length === 1 ? " <name>" : null
  }
  if (action === "off" || action === "clear"
    || sourceCandidates(sources).some(({ name }) => name === action)) {
    return trailingSpace
      ? `--scope <session|project|global>`
      : ` ${SCOPE_HINT}`
  }
  return null
}

function markerText(marker: Marker): string {
  switch (marker.kind) {
    case "missing":
      return "inherit"
    case "default":
      return "default"
    case "source":
      return `${marker.source.kind}:${marker.source.name}`
  }
}

function rigText(name: string, rig: Rig): string {
  const roles = Object.entries(rig.modelRoles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, spec]) => `${role}=${spec}`)
  return [
    `rig:${name}`,
    ...roles,
    `pool=${rig.enabledModels?.join(",") ?? "all"}`,
    `blocked=${rig.disabledProviders?.join(",") ?? "none"}`,
  ].join("\n")
}

function profileText(name: string, rig: Rig): string {
  return rigText(name, rig).replace(/^rig:/, "profile:")
}

function resultMessage(result: EngineResult): string {
  if (result.ok) return result.summary
  return [...result.errors, ...result.warnings].join("\n")
}

function report(ctx: ExtensionContext, message: string, error = false): void {
  if (!ctx.hasUI) {
    process.stderr.write(`${message}\n`)
    return
  }
  ctx.ui.notify(message, error ? "error" : "info")
}

async function refreshSources(target: CompletionSource): Promise<void> {
  const [rigs, profiles] = await Promise.all([store.list(), store.listProfiles()])
  ;(target.rigs as string[]) = rigs.map(entry => entry.name)
  ;(target.profiles as string[]) = profiles.map(entry => entry.name)
}

async function resolveSource(name: string): Promise<Readonly<{
  source: RigSource
  rig: Rig
}>> {
  if (name.startsWith("rig:")) {
    const rigName = name.slice("rig:".length)
    return { source: { kind: "rig", name: rigName }, rig: await store.read(rigName) }
  }
  if (name.startsWith("profile:")) {
    const profileName = name.slice("profile:".length)
    const profile = (await store.listProfiles()).find(entry => entry.name === profileName)
    if (profile?.rig === undefined) {
      throw new Error(profile === undefined
        ? `profile "${profileName}" not found`
        : profile.errors.map(error => error.message).join("; "))
    }
    return { source: { kind: "profile", name: profileName }, rig: profile.rig }
  }

  const rig = (await store.list()).find(entry => entry.name === name)
  if (rig?.rig !== undefined) {
    return { source: { kind: "rig", name }, rig: rig.rig }
  }
  const profile = (await store.listProfiles()).find(entry => entry.name === name)
  if (profile !== undefined) {
    throw new Error(`rig "${name}" not found; use profile:${name}`)
  }
  if (rig !== undefined) throw new Error(rig.errors.map(error => error.message).join("; "))
  throw new Error(`rig "${name}" not found`)
}

async function openManager(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  await managerUi.openManager(ctx, environment)
}

async function openBuilder(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  name?: string,
): Promise<void> {
  await builderUi.buildRig(ctx, environment, name === undefined ? {} : { name })
}

async function openEditor(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
  name: string,
): Promise<void> {
  await builderUi.editRig(ctx, environment, name)
}

async function cycle(
  direction: 1 | -1,
  ctx: ExtensionContext,
  environment: EngineEnvironment,
): Promise<void> {
  const names = (await store.list())
    .filter(entry => entry.rig !== undefined)
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
  if (names.length === 0) throw new Error("No rigs available")
  const selected = effective(await readMarkers(environment.scope))
  const current = selected.source !== null && !("missing" in selected.source)
    && selected.source.kind === "rig"
    ? names.indexOf(selected.source.name)
    : -1
  const index = direction === 1
    ? (current + 1 + names.length) % names.length
    : (current <= 0 ? names.length - 1 : current - 1)
  const name = names[index]
  if (name === undefined) throw new Error("No rigs available")
  report(ctx, resultMessage(await applyRig({ kind: "rig", name }, "session", environment)))
}

async function showList(
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  if (ctx.mode === "rpc") {
    const [rigs, profiles] = await Promise.all([store.list(), store.listProfiles()])
    const choices = [
      "default",
      ...rigs.filter(entry => entry.rig !== undefined).map(entry => ({
        label: entry.name,
        description: "rig",
      })),
      ...profiles.filter(entry => entry.rig !== undefined).map(entry => ({
        label: `profile:${entry.name}`,
        description: "profile model settings",
      })),
    ]
    const choice = await ctx.ui.select("Rigs", choices)
    if (choice === undefined) return
    const actions = choice === "default"
      ? [
          "Use default (this session)",
          "Use default for this project",
          "Use default globally",
        ]
      : [
          "Apply (this session)",
          "Apply to this project",
          "Apply as global default",
        ]
    const action = await ctx.ui.select(choice, actions)
    if (action === undefined) return
    const scope: Scope = action.includes("project")
      ? "project"
      : action.includes("global")
        ? "global"
        : "session"
    const result = choice === "default"
      ? await turnOff(scope, environment)
      : await applyRig((await resolveSource(choice)).source, scope, environment)
    if (result.ok && choice !== "default") {
      report(ctx, `Rig '${choice}' applied to ${Object.keys(
        environment.settings.getModelRoles(),
      ).length} roles for ${scope} scope`)
    } else {
      report(ctx, resultMessage(result), !result.ok)
    }
    return
  }
  if (ctx.hasUI) {
    await openManager(ctx, environment)
    return
  }
  const [rigs, profiles] = await Promise.all([store.list(), store.listProfiles()])
  const rows = [
    "default",
    ...rigs.map(entry => `rig:${entry.name}${entry.rig === undefined ? "  invalid" : ""}`),
    ...profiles.map(entry =>
      `profile:${entry.name}${entry.rig === undefined ? "  invalid" : ""}`),
  ]
  report(ctx, rows.join("\n"))
}

async function handleCommand(
  parsed: ParsedCommand,
  ctx: ExtensionCommandContext,
  environment: EngineEnvironment,
): Promise<void> {
  if (parsed.action === "manager") {
    await showList(ctx, environment)
    return
  }
  if (parsed.action === "apply") {
    const { source } = await resolveSource(parsed.source)
    const result = await applyRig(source, parsed.scope, environment)
    report(ctx, resultMessage(result), !result.ok)
    return
  }

  const [first, second] = parsed.args
  switch (parsed.action) {
    case "list":
      await showList(ctx, environment)
      return
    case "show": {
      const selected = await resolveSource(first ?? "")
      report(ctx, selected.source.kind === "rig"
        ? rigText(selected.source.name, selected.rig)
        : profileText(selected.source.name, selected.rig))
      return
    }
    case "current": {
      const markers = await readMarkers(environment.scope)
      const selected = effective(markers)
      const notes = await roleNotes(environment)
      const roles = Object.entries(environment.settings.getModelRoles())
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, spec]) => {
          const note = notes[role] ?? []
          return note.length === 0 ? `${role}=${spec}` : `${role}=${spec} (${note.join(", ")})`
        })
      report(ctx, [
        `active=${selected.source === null
          ? "default"
          : `${selected.source.kind}:${selected.source.name}`}`,
        `session=${markerText(markers.session)}`,
        `project=${markerText(markers.project)}`,
        `global=${markerText(markers.global)}`,
        ...roles,
      ].join("\n"))
      return
    }
    case "diff": {
      const changed = await drift(environment)
      report(ctx, changed.length === 0 ? "No drift" : changed.join("\n"))
      return
    }
    case "new":
      if (first === undefined) {
        await openBuilder(ctx, environment)
      } else {
        await store.write(first, currentSetupRig(environment))
        report(ctx, `rig:${first} saved`)
      }
      return
    case "edit":
      await openEditor(ctx, environment, first ?? "")
      return
    case "update":
      await store.read(first ?? "")
      await store.write(first ?? "", currentSetupRig(environment))
      report(ctx, `rig:${first} updated`)
      return
    case "rename":
      await store.rename(first ?? "", second ?? "")
      report(ctx, `rig:${first} renamed to ${second}`)
      return
    case "duplicate":
      await store.duplicate(first ?? "", second ?? "")
      report(ctx, `rig:${first} duplicated as ${second}`)
      return
    case "remove":
      await store.remove(first ?? "")
      report(ctx, `rig:${first} removed`)
      return
    case "off": {
      const result = await turnOff(parsed.scope, environment)
      report(ctx, resultMessage(result), !result.ok)
      return
    }
    case "clear": {
      const result = await inherit(parsed.scope, environment)
      report(ctx, resultMessage(result), !result.ok)
      return
    }
    case "next":
      await cycle(1, ctx, environment)
      return
    case "prev":
      await cycle(-1, ctx, environment)
      return
    case "doctor": {
      const entries = await store.list()
      const lines: string[] = []
      for (const entry of entries) {
        if (entry.rig === undefined) {
          lines.push(`rig:${entry.name}  error  ${entry.errors.map(error => error.message).join("; ")}`)
          continue
        }
        const validation = validateRig(entry.rig, environment.ctx.modelRegistry)
        lines.push(`rig:${entry.name}  ${validation.ok ? "ok" : "error"}`)
        if (!validation.ok) {
          lines.push(...validation.errors.map(error => `  ${error.message}`))
        }
        if (effectivePool(entry.rig, environment.ctx.modelRegistry).providerGranular) {
          lines.push("  warning: same-provider models stay reachable by explicit subagent picks")
        }
      }
      report(ctx, lines.length === 0 ? "No rigs found" : lines.join("\n"))
      return
    }
    case "import":
      await store.importFile(resolve(first ?? ""), second)
      report(ctx, `Imported ${second ?? first}`)
      return
    case "export": {
      const path = resolve(second ?? `${first}.yml`)
      await store.exportFile(first ?? "", path)
      report(ctx, `Exported rig:${first} to ${path}`)
      return
    }
    case "help":
      report(ctx, [
        `/rig <name> ${SCOPE_HINT}`,
        "/rig rig:<name> | profile:<name>",
        ...SUBCOMMANDS.map(command => USAGE[command]),
      ].join("\n"))
      return
  }
}

function installInlineHints(
  ctx: ExtensionContext,
  sources: CompletionSource,
): void {
  if (typeof ctx.ui.addAutocompleteProvider !== "function") return
  ctx.ui.addAutocompleteProvider(current => new Proxy(current, {
    get(target, property) {
      if (property === "getInlineHint") {
        return (
          lines: string[],
          cursorLine: number,
          cursorColumn: number,
        ): string | null => {
          const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorColumn)
          const match = /^\s*\/rig\s(.*)$/.exec(beforeCursor)
          const hint = match === null ? null : inlineHint(match[1] ?? "", sources)
          const fallback = Reflect.get(target, property, target)
          return hint ?? (typeof fallback === "function"
            ? fallback.call(target, lines, cursorLine, cursorColumn)
            : null)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }))
}

export function registerRigCommands(
  pi: ExtensionAPI,
  getEnvironment: () => EngineEnvironment | undefined,
): RigCommandRegistration {
  const sources: { rigs: string[]; profiles: string[] } = {
    rigs: [],
    profiles: [],
  }
  let hintsInstalled = false
  let shortcutRegistered = false

  const handler = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const environment = getEnvironment()
    if (environment === undefined) {
      report(ctx, "omp-rig is not ready", true)
      return
    }
    try {
      await handleCommand(parseCommand(args), ctx, environment)
      await refreshSources(sources)
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), true)
    }
  }
  const getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
    argumentCompletions(prefix, sources)

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("rig", {
      description: "Switch, inspect, and manage model rigs",
      getArgumentCompletions,
      handler,
    })
  }

  return {
    refresh: async () => refreshSources(sources),
    attach: async ctx => {
      await refreshSources(sources)
      if (!hintsInstalled && ctx.mode === "tui") {
        installInlineHints(ctx, sources)
        hintsInstalled = true
      }
      if (!shortcutRegistered) {
        const settings = await getPluginSettings("omp-rig", ctx.cwd)
        const cycleKey = settings["cycleKey"]
        if (typeof cycleKey === "string" && cycleKey.trim().length > 0) {
          pi.registerShortcut(cycleKey.trim() as KeyId, {
            description: "Apply the next rig",
            handler: async shortcutContext => {
              const environment = getEnvironment()
              if (environment === undefined) return
              try {
                await cycle(1, shortcutContext, environment)
                await refreshSources(sources)
              } catch (error) {
                report(
                  shortcutContext,
                  error instanceof Error ? error.message : String(error),
                  true,
                )
              }
            },
          })
        }
        shortcutRegistered = true
      }
    },
  }
}
