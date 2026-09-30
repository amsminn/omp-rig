import { describe, expect, test } from "bun:test"
import {
  argumentCompletions,
  inlineHint,
  parseCommand,
  type CompletionSource,
} from "../src/commands"

const sources: CompletionSource = {
  rigs: ["cn", "work"],
  profiles: ["company"],
}

describe("rig command parser", () => {
  test.each([
    ["", { action: "manager", args: [], scope: "session" }],
    ["cn", { action: "apply", source: "cn", scope: "session" }],
    [
      "rig:cn --scope project",
      { action: "apply", source: "rig:cn", scope: "project" },
    ],
    [
      "profile:company --scope global",
      { action: "apply", source: "profile:company", scope: "global" },
    ],
    ["list", { action: "list", args: [], scope: "session" }],
    ["show rig:cn", { action: "show", args: ["rig:cn"], scope: "session" }],
    ["current", { action: "current", args: [], scope: "session" }],
    ["diff", { action: "diff", args: [], scope: "session" }],
    ["new", { action: "new", args: [], scope: "session" }],
    ["new cn2", { action: "new", args: ["cn2"], scope: "session" }],
    ["edit cn", { action: "edit", args: ["cn"], scope: "session" }],
    ["update cn", { action: "update", args: ["cn"], scope: "session" }],
    [
      "rename cn china",
      { action: "rename", args: ["cn", "china"], scope: "session" },
    ],
    [
      "duplicate cn cn-copy",
      {
        action: "duplicate",
        args: ["cn", "cn-copy"],
        scope: "session",
      },
    ],
    ["remove cn", { action: "remove", args: ["cn"], scope: "session" }],
    ["off --scope project", { action: "off", args: [], scope: "project" }],
    ["clear --scope global", { action: "clear", args: [], scope: "global" }],
    ["next", { action: "next", args: [], scope: "session" }],
    ["prev", { action: "prev", args: [], scope: "session" }],
    ["doctor", { action: "doctor", args: [], scope: "session" }],
    [
      "import '/tmp/my rig.yml' imported",
      {
        action: "import",
        args: ["/tmp/my rig.yml", "imported"],
        scope: "session",
      },
    ],
    [
      "export cn '/tmp/my rig.yml'",
      {
        action: "export",
        args: ["cn", "/tmp/my rig.yml"],
        scope: "session",
      },
    ],
    ["help", { action: "help", args: [], scope: "session" }],
  ] as const)("%s", (input, expected) => {
    expect(parseCommand(input)).toEqual(expected)
  })

  test.each([
    ["rename cn", "Usage: /rig rename <name> <new-name>"],
    ["remove", "Usage: /rig remove <name>"],
    ["list extra", "Usage: /rig list"],
    ["show cn --scope project", "Usage: /rig show <name>"],
    ["off --scope nope", "--scope must be session, project, or global"],
    ["cn --scope session --scope global", "--scope may be specified only once"],
    ["import", "Usage: /rig import <file> [name]"],
    ["'cn", "Unterminated quoted argument"],
  ])("rejects %s", (input, message) => {
    expect(() => parseCommand(input)).toThrow(message)
  })
})

describe("rig command completions", () => {
  test("empty prefix offers commands and explicit rig and profile names", () => {
    const labels = argumentCompletions("", sources)?.map(item => item.label)

    expect(labels).toContain("list")
    expect(labels).toContain("rig:cn")
    expect(labels).toContain("profile:company")
  })

  test("re prefix offers rename and remove", () => {
    expect(argumentCompletions("re", sources)?.map(item => item.label))
      .toEqual(["rename", "remove"])
  })

  test("a rig followed by dash offers scope", () => {
    expect(argumentCompletions("cn --", sources)).toEqual([{
      value: "cn --scope ",
      label: "--scope",
      description: "Choose where the rig applies",
      hint: "<session|project|global>",
    }])
  })

  test("scope value prefix is completed", () => {
    expect(argumentCompletions("off --scope p", sources)).toEqual([{
      value: "off --scope project ",
      label: "project",
      description: "Use project scope",
    }])
  })

  test("name-taking commands offer prefixed forms", () => {
    const labels = argumentCompletions("show ", sources)?.map(item => item.label)

    expect(labels).toContain("rig:cn")
    expect(labels).toContain("profile:company")
  })
})

describe("rig command inline hints", () => {
  test("offers command and source shape at the root", () => {
    expect(inlineHint("", sources))
      .toBe("<rig|profile|command> [--scope session|project|global]")
  })

  test("completes scope values", () => {
    expect(inlineHint("off --scope p", sources)).toBe("roject")
  })

  test("shows missing rename arguments", () => {
    expect(inlineHint("rename cn", sources)).toBe(" <new-name>")
  })
})
