import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

// omp loads plugins against its own bundled copies of these packages; any other
// @oh-my-pi package imported at runtime must be installed next to the plugin.
const HOST_PACKAGES = new Set(["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"])
const SRC = join(import.meta.dir, "..", "src")

describe("host package imports", () => {
  test("runtime imports only use packages omp provides to plugins", async () => {
    const offenders: string[] = []
    for await (const file of new Glob("**/*.ts").scan(SRC)) {
      const text = await Bun.file(join(SRC, file)).text()
      for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"@oh-my-pi\/([a-z0-9-]+)[^"]*"/gm)) {
        const typeOnly = match[1] !== undefined
        const name = match[2] ?? ""
        if (!typeOnly && !HOST_PACKAGES.has(name)) offenders.push(`${file}: @oh-my-pi/${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
