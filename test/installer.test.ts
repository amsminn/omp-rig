import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BIN = join(import.meta.dir, "..", "bin", "omp-rig.js")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function run(args: readonly string[], withOmp: boolean) {
  const root = await mkdtemp(join(tmpdir(), "omp-rig-installer-"))
  roots.push(root)
  const record = join(root, "args.txt")
  if (withOmp) {
    const fake = join(root, "omp")
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit 7\n`)
    await chmod(fake, 0o755)
  }
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    env: { ...process.env, PATH: withOmp ? `${root}:/usr/bin:/bin` : root },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const recorded = await readFile(record, "utf8").then(text => text.trim().split("\n"), () => null)
  return { stdout, stderr, code, recorded }
}

describe("npx installer", () => {
  test("install runs omp plugin install with the latest package and passes options through", async () => {
    const result = await run(["install", "--scope", "project"], true)

    expect(result.recorded).toEqual(["plugin", "install", "omp-rig@latest", "--scope", "project"])
    expect(result.code).toBe(7)
  })

  test("uninstall runs omp plugin uninstall", async () => {
    const result = await run(["uninstall"], true)

    expect(result.recorded).toEqual(["plugin", "uninstall", "omp-rig"])
  })

  test("reports a missing omp binary", async () => {
    const result = await run(["install"], false)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("omp was not found on PATH")
  })

  test("prints usage without a command and rejects unknown commands", async () => {
    const help = await run([], true)
    const unknown = await run(["frobnicate"], true)

    expect(help.code).toBe(0)
    expect(help.stdout).toContain("npx omp-rig <command>")
    expect(help.recorded).toBeNull()
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown command: frobnicate")
  })
})
