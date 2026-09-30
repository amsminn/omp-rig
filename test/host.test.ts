import { describe, expect, test } from "bun:test"
import {
  cfgDisabledProviders,
  cfgEnabledModels,
  cfgModelRoles,
} from "@oh-my-pi/pi-coding-agent/config/model-settings"
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings"
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking"
import {
  captureBaseline,
  clearRuntime,
  readEffective,
  resolveHandles,
  runtimeOwnedRoles,
  writeRuntime,
} from "../src/host"

const GLOBAL_DESIGNER = "global/designer"
const PROJECT_PLAN = "project/plan"

function settingsWithPersistedLayers(): Settings {
  const settings = Settings.isolated()
  cfgModelRoles.set(settings, {
    default: "global/default",
    designer: GLOBAL_DESIGNER,
  })
  cfgEnabledModels.set(settings, ["inferhub/*"])
  cfgDisabledProviders.set(settings, ["openai"])
  settings.setProjectModelRole("plan", PROJECT_PLAN)
  return settings
}

describe("host settings adapter", () => {
  test("replaces leaked roles when a second rig omits them", async () => {
    // Given
    const settings = settingsWithPersistedLayers()
    const handles = await resolveHandles()

    // When
    writeRuntime(settings, handles, {
      modelRoles: {
        default: "rig-a/default",
        smol: "rig-a/smol",
        designer: "rig-a/designer",
      },
    })
    writeRuntime(settings, handles, {
      modelRoles: {
        default: "rig-b/default",
        smol: "rig-b/smol",
      },
    })

    // Then
    expect(settings.getModelRoles().designer).toBe("rig-b/default")
    expect(settings.getModelRoles().plan).toBe("rig-b/default")
  })

  test("clears a persisted model pool when a rig has no restriction", async () => {
    // Given
    const settings = settingsWithPersistedLayers()
    const handles = await resolveHandles()

    // When
    writeRuntime(settings, handles, {
      modelRoles: { default: "rig/default" },
    })

    // Then
    expect(cfgEnabledModels.get(settings)).toEqual([])
    expect(cfgDisabledProviders.get(settings)).toEqual([])
  })

  test("replaces enabled models on the runtime layer", async () => {
    // Given
    const settings = settingsWithPersistedLayers()
    const handles = await resolveHandles()

    // When
    writeRuntime(settings, handles, {
      modelRoles: { default: "rig/default" },
      enabledModels: ["anthropic/*", "openai/gpt-*"],
    })

    // Then
    expect(cfgEnabledModels.get(settings)).toEqual(["anthropic/*", "openai/gpt-*"])
    expect(settings.getProvenance(cfgEnabledModels)).toBe("runtime")
  })

  test("restores persisted values when the runtime baseline is empty", async () => {
    // Given
    const settings = settingsWithPersistedLayers()
    const handles = await resolveHandles()
    const baseline = captureBaseline(settings, handles)

    // When
    writeRuntime(settings, handles, {
      modelRoles: { default: "rig/default", designer: "rig/designer" },
      enabledModels: ["anthropic/*"],
      disabledProviders: ["inferhub"],
    })
    clearRuntime(settings, handles, baseline)

    // Then
    expect(await readEffective(settings)).toEqual({
      modelRoles: {
        default: "global/default",
        designer: GLOBAL_DESIGNER,
        plan: PROJECT_PLAN,
      },
      enabledModels: ["inferhub/*"],
      disabledProviders: ["openai"],
    })
  })

  test("restores host-owned runtime roles and pool values", async () => {
    // Given
    const settings = settingsWithPersistedLayers()
    const handles = await resolveHandles()
    cfgModelRoles.override(settings, { smol: "startup/smol" })
    cfgEnabledModels.override(settings, ["startup/*"])
    const baseline = captureBaseline(settings, handles, ThinkingLevel.High)

    // When
    writeRuntime(settings, handles, {
      modelRoles: { default: "rig/default", smol: "rig/smol" },
      enabledModels: ["rig/*"],
      disabledProviders: ["openai"],
    })
    clearRuntime(settings, handles, baseline)

    // Then
    expect(runtimeOwnedRoles(settings)).toEqual({ smol: "startup/smol" })
    expect(settings.getModelRoles().smol).toBe("startup/smol")
    expect(settings.getModelRoleProvenance("smol")).toBe("runtime")
    expect(cfgEnabledModels.get(settings)).toEqual(["startup/*"])
    expect(settings.getProvenance(cfgEnabledModels)).toBe("runtime")
    expect(baseline.thinkingLevel).toBe(ThinkingLevel.High)
  })
})
