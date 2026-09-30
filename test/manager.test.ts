import { describe, expect, test } from "bun:test"
import { visibleWidth } from "@oh-my-pi/pi-tui"
import type { Rig } from "../src/rig-file"
import {
  buildManagerItems,
  previewLine,
  renderManagerRow,
  type ManagerItem,
} from "../src/ui/manager"

const defaultRig: Rig = {
  modelRoles: {
    default: "inferhub/glm-5.3",
    smol: "inferhub/glm-5.3-flash:low",
  },
}

function rig(name: string): Readonly<{
  name: string
  rig: Rig
  health: "ok"
}> {
  return {
    name,
    rig: {
      modelRoles: {
        default: `inferhub/${name}`,
      },
      enabledModels: ["inferhub/*"],
    },
    health: "ok",
  }
}

function sourceRows(items: readonly ManagerItem[]): readonly ManagerItem[] {
  return items.filter(item => item.kind === "source")
}

describe("rig manager item builder", () => {
  test("keeps default first and active in the empty state", () => {
    const items = buildManagerItems({
      defaultRig,
      rigs: [],
      profiles: [],
      active: null,
    })

    expect(items[0]).toMatchObject({
      kind: "source",
      value: "default",
      label: "default  ●",
    })
    expect(items.map(item => item.label)).toEqual([
      "default  ●",
      "─",
      "+ Save current setup as new rig",
      "+ Build new rig",
      "Check all rigs",
    ])
  })

  test("orders one rig after default and marks the active scope", () => {
    const items = buildManagerItems({
      defaultRig,
      rigs: [rig("cn")],
      profiles: [],
      active: { kind: "rig", name: "cn" },
      activeScope: "project",
    })

    expect(sourceRows(items).map(item => item.label)).toEqual([
      "default",
      "rig: cn  ● project  ok",
    ])
    expect(items.map(item => item.label)).toContain("Turn off rig")
  })

  test("orders three rigs before profiles with exactly one active marker", () => {
    const items = buildManagerItems({
      defaultRig,
      rigs: [rig("alpha"), rig("cn"), rig("work")],
      profiles: [{
        name: "company",
        rig: {
          modelRoles: { default: "inferhub/company" },
        },
        health: "ok",
      }],
      active: { kind: "rig", name: "cn" },
      activeScope: "session",
    })
    const rows = sourceRows(items)

    expect(rows.map(item => item.value)).toEqual([
      "default",
      "rig:alpha",
      "rig:cn",
      "rig:work",
      "profile:company",
    ])
    expect(rows.filter(item => item.label.includes("●"))).toHaveLength(1)
    expect(rows[2]?.label).toBe("rig: cn  ● session  ok")
  })

  test("marks default only when no rig or profile is effective", () => {
    const inactive = buildManagerItems({
      defaultRig,
      rigs: [rig("cn")],
      profiles: [],
      active: null,
      activeScope: "global",
    })
    const active = buildManagerItems({
      defaultRig,
      rigs: [rig("cn")],
      profiles: [],
      active: { kind: "rig", name: "cn" },
      activeScope: "global",
    })

    expect(sourceRows(inactive)[0]?.label).toContain("●")
    expect(sourceRows(active)[0]?.label).not.toContain("●")
  })
})

describe("rig manager inline preview", () => {
  test("renders primary roles first and remaining roles alphabetically", () => {
    const line = previewLine({
      modelRoles: {
        zeta: "p/z",
        task: "p/task",
        default: "p/default",
        alpha: "p/a",
        slow: "p/slow",
        smol: "p/smol",
        plan: "p/plan",
      },
      enabledModels: ["p/*"],
    })

    expect(line).toBe(
      "default=p/default  smol=p/smol  slow=p/slow  plan=p/plan  "
      + "task=p/task  alpha=p/a  zeta=p/z  pool=p/*",
    )
  })

  test("renders an omitted or empty pool as all", () => {
    expect(previewLine(defaultRig)).toEndWith("pool=all")
    expect(previewLine({ ...defaultRig, enabledModels: [] })).toEndWith("pool=all")
  })

  test("clips a width-limited preview with an ellipsis", () => {
    const line = previewLine({
      modelRoles: {
        default: "inferhub/glm-5.3-flash:high",
        smol: "inferhub/deepseek-v4.1-flash:low",
        slow: "inferhub/glm-5.3:high",
      },
      enabledModels: ["inferhub/*"],
    }, 60)

    expect(visibleWidth(line)).toBeLessThanOrEqual(60)
    expect(line).toEndWith("…")
    expect(line).not.toContain("\n")
  })

  test("clips a rendered preview row within 60 columns", () => {
    const item = buildManagerItems({
      defaultRig,
      rigs: [{
        name: "reasoning",
        health: "ok",
        rig: {
          modelRoles: {
            default: "inferhub/glm-5.3-flash:high",
            smol: "inferhub/deepseek-v4.1-flash:low",
            slow: "inferhub/glm-5.3:high",
          },
          enabledModels: ["inferhub/*"],
        },
      }],
      profiles: [],
      active: null,
    }).find(row => row.value === "rig:reasoning")

    expect(item).toBeDefined()
    const line = renderManagerRow(item!, 60, false)

    expect(visibleWidth(line)).toBeLessThanOrEqual(60)
    expect(line).toEndWith("…")
    expect(line).not.toContain("\n")
  })
})
