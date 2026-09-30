import { describe, expect, test } from "bun:test"
import {
  applyModelToRoles,
  enabledModelsForProviders,
  rolesFromBase,
} from "../src/ui/builder"

describe("builder base reducer", () => {
  test("keeps the current role set when starting empty", () => {
    // Given
    const current = {
      default: "inferhub/glm-5.3",
      smol: "inferhub/deepseek-v4.1-flash:low",
    }

    // When
    const roles = rolesFromBase(current, { kind: "empty" })

    // Then
    expect(roles).toEqual(current)
  })

  test("adds copied roles and lets the copy override matching roles", () => {
    // Given
    const current = {
      default: "inferhub/glm-5.3",
      smol: "inferhub/glm-5.3-flash",
    }
    const copied = {
      modelRoles: {
        default: "inferhub/deepseek-v4.1-flash",
        designer: "inferhub/deepseek-v4.1-flash:high",
      },
    }

    // When
    const roles = rolesFromBase(current, {
      kind: "rig",
      name: "copied",
      rig: copied,
    })

    // Then
    expect(roles).toEqual({
      default: "inferhub/deepseek-v4.1-flash",
      smol: "inferhub/glm-5.3-flash",
      designer: "inferhub/deepseek-v4.1-flash:high",
    })
  })

  test("assigns the selected model to every role including default", () => {
    // Given
    const roles = {
      smol: "inferhub/glm-5.3-flash:low",
      designer: "inferhub/glm-5.3:high",
    }

    // When
    const selected = applyModelToRoles(roles, "inferhub/deepseek-v4.1-flash")

    // Then
    expect(selected).toEqual({
      default: "inferhub/deepseek-v4.1-flash",
      smol: "inferhub/deepseek-v4.1-flash",
      designer: "inferhub/deepseek-v4.1-flash",
    })
  })
})

describe("builder pool reducer", () => {
  test("writes one sorted wildcard for each selected provider", () => {
    // Given
    const providers = ["openai", "inferhub", "openai"]

    // When
    const enabledModels = enabledModelsForProviders(providers, false)

    // Then
    expect(enabledModels).toEqual(["inferhub/*", "openai/*"])
  })

  test("leaves enabledModels unset when all models are shown", () => {
    // Given
    const providers = ["inferhub"]

    // When
    const enabledModels = enabledModelsForProviders(providers, true)

    // Then
    expect(enabledModels).toBeUndefined()
  })
})
