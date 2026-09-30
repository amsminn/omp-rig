import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Rig } from "../src/rig-file"
import {
  duplicate,
  exportFile,
  globalMarkerFile,
  importFile,
  list,
  listProfiles,
  read,
  remove,
  rename,
  rigsDir,
  write,
} from "../src/store"

const RIG: Rig = {
  description: "Shared rig",
  modelRoles: {
    default: "provider/main:high",
    smol: "provider/small:low",
  },
  enabledModels: ["provider/*"],
  disabledProviders: ["other"],
}

let home: string
let originalHome: string | undefined
let originalAgentDir: string | undefined
let originalOmpProfile: string | undefined
let originalPiProfile: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  originalAgentDir = process.env.PI_CODING_AGENT_DIR
  originalOmpProfile = process.env.OMP_PROFILE
  originalPiProfile = process.env.PI_PROFILE
  home = await mkdtemp(join(tmpdir(), "omp-rig-store-"))
  process.env.HOME = home
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  process.env.PI_CODING_AGENT_DIR = join(home, ".omp", "agent")
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  if (originalOmpProfile === undefined) delete process.env.OMP_PROFILE
  else process.env.OMP_PROFILE = originalOmpProfile
  if (originalPiProfile === undefined) delete process.env.PI_PROFILE
  else process.env.PI_PROFILE = originalPiProfile
  await chmod(join(home, ".omp", "rigs"), 0o755).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  })
  await rm(home, { recursive: true, force: true })
})

describe("shared rig storage", () => {
  test("returns an empty list without creating the rigs directory", async () => {
    // Given
    const directory = rigsDir()

    // When
    const entries = await list()

    // Then
    expect(entries).toEqual([])
    expect(await Bun.file(directory).exists()).toBe(false)
  })

  test("shares rigs across profile agent directories while markers stay separate", async () => {
    // Given
    const firstAgentDir = join(home, ".omp", "profiles", "first", "agent")
    const secondAgentDir = join(home, ".omp", "profiles", "second", "agent")
    process.env.PI_CODING_AGENT_DIR = firstAgentDir
    await write("shared", RIG)
    const firstMarker = globalMarkerFile()

    // When
    process.env.PI_CODING_AGENT_DIR = secondAgentDir
    const secondEntries = await list()
    const secondMarker = globalMarkerFile()

    // Then
    expect(secondEntries.map(({ name }) => name)).toEqual(["shared"])
    expect(secondMarker).not.toBe(firstMarker)
    expect(rigsDir()).toBe(join(home, ".omp", "rigs"))
  })

  test("writes and reads a rig without changing its values", async () => {
    // Given
    await write("round-trip", RIG)

    // When
    const stored = await read("round-trip")

    // Then
    expect(stored).toEqual(RIG)
  })

  test("sorts listed rigs by name", async () => {
    // Given
    await write("z-last", RIG)
    await write("a-first", RIG)

    // When
    const entries = await list()

    // Then
    expect(entries.map(({ name }) => name)).toEqual(["a-first", "z-last"])
  })

  test("duplicates and removes a rig", async () => {
    // Given
    await write("source", RIG)

    // When
    await duplicate("source", "copy")
    await remove("source")

    // Then
    expect(await read("copy")).toEqual(RIG)
    expect((await list()).map(({ name }) => name)).toEqual(["copy"])
  })

  test("refuses to overwrite a rig during rename", async () => {
    // Given
    await write("source", RIG)
    await write("destination", RIG)

    // When
    const operation = rename("source", "destination")

    // Then
    await expect(operation).rejects.toThrow("destination already exists")
  })

  test("rejects an invalid import before creating a rig", async () => {
    // Given
    const source = join(home, "invalid.yml")
    await writeFile(source, "modelRoles:\n  smol: provider/small\n")

    // When
    const operation = importFile(source, "imported")

    // Then
    await expect(operation).rejects.toThrow("default model role is required")
    expect(await list()).toEqual([])
  })

  test("guards export destinations unless force is set", async () => {
    // Given
    const destination = join(home, "exported.yml")
    await write("source", RIG)
    await writeFile(destination, "existing")

    // When
    const guarded = exportFile("source", destination)

    // Then
    await expect(guarded).rejects.toThrow("already exists")
    await exportFile("source", destination, { force: true })
    expect(await Bun.file(destination).text()).toContain("default: provider/main:high")
  })

  test("surfaces a read-only directory error without leaving temporary files", async () => {
    // Given
    await mkdir(rigsDir(), { recursive: true })
    await chmod(rigsDir(), 0o555)

    // When
    const operation = write("blocked", RIG)

    // Then
    await expect(operation).rejects.toThrow()
    expect(await readdir(rigsDir())).toEqual([])
  })
})

describe("profile sources", () => {
  test("lists valid and unhealthy profiles while excluding the active profile", async () => {
    // Given
    const profiles = join(home, ".omp", "profiles")
    await mkdir(join(profiles, "a", "agent"), { recursive: true })
    await mkdir(join(profiles, "b", "agent"), { recursive: true })
    await writeFile(join(profiles, "a", "agent", "config.yml"), [
      "modelRoles:",
      "  default: provider/a",
      "enabledModels: [provider/*]",
      "theme: ignored",
      "",
    ].join("\n"))
    await writeFile(join(profiles, "b", "agent", "config.yml"), "theme: dark\n")
    process.env.OMP_PROFILE = "b"

    // When
    const sources = await listProfiles()

    // Then
    expect(sources.map(({ name }) => name)).toEqual(["a", "default"])
    expect(sources[0]).toMatchObject({
      name: "a",
      readOnly: true,
      rig: { modelRoles: { default: "provider/a" } },
    })
  })

  test("includes default and reports a missing default role for an inactive profile", async () => {
    // Given
    await mkdir(join(home, ".omp", "agent"), { recursive: true })
    await writeFile(
      join(home, ".omp", "agent", "config.yml"),
      "modelRoles:\n  default: provider/default\n",
    )
    await mkdir(join(home, ".omp", "profiles", "a", "agent"), { recursive: true })
    await mkdir(join(home, ".omp", "profiles", "b", "agent"), { recursive: true })
    await writeFile(
      join(home, ".omp", "profiles", "a", "agent", "config.yml"),
      "modelRoles:\n  default: provider/a\n",
    )
    await writeFile(
      join(home, ".omp", "profiles", "b", "agent", "config.yml"),
      "enabledModels: [provider/*]\n",
    )
    process.env.OMP_PROFILE = "a"

    // When
    const sources = await listProfiles()

    // Then
    expect(sources.map(({ name }) => name)).toEqual(["b", "default"])
    expect(sources[0]?.errors).toEqual([{
      path: "modelRoles.default",
      message: "profile has no default model role",
    }])
    expect(sources[1]).toMatchObject({
      name: "default",
      readOnly: true,
      rig: { modelRoles: { default: "provider/default" } },
    })
  })
})
