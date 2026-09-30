import { constants } from "node:fs"
import type { Dirent } from "node:fs"
import { copyFile, link, mkdir, readFile, readdir, rename as renameFile, rm, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, join } from "node:path"
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs"
import { parseRig, serializeRig, validateRigName } from "./rig-file"
import type { Rig, RigFileError } from "./rig-file"

export type RigStoreEntry =
  | { readonly name: string; readonly file: string; readonly rig: Rig; readonly errors?: never }
  | { readonly name: string; readonly file: string; readonly rig?: never; readonly errors: readonly RigFileError[] }

export type ProfileSource = RigStoreEntry & { readonly readOnly: true }
export type ExportOptions = { readonly force?: boolean }

export class RigStoreError extends Error {
  readonly name = "RigStoreError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT"
}

function isCollision(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "EEXIST"
}

function requireValidName(name: string): void {
  const error = validateRigName(name)
  if (error !== undefined) {
    throw new RigStoreError(error.message)
  }
}

function rigFile(name: string): string {
  return join(rigsDir(), `${name}.yml`)
}

function baseConfigRoot(): string {
  return join(process.env["HOME"] ?? homedir(), process.env["PI_CONFIG_DIR"] ?? ".omp")
}

async function parseFile(file: string): Promise<Rig> {
  const result = parseRig(await readFile(file, "utf8"), file)
  if (!result.ok) {
    throw new RigStoreError(result.errors.map(({ message }) => message).join("; "))
  }
  return result.rig
}

async function writeAtomic(name: string, rig: Rig, overwrite: boolean): Promise<void> {
  requireValidName(name)
  const directory = rigsDir()
  const destination = rigFile(name)
  const temporary = join(directory, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  let completed = false
  try {
    await writeFile(temporary, serializeRig(rig), { flag: "wx" })
    if (overwrite) {
      await renameFile(temporary, destination)
    } else {
      await link(temporary, destination)
      await unlink(temporary)
    }
    completed = true
  } catch (error) {
    if (!overwrite && isCollision(error)) {
      throw new RigStoreError(`${name} already exists`, { cause: error })
    }
    throw error
  } finally {
    if (!completed) {
      await rm(temporary, { force: true })
    }
  }
}

function activeProfile(): string | undefined {
  const raw = process.env["OMP_PROFILE"] !== undefined
    ? process.env["OMP_PROFILE"]
    : process.env["PI_PROFILE"]
  const normalized = raw?.trim()
  return normalized === undefined || normalized === "" || normalized === "default"
    ? undefined
    : normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function profileSource(name: string, file: string): Promise<ProfileSource> {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(await readFile(file, "utf8"))
  } catch (error) {
    return {
      name,
      file,
      readOnly: true,
      errors: [{
        path: file,
        message: error instanceof Error ? error.message : String(error),
      }],
    }
  }

  if (!isRecord(parsed)) {
    return {
      name, file, readOnly: true,
      errors: [{ path: "modelRoles.default", message: "profile has no default model role" }],
    }
  }

  const roles = parsed["modelRoles"]
  if (!isRecord(roles) || typeof roles["default"] !== "string" || roles["default"].length === 0) {
    return {
      name, file, readOnly: true,
      errors: [{ path: "modelRoles.default", message: "profile has no default model role" }],
    }
  }

  const result = parseRig(Bun.YAML.stringify({
    modelRoles: roles,
    ...("enabledModels" in parsed ? { enabledModels: parsed["enabledModels"] } : {}),
    ...("disabledProviders" in parsed
      ? { disabledProviders: parsed["disabledProviders"] }
      : {}),
  }), file)
  return result.ok
    ? { name, file, readOnly: true, rig: result.rig }
    : { name, file, readOnly: true, errors: result.errors }
}

export function rigsDir(): string {
  return join(baseConfigRoot(), "rigs")
}

export function globalMarkerFile(): string {
  return join(process.env["PI_CODING_AGENT_DIR"] ?? getAgentDir(), "rig.active")
}

export async function list(): Promise<readonly RigStoreEntry[]> {
  let files
  try {
    files = await readdir(rigsDir(), { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }

  const entries = await Promise.all(files
    .filter((file) => file.isFile() && extname(file.name) === ".yml")
    .map(async (file): Promise<RigStoreEntry> => {
      const name = basename(file.name, ".yml")
      const path = join(rigsDir(), file.name)
      const result = parseRig(await readFile(path, "utf8"), path)
      return result.ok
        ? { name, file: path, rig: result.rig }
        : { name, file: path, errors: result.errors }
    }))
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

export async function read(name: string): Promise<Rig> {
  requireValidName(name)
  return parseFile(rigFile(name))
}

export async function write(name: string, rig: Rig): Promise<void> {
  await writeAtomic(name, rig, true)
}

export async function rename(oldName: string, newName: string): Promise<void> {
  requireValidName(oldName)
  requireValidName(newName)
  try {
    await link(rigFile(oldName), rigFile(newName))
  } catch (error) {
    if (isCollision(error)) {
      throw new RigStoreError(`${newName} already exists`, { cause: error })
    }
    throw error
  }
  await unlink(rigFile(oldName))
}

export async function duplicate(source: string, destination: string): Promise<void> {
  requireValidName(source)
  requireValidName(destination)
  try {
    await copyFile(rigFile(source), rigFile(destination), constants.COPYFILE_EXCL)
  } catch (error) {
    if (isCollision(error)) {
      throw new RigStoreError(`${destination} already exists`, { cause: error })
    }
    throw error
  }
}

export async function remove(name: string): Promise<void> {
  requireValidName(name)
  await unlink(rigFile(name))
}

export async function importFile(path: string, name?: string): Promise<void> {
  const destination = name ?? basename(path, extname(path))
  requireValidName(destination)
  const result = parseRig(await readFile(path, "utf8"), path)
  if (!result.ok) {
    throw new RigStoreError(result.errors.map(({ message }) => message).join("; "))
  }
  await writeAtomic(destination, result.rig, false)
}

export async function exportFile(name: string, path: string, options: ExportOptions = {}): Promise<void> {
  requireValidName(name)
  try {
    await copyFile(rigFile(name), path, options.force === true ? 0 : constants.COPYFILE_EXCL)
  } catch (error) {
    if (isCollision(error)) {
      throw new RigStoreError(`${path} already exists`, { cause: error })
    }
    throw error
  }
}

export async function listProfiles(): Promise<readonly ProfileSource[]> {
  const current = activeProfile()
  const profilesRoot = join(baseConfigRoot(), "profiles")
  let directories: Dirent[]
  try {
    directories = await readdir(profilesRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) directories = []
    else throw error
  }

  const names = directories
    .filter((entry) => entry.isDirectory() && entry.name !== current)
    .map((entry) => entry.name)
  if (current !== undefined) names.push("default")
  names.sort((left, right) => left.localeCompare(right))

  return Promise.all(names.map((name) => {
    const root = name === "default"
      ? baseConfigRoot()
      : join(profilesRoot, name)
    return profileSource(name, join(root, "agent", "config.yml"))
  }))
}
