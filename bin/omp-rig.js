#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const PACKAGE = "omp-rig"

const USAGE = `Usage: npx omp-rig <command> [options]

Commands:
  install     Install omp-rig into omp (runs: omp plugin install omp-rig@latest)
  uninstall   Remove omp-rig from omp (runs: omp plugin uninstall omp-rig)
  help        Show this message

Options are passed through to omp, for example: npx omp-rig install --scope project
`

function runOmp(args) {
  const result = spawnSync("omp", args, { stdio: "inherit", shell: process.platform === "win32" })
  if (result.error?.code === "ENOENT") {
    process.stderr.write("omp was not found on PATH. Install omp first: https://github.com/can1357/oh-my-pi\n")
    return 1
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case "install":
    process.exitCode = runOmp(["plugin", "install", `${PACKAGE}@latest`, ...rest])
    break
  case "uninstall":
    process.exitCode = runOmp(["plugin", "uninstall", PACKAGE, ...rest])
    break
  case undefined:
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(USAGE)
    break
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
    process.exitCode = 1
}
