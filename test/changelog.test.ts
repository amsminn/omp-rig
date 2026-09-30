import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const script = join(import.meta.dir, "../scripts/changelog.ts")
const directories: string[] = []

async function fixture(changelog: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rigqa-changelog-"))
  directories.push(directory)
  await writeFile(join(directory, "CHANGELOG.md"), changelog)
  return directory
}

async function run(directory: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("changelog script", () => {
  test("releases Unreleased entries into a dated version section", async () => {
    const directory = await fixture(`# Changelog

## Unreleased

- Switch every role from one rig.
`)

    const result = await run(directory, "release", "0.1.0")
    const date = new Date().toISOString().slice(0, 10)

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    expect(await readFile(join(directory, "CHANGELOG.md"), "utf8")).toBe(`# Changelog

## Unreleased

## 0.1.0 - ${date}

- Switch every role from one rig.
`)
  })

  test("fails release when Unreleased has no entries", async () => {
    const directory = await fixture(`# Changelog

## Unreleased

## 0.1.0 - 2026-09-30

- Existing entry.
`)

    const result = await run(directory, "release", "0.1.1")

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("CHANGELOG.md has no entries under ## Unreleased")
  })

  test("prints exactly the requested version section as release notes", async () => {
    const directory = await fixture(`# Changelog

## Unreleased

## 0.1.1 - 2026-10-01

- Later entry.

## 0.1.0 - 2026-09-30

- First entry.

## 0.0.1 - 2026-09-01

- Older entry.
`)

    const result = await run(directory, "notes", "0.1.0")

    expect(result).toEqual({
      exitCode: 0,
      stdout: "## 0.1.0 - 2026-09-30\n\n- First entry.\n",
      stderr: "",
    })
  })
})
