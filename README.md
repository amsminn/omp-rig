**English** | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

<div align="center">
  <a href="https://github.com/amsminn/omp-rig">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="omp-rig logo" src=".github/images/logo-light.svg" width="50%">
    </picture>
  </a>
</div>

<div align="center">
  <h3>Switch every omp model role — and the model pool — from one list.</h3>
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/omp-rig" target="_blank"><img src="https://img.shields.io/npm/v/omp-rig" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT" target="_blank"><img src="https://img.shields.io/npm/l/omp-rig" alt="License"></a>
  <a href="https://github.com/amsminn/omp-rig/actions/workflows/ci.yml" target="_blank"><img src="https://github.com/amsminn/omp-rig/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/omp-rig" target="_blank"><img src="https://img.shields.io/npm/dm/omp-rig" alt="npm downloads"></a>
</div>

<br>

omp-rig is a plugin for the [omp](https://github.com/can1357/oh-my-pi) coding agent. A rig is a saved set of model settings: every model role (`default`, `smol`, `slow`, `plan` and the rest) plus the models and providers omp is allowed to use. Pick a rig from a list and all of it switches at once, in the running session, with no restart and no edits to your `config.yml`. Turn it off and your own setup comes back exactly as it was.

> [!TIP]
> `/rig` is the only command you need to remember. It opens a list of your rigs and omp profiles, shows each one's models on the same line, and lets you apply, edit or save with the arrow keys and Enter.

## Quickstart

```bash
omp plugin install omp-rig
```

You can also install straight from GitHub:

```bash
omp plugin install github:amsminn/omp-rig
```

Then, inside omp:

```text
/rig
```

Pick `+ Save current setup as new rig` to turn the models you use today into your first rig. Change your roles later, save a second rig, and switching between the two is one list and one Enter away. `+ Build new rig` walks you through a rig one step at a time if you'd rather start from scratch.

## How it works

A rig is applied to one of three scopes. The most specific choice wins: **session > project > global**.

| Scope | Where the choice is stored | Lasts for |
| --- | --- | --- |
| session (default) | an entry in the session transcript | this session, including `/resume`, restarts and branches |
| project | `.omp/rig` in the project directory | every session started in that project |
| global | `rig.active` in your omp agent directory | every session of the current omp profile |

The rig itself is never copied into `config.yml`. omp-rig writes it to omp's runtime settings layer, which sits on top of your global and project config, and removes it again with `/rig off`. A rig masks your config while it is active; it is not your config - `omp config get modelRoles` still shows your saved values.

Every role is replaced at once. Chat roles the rig doesn't list take the rig's `default` model, so nothing leaks over from your config or from the previous rig. Image, speech and web roles keep their configured model unless the rig sets them.

Before anything changes, omp-rig checks that every model in the rig resolves, has working credentials and fits the rig's own pool. If any check fails, nothing is applied and every problem is listed.

Pools are enforced per provider: listings (Ctrl+P, `/model`) follow `enabledModels`, while subagents are blocked only from providers outside the rig. A pattern like `inferhub/*` is fully enforced. A narrower one like `inferhub/glm-5.3-flash` hides other inferhub models from the lists, but a subagent that asks for one by name can still reach it, and `/rig doctor` warns about that.

Roles you set on the command line (`--model`, `--smol`, `--slow`, `--plan`, or the matching environment variables) win over a rig applied at startup. The status line shows the active rig as `rig: <name>` (or `profile: <name>`), with a `*` when your roles have drifted from it, for example after a `/model` pick.

Rigs live in `~/.omp/rigs/` and are shared by every omp profile. `--profile`, `OMP_PROFILE`, `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` are all honored.

## Rig files

Each rig is a YAML file at `~/.omp/rigs/<name>.yml`. It uses omp's own setting names, so snippets paste both ways between a rig and `config.yml`.

| Key | Required | Meaning |
| --- | --- | --- |
| `modelRoles` | yes | role to `provider/model[:level]`; `default` must be set |
| `enabledModels` | no | model patterns omp may list and use; other authenticated providers are blocked |
| `disabledProviders` | no | providers to block on every path, subagents included |
| `description` | no | one line shown in the list |

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `auto`. Names match `^[a-z0-9][a-z0-9._-]{0,63}$`, and command words such as `list` or `off` can't be used as names. Any other key is an error.

Claude for everyday work, Codex for the heavy lifting (`~/.omp/rigs/cc.yml`):

```yaml
description: Claude for everyday work, Codex for hard problems
modelRoles:
  default: anthropic/claude-sonnet-4-5:medium
  smol: anthropic/claude-haiku-4-5:low
  slow: openai/gpt-5.1-codex:xhigh
  plan: openai/gpt-5.1-codex:high
enabledModels: [anthropic/*, openai/*]
```

Chinese models only, through an `inferhub` provider (`~/.omp/rigs/cn.yml`):

```yaml
description: Chinese models only (inferhub)
modelRoles:
  default: inferhub/glm-5.3-flash:high
  smol: inferhub/deepseek-v4.1-flash:low
enabledModels: [inferhub/*]
disabledProviders: [anthropic]
```

With `cn` active, Ctrl+P and `/model` offer only inferhub models, and neither the main session nor its subagents can call Anthropic or any other provider outside the pool.

## Commands

| Command | What it does |
| --- | --- |
| `/rig` | Open the rig list |
| `/rig <name> [--scope session\|project\|global]` | Apply a rig; use `rig:<name>` or `profile:<name>` to be explicit |
| `/rig list` | Open the rig list (plain text without a UI) |
| `/rig show <name>` | Show a rig or profile |
| `/rig current` | Show the active rig, each scope's choice and the effective roles |
| `/rig diff` | Show roles changed since the rig was applied |
| `/rig new [name]` | Build a rig step by step, or save the current setup as `<name>` |
| `/rig edit <name>` | Edit a rig in the role editor or as YAML |
| `/rig update <name>` | Replace a rig with the current setup |
| `/rig rename <name> <new-name>` | Rename a rig |
| `/rig duplicate <name> <new-name>` | Copy a rig |
| `/rig remove <name>` | Remove a rig |
| `/rig off [--scope session\|project\|global]` | Use your own omp setup at that scope |
| `/rig clear [--scope session\|project\|global]` | Drop that scope's choice so the next scope down applies |
| `/rig next` | Apply the next rig, in alphabetical order |
| `/rig prev` | Apply the previous rig |
| `/rig doctor` | Check every rig against the models you can use |
| `/rig import <file> [name]` | Import a rig file |
| `/rig export <name> [file]` | Export a rig file |
| `/rig help` | Show command help |

`/rigs` is an alias for `/rig`. Subcommands, rig names and `--scope` values have completions and inline hints, and typed commands also work in print and RPC modes.

To start omp with a rig already applied to the session:

```bash
omp --rig cn
```

No key is bound by default. To cycle rigs with a shortcut, set one:

```bash
omp plugin config set omp-rig cycleKey ctrl+alt+r
```

## Why omp-rig?

- **Every role, one switch** — roles a rig leaves out fall back to its `default` model, so nothing from your config or the last rig lingers
- **Control the pool, not only the roles** — limit omp to the models you trust and block every other provider, subagents included
- **No restart, no config edits** — rigs live in a runtime layer on top of your settings, and `/rig off` brings your own setup straight back
- **Nothing half-applied** — every model is checked for a match, credentials and pool fit before anything changes
- **Scopes that match how you work** — try a rig in one session, pin it to a project, or make it your global default
- **Your omp profiles, one Enter away** — existing profiles show up as `profile:` entries whose model settings you can borrow without leaving the session
- **Manage it all from the list** — save, build, edit, rename, duplicate, import, export and remove rigs without touching a file

---

## Resources

- [omp](https://github.com/can1357/oh-my-pi): the coding agent omp-rig plugs into
- [Issues](https://github.com/amsminn/omp-rig/issues): bug reports and feature requests
- [Changelog](CHANGELOG.md): what changed in each release
- [License](LICENSE): MIT
