import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

export default function registerRig(pi: ExtensionAPI): void {
  pi.registerCommand("rig", {
    description: "Manage omp model rigs",
    handler: async (_args, ctx) => {
      ctx.ui.notify("omp-rig loaded", "info")
    },
  })
}
