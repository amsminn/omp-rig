import { join } from "node:path"

type SectionRange = Readonly<{
  start: number
  contentStart: number
  end: number
}>

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sectionRange(changelog: string, heading: string): SectionRange | undefined {
  const pattern = new RegExp(`^## ${escapeRegularExpression(heading)}[\\t ]*\\r?$`, "m")
  const match = pattern.exec(changelog)
  if (match?.index === undefined) {
    return undefined
  }

  const contentStart = match.index + match[0].length
  const nextHeading = changelog.indexOf("\n## ", contentStart)

  return {
    start: match.index,
    contentStart,
    end: nextHeading === -1 ? changelog.length : nextHeading + 1,
  }
}

export function releaseChangelog(changelog: string, version: string, date: string): string {
  const unreleased = sectionRange(changelog, "Unreleased")
  if (!unreleased) {
    throw new Error("CHANGELOG.md is missing a ## Unreleased section")
  }

  const entries = changelog.slice(unreleased.contentStart, unreleased.end)
  if (entries.trim().length === 0) {
    throw new Error("CHANGELOG.md has no entries under ## Unreleased")
  }

  const releasedHeading = `## ${version} - ${date}`
  return [
    changelog.slice(0, unreleased.start),
    "## Unreleased\n\n",
    releasedHeading,
    entries,
    changelog.slice(unreleased.end),
  ].join("")
}

export function releaseNotes(changelog: string, version: string): string {
  const section = sectionRange(changelog, `${version} -`)
    ?? sectionRangeByVersion(changelog, version)
  if (!section) {
    throw new Error(`CHANGELOG.md has no section for version ${version}`)
  }

  return changelog.slice(section.start, section.end).trimEnd()
}

function sectionRangeByVersion(changelog: string, version: string): SectionRange | undefined {
  const pattern = new RegExp(`^## ${escapeRegularExpression(version)} - .+[\\t ]*\\r?$`, "m")
  const match = pattern.exec(changelog)
  if (match?.index === undefined) {
    return undefined
  }

  const contentStart = match.index + match[0].length
  const nextHeading = changelog.indexOf("\n## ", contentStart)

  return {
    start: match.index,
    contentStart,
    end: nextHeading === -1 ? changelog.length : nextHeading + 1,
  }
}

async function main(): Promise<void> {
  const [command, version] = process.argv.slice(2)
  if ((command !== "release" && command !== "notes") || !version) {
    throw new Error("Usage: bun scripts/changelog.ts <release|notes> <version>")
  }

  const changelogPath = join(process.cwd(), "CHANGELOG.md")
  const changelog = await Bun.file(changelogPath).text()

  if (command === "release") {
    const date = new Date().toISOString().slice(0, 10)
    await Bun.write(changelogPath, releaseChangelog(changelog, version, date))
    return
  }

  process.stdout.write(`${releaseNotes(changelog, version)}\n`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
