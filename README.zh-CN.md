[English](README.md) | **简体中文** | [한국어](README.ko.md)

<div align="center">
  <a href="https://github.com/amsminn/omp-rig">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="omp-rig 标志" src=".github/images/logo-light.svg" width="50%">
    </picture>
  </a>
</div>

<div align="center">
  <h3>一个列表，切换 omp 的所有模型角色和模型池。</h3>
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/omp-rig" target="_blank"><img src="https://img.shields.io/npm/v/omp-rig" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT" target="_blank"><img src="https://img.shields.io/npm/l/omp-rig" alt="License"></a>
  <a href="https://github.com/amsminn/omp-rig/actions/workflows/ci.yml" target="_blank"><img src="https://github.com/amsminn/omp-rig/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/omp-rig" target="_blank"><img src="https://img.shields.io/npm/dm/omp-rig" alt="npm downloads"></a>
</div>

<br>

omp-rig 是 [omp](https://github.com/can1357/oh-my-pi) 编程智能体的插件。rig 是一组保存好的模型设置：所有模型角色（`default`、`smol`、`slow`、`plan` 等），外加 omp 可以使用的模型和提供商。从列表里选中一个 rig，这些设置会在正在运行的会话里一次性全部切换，不用重启，也不会改动你的 `config.yml`。关掉它，你自己的配置就原样回来。

> [!TIP]
> `/rig` 是你唯一需要记住的命令。它会打开 rig 和 omp profile 的列表，在同一行显示每一项用到的模型，用方向键和 Enter 就能应用、编辑或保存。

## 快速开始

```bash
omp plugin install omp-rig
```

也可以直接从 GitHub 安装：

```bash
omp plugin install github:amsminn/omp-rig
```

然后在 omp 里输入：

```text
/rig
```

选择 `+ Save current setup as new rig`，把你现在用的模型存成第一个 rig。以后改了角色，再存一个 rig，两者之间的切换就只是打开列表、按一次 Enter。如果想从零开始，`+ Build new rig` 会一步一步带你建好一个 rig。

## 工作原理

rig 会应用到三个作用域之一，越具体的越优先：**session > project > global**。

| 作用域 | 选择保存在哪里 | 持续范围 |
| --- | --- | --- |
| session（默认） | 会话记录中的一个条目 | 当前会话，包括 `/resume`、重启和分支 |
| project | 项目目录下的 `.omp/rig` | 在该项目中启动的每个会话 |
| global | omp agent 目录下的 `rig.active` | 当前 omp profile 的每个会话 |

rig 本身从不写进 `config.yml`。omp-rig 把它写入 omp 的运行时设置层，这一层叠在你的全局配置和项目配置之上，执行 `/rig off` 时再把它移除。rig 生效期间会遮住你的配置，但它不是你的配置：`omp config get modelRoles` 显示的仍然是你保存的值。

所有角色一次性替换。rig 没有列出的聊天角色会用 rig 的 `default` 模型，所以你的配置和上一个 rig 都不会有残留。图像、语音和网页角色保留原来配置的模型，除非 rig 明确设置了它们。

在做任何改动之前，omp-rig 会检查 rig 里的每个模型：能否解析、凭据是否可用、是否落在 rig 自己的模型池里。只要有一项不通过，就什么都不应用，并列出所有问题。

模型池按提供商强制执行：列表（Ctrl+P、`/model`）遵循 `enabledModels`，而子智能体只会被挡在 rig 之外的提供商门外。`inferhub/*` 这样的模式会被完整执行。`inferhub/glm-5.3-flash` 这种更窄的模式会在列表里隐藏其他 inferhub 模型，但子智能体按名称点名要其中某个模型时仍然能用到，`/rig doctor` 会就此给出警告。

在命令行设置的角色（`--model`、`--smol`、`--slow`、`--plan`，或对应的环境变量）优先于启动时应用的 rig。状态栏会把当前 rig 显示为 `rig: <name>`（或 `profile: <name>`），当你的角色和它不一致时会带上 `*`，比如在 `/model` 里另选了模型之后。

rig 存放在 `~/.omp/rigs/`，所有 omp profile 共用。`--profile`、`OMP_PROFILE`、`PI_CODING_AGENT_DIR` 和 `PI_CONFIG_DIR` 都会被遵循。

## Rig 文件

每个 rig 都是 `~/.omp/rigs/<name>.yml` 下的一个 YAML 文件。它沿用 omp 自己的设置名，所以片段可以在 rig 和 `config.yml` 之间直接来回粘贴。

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `modelRoles` | 是 | 角色到 `provider/model[:level]` 的映射；必须设置 `default` |
| `enabledModels` | 否 | omp 可以列出和使用的模型模式；其他已认证的提供商会被屏蔽 |
| `disabledProviders` | 否 | 在所有路径上屏蔽的提供商，子智能体也包括在内 |
| `description` | 否 | 在列表中显示的一行说明 |

级别可以是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 和 `auto`。名称必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，`list`、`off` 这类命令词不能用作名称。出现任何其他键都会报错。

日常工作交给 Claude，硬骨头交给 Codex（`~/.omp/rigs/cc.yml`）：

```yaml
description: Claude for everyday work, Codex for hard problems
modelRoles:
  default: anthropic/claude-sonnet-4-5:medium
  smol: anthropic/claude-haiku-4-5:low
  slow: openai/gpt-5.1-codex:xhigh
  plan: openai/gpt-5.1-codex:high
enabledModels: [anthropic/*, openai/*]
```

只用中国模型，通过 `inferhub` 提供商（`~/.omp/rigs/cn.yml`）：

```yaml
description: Chinese models only (inferhub)
modelRoles:
  default: inferhub/glm-5.3-flash:high
  smol: inferhub/deepseek-v4.1-flash:low
enabledModels: [inferhub/*]
disabledProviders: [anthropic]
```

`cn` 生效时，Ctrl+P 和 `/model` 只提供 inferhub 模型，主会话和它的子智能体都无法调用 Anthropic，也无法调用模型池之外的任何其他提供商。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/rig` | 打开 rig 列表 |
| `/rig <name> [--scope session\|project\|global]` | 应用一个 rig；想明确指定时用 `rig:<name>` 或 `profile:<name>` |
| `/rig list` | 打开 rig 列表（没有 UI 时输出纯文本） |
| `/rig show <name>` | 查看一个 rig 或 profile |
| `/rig current` | 查看当前 rig、每个作用域的选择以及实际生效的角色 |
| `/rig diff` | 查看应用 rig 之后改动过的角色 |
| `/rig new [name]` | 一步步新建 rig，或把当前设置保存为 `<name>` |
| `/rig edit <name>` | 在角色编辑器里或以 YAML 形式编辑 rig |
| `/rig update <name>` | 用当前设置替换一个 rig |
| `/rig rename <name> <new-name>` | 重命名 rig |
| `/rig duplicate <name> <new-name>` | 复制 rig |
| `/rig remove <name>` | 删除 rig |
| `/rig off [--scope session\|project\|global]` | 在该作用域使用你自己的 omp 设置 |
| `/rig clear [--scope session\|project\|global]` | 清除该作用域的选择，让下一级作用域生效 |
| `/rig next` | 按字母顺序应用下一个 rig |
| `/rig prev` | 应用上一个 rig |
| `/rig doctor` | 对照你能用的模型检查每个 rig |
| `/rig import <file> [name]` | 导入 rig 文件 |
| `/rig export <name> [file]` | 导出 rig 文件 |
| `/rig help` | 显示命令帮助 |

`/rigs` 是 `/rig` 的别名。子命令、rig 名称和 `--scope` 的取值都有补全和行内提示，直接输入的命令在 print 和 RPC 模式下同样可用。

启动 omp 时就为会话应用一个 rig：

```bash
omp --rig cn
```

默认不绑定任何按键。想用快捷键轮换 rig，自己设一个即可：

```bash
omp plugin config set omp-rig cycleKey ctrl+alt+r
```

## 为什么选择 omp-rig？

- **所有角色，一次切换**：rig 没写的角色会回落到它的 `default` 模型，你的配置和上一个 rig 都不会留下任何东西
- **不只管角色，还管模型池**：把 omp 限定在你信得过的模型上，其他提供商一律屏蔽，子智能体也不例外
- **不用重启，不改配置**：rig 放在设置之上的运行时层里，`/rig off` 立刻让你自己的设置回来
- **不会只应用一半**：动手之前，每个模型都要通过匹配、凭据和模型池三项检查
- **作用域贴合你的工作方式**：在一个会话里试用 rig，固定到某个项目，或者设成全局默认
- **你的 omp profile，一个 Enter 就到**：现有 profile 会以 `profile:` 条目出现，不用离开会话就能借用它们的模型设置
- **在列表里管好一切**：保存、新建、编辑、重命名、复制、导入、导出和删除 rig，都不用碰文件

---

## 资源

- [omp](https://github.com/can1357/oh-my-pi)：omp-rig 所接入的编程智能体
- [Issues](https://github.com/amsminn/omp-rig/issues)：问题反馈和功能请求
- [更新日志](CHANGELOG.md)：每个版本的变更内容
- [许可证](LICENSE)：MIT
