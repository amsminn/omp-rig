import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent"
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs"
import {
  drift,
  reconcile,
  type EngineEnvironment,
  type EngineResult,
} from "./engine"
import {
  resolveHandles,
  runtimeOwnedRoles,
  type HostHandles,
} from "./host"
import type { RigSource, ScopeEnvironment } from "./scope"
import * as store from "./store"
import { registerRigCommands } from "./commands"

type LifecycleEvent =
  | "session_start"
  | "session_switch"
  | "session_branch"
  | "session_tree"

export type LifecycleDependencies = Readonly<{
  resolveHandles: () => Promise<HostHandles>
  runtimeOwnedRoles: typeof runtimeOwnedRoles
  reconcile: typeof reconcile
  drift: typeof drift
  getSettings: (pi: ExtensionAPI) => Settings
  getAgentDir: () => string
  store: EngineEnvironment["store"]
}>

const defaultDependencies: LifecycleDependencies = {
  resolveHandles,
  runtimeOwnedRoles,
  reconcile,
  drift,
  getSettings: pi => pi.pi.settings,
  getAgentDir,
  store,
}

function isAcpSession(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === "main" && ctx.agent.id.startsWith("acp:")
}

function reportResult(
  result: EngineResult,
  ctx: ExtensionContext,
  flagRig?: string,
): void {
  if (result.ok) return
  const normalize = (message: string): string =>
    flagRig !== undefined && message.includes("ENOENT")
      ? `rig "${flagRig}" not found`
      : message
  const errors = result.errors.map(normalize)
  const warnings = result.warnings.map(normalize)
  const messages = [...errors, ...warnings]
  if (messages.length === 0) return

  if (!ctx.hasUI) {
    process.stderr.write(`${messages.join("\n")}\n`)
    return
  }

  for (const message of errors) ctx.ui.notify(message, "error")
  for (const message of warnings) ctx.ui.notify(message, "warning")
}

function subscribeToSettings(
  settings: Settings,
  handles: HostHandles,
  refresh: () => void | Promise<void>,
): () => void {
  const stops = [
    handles.modelRoles.listen(settings, refresh),
    handles.enabledModels.listen(settings, refresh),
    handles.disabledProviders.listen(settings, refresh),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}

export function omprig(
  pi: ExtensionAPI,
  dependencies: LifecycleDependencies = defaultDependencies,
): void {
  pi.setLabel("omp-rig")
  pi.registerFlag("rig", {
    type: "string",
    description: "Apply a rig for this session",
  })

  let startupHandled = false
  let acpNotified = false
  let stopSettingsListener: (() => void) | undefined
  let activeSource: RigSource | null = null
  let currentEnvironment: EngineEnvironment | undefined
  let currentContext: ExtensionContext | undefined
  const rigCommands = registerRigCommands(pi, () => currentEnvironment)

  const setStatus = (
    ctx: ExtensionContext,
    source: RigSource | null,
    drifted: boolean,
  ): void => {
    ctx.ui.setStatus(
      "omp-rig",
      source === null
        ? undefined
        : `${source.kind}: ${source.name}${drifted ? "*" : ""}`,
    )
  }

  const refreshDriftStatus = async (): Promise<void> => {
    if (
      activeSource === null ||
      currentEnvironment === undefined ||
      currentContext === undefined
    ) {
      return
    }
    const changed = await dependencies.drift(currentEnvironment)
    setStatus(currentContext, activeSource, changed.length > 0)
  }

  const environmentFor = (
    ctx: ExtensionContext,
    settings: Settings,
    handles: HostHandles,
  ): EngineEnvironment => {
    const scope: ScopeEnvironment = {
      cwd: ctx.cwd,
      agentDir: dependencies.getAgentDir(),
      getBranch: () => ctx.sessionManager.getBranch(),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
    }
    return {
      pi: {
        appendEntry: scope.appendEntry,
        getThinkingLevel: () => pi.getThinkingLevel(),
        setThinkingLevel: level => pi.setThinkingLevel(level),
        setModel: model => pi.setModel(model),
      },
      ctx: {
        get model() {
          return ctx.model
        },
        modelRegistry: ctx.modelRegistry,
      },
      settings,
      handles,
      store: dependencies.store,
      scope,
      onApplied: result => {
        activeSource = result.source
        setStatus(ctx, activeSource, result.drift.length > 0)
      },
    }
  }

  const handleLifecycle = async (
    event: LifecycleEvent,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (ctx.agent.kind === "sub") return
    if (isAcpSession(ctx)) {
      if (!acpNotified) {
        ctx.ui.notify("omp-rig: ACP mode not supported", "warning")
        acpNotified = true
      }
      return
    }

    const settings = dependencies.getSettings(pi)
    const handles = await dependencies.resolveHandles()
    const environment = environmentFor(ctx, settings, handles)
    currentEnvironment = environment
    currentContext = ctx
    await rigCommands.attach(ctx)

    const isStartup = event === "session_start" && !startupHandled
    const owned = isStartup ? dependencies.runtimeOwnedRoles(settings) : undefined
    if (isStartup) startupHandled = true

    const flagValue = isStartup ? pi.getFlag("rig") : undefined
    const flagRig = typeof flagValue === "string" && flagValue.length > 0
      ? flagValue
      : undefined
    const result = await dependencies.reconcile(environment, isStartup
      ? {
          startup: true,
          runtimeOwned: owned ?? {},
          ...(flagRig !== undefined
            ? { flagRig }
            : {}),
        }
      : {})

    reportResult(result, ctx, flagRig)
    activeSource = result.ok ? result.source : null
    setStatus(ctx, activeSource, result.ok && result.drift.length > 0)

    stopSettingsListener ??= subscribeToSettings(
      settings,
      handles,
      refreshDriftStatus,
    )
  }

  pi.on("session_start", async (_event, ctx) => handleLifecycle("session_start", ctx))
  pi.on("session_switch", async (_event, ctx) => handleLifecycle("session_switch", ctx))
  pi.on("session_branch", async (_event, ctx) => handleLifecycle("session_branch", ctx))
  pi.on("session_tree", async (_event, ctx) => handleLifecycle("session_tree", ctx))

  pi.on("session_shutdown", () => {
    stopSettingsListener?.()
    stopSettingsListener = undefined
  })
}

export default omprig
