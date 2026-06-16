import { beforeEach, describe, expect, mock, test } from "bun:test"

// Mock the SandboxManager before importing the plugin
const mockInitialize = mock(() => Promise.resolve())
const mockWrapWithSandbox = mock((cmd: string) => Promise.resolve(`srt-wrapped: ${cmd}`))
const mockWrapWithSandboxArgv = mock((cmd: string, _binShell?: string) =>
  Promise.resolve({
    argv: ["srt-win.exe", "exec", "--", "powershell.exe", "-NoProfile", "-Command", cmd],
    env: { ...process.env, SRT_SANDBOX: "1", SRT_LOG: "/tmp/srt.log" },
  }),
)
const mockReset = mock(() => Promise.resolve())
const mockGetFsReadConfig = mock(() => ({
  denyOnly: ["/home/user/.ssh", "/home/user/.aws"],
  allowWithinDeny: [] as string[],
}))
const mockGetFsWriteConfig = mock(() => ({
  allowOnly: ["/tmp/project"],
  denyWithinAllow: [] as string[],
}))

mock.module("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: mockInitialize,
    wrapWithSandbox: mockWrapWithSandbox,
    wrapWithSandboxArgv: mockWrapWithSandboxArgv,
    reset: mockReset,
    getFsReadConfig: mockGetFsReadConfig,
    getFsWriteConfig: mockGetFsWriteConfig,
  },
}))

import { SandboxPlugin, _resetPluginInstance } from "../src/index"

const makeCtx = (dir = "/tmp/project", worktree = "/tmp/project") => ({
  client: {} as any,
  project: {} as any,
  directory: dir,
  worktree: worktree,
  serverUrl: new URL("http://localhost:4096"),
  $: (() => {}) as any,
})

describe("SandboxPlugin", () => {
  beforeEach(() => {
    _resetPluginInstance()
    mockInitialize.mockClear()
    mockWrapWithSandbox.mockClear()
    mockWrapWithSandboxArgv.mockClear()
    mockGetFsReadConfig.mockClear()
    mockGetFsWriteConfig.mockClear()
    delete process.env.OPENCODE_DISABLE_SANDBOX
    delete process.env.OPENCODE_SANDBOX_CONFIG
  })

  test("initializes sandbox on plugin load", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    expect(mockInitialize).toHaveBeenCalledTimes(1)
    expect(hooks["tool.execute.before"]).toBeDefined()
    expect(hooks["tool.execute.after"]).toBeDefined()
  })

  test("initializes SandboxManager once per project", async () => {
    await SandboxPlugin(makeCtx())
    await SandboxPlugin(makeCtx("/other/project", "/other/project"))
    expect(mockInitialize).toHaveBeenCalledTimes(2)
    await SandboxPlugin(makeCtx("/other/project", "/other/project"))
    expect(mockInitialize).toHaveBeenCalledTimes(2)
  })

  test("does not double-wrap bash command when hook called twice for same callID", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "bash", sessionID: "s1", callID: "c1" }
    const output = { args: { command: "ls -la" } }

    await hooks["tool.execute.before"]?.(input, output)
    const wrappedOnce = output.args.command

    await hooks["tool.execute.before"]?.(input, output)

    expect(output.args.command).toBe(wrappedOnce)
    if (process.platform === "win32") {
      expect(mockWrapWithSandboxArgv).toHaveBeenCalledTimes(1)
    } else {
      expect(mockWrapWithSandbox).toHaveBeenCalledTimes(1)
    }
  })

  test("returns empty hooks when OPENCODE_DISABLE_SANDBOX=1", async () => {
    process.env.OPENCODE_DISABLE_SANDBOX = "1"
    const hooks = await SandboxPlugin(makeCtx())
    expect(hooks["tool.execute.before"]).toBeUndefined()
    expect(mockInitialize).not.toHaveBeenCalled()
  })

  test("wraps bash commands via tool.execute.before", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "bash", sessionID: "s1", callID: "c1" }
    const output = { args: { command: "ls -la" } }

    await hooks["tool.execute.before"]?.(input, output)

    if (process.platform === "win32") {
      expect(mockWrapWithSandboxArgv).toHaveBeenCalledWith("ls -la", "powershell")
      expect(output.args.command).toContain("srt-win.exe")
      expect(output.args.command).toContain("ls -la")
    } else {
      expect(mockWrapWithSandbox).toHaveBeenCalledWith("ls -la")
      expect(output.args.command).toBe("srt-wrapped: ls -la")
    }
  })

  test("shell.env hook applies sandbox env for Windows calls", async () => {
    if (process.platform !== "win32") return

    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "bash", sessionID: "s1", callID: "c1" }
    const output = { args: { command: "ls -la" } }

    await hooks["tool.execute.before"]?.(input, output)

    const envOutput = { env: {} as Record<string, string> }
    await hooks["shell.env"]?.({ cwd: "/tmp/project", sessionID: "s1", callID: "c1" }, envOutput)

    expect(envOutput.env.SRT_SANDBOX).toBe("1")
    expect(envOutput.env.SRT_LOG).toBe("/tmp/srt.log")
  })

  test("shell.env hook is no-op for unknown callID", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const envOutput = { env: {} as Record<string, string> }

    await hooks["shell.env"]?.(
      { cwd: "/tmp/project", sessionID: "s1", callID: "unknown" },
      envOutput,
    )

    expect(envOutput.env).toEqual({})
  })

  test("does not wrap non-bash tools", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "read", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/etc/hosts" } }

    await hooks["tool.execute.before"]?.(input, output)

    expect(mockWrapWithSandbox).not.toHaveBeenCalled()
    expect(output.args.filePath).toBe("/etc/hosts")
  })

  test("passes through blocked command output unchanged", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "bash", sessionID: "s1", callID: "c1", args: {} }
    const output = {
      title: "test",
      output: "cat: /home/user/.ssh/id_rsa: Operation not permitted",
      metadata: {},
    }

    await hooks["tool.execute.after"]?.(input, output)

    expect(output.output).toBe("cat: /home/user/.ssh/id_rsa: Operation not permitted")
  })

  test("passes through normal command output unchanged", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "bash", sessionID: "s1", callID: "c1", args: {} }
    const output = {
      title: "test",
      output: "file1.ts\nfile2.ts",
      metadata: {},
    }

    await hooks["tool.execute.after"]?.(input, output)

    expect(output.output).toBe("file1.ts\nfile2.ts")
  })

  test("uses config from OPENCODE_SANDBOX_CONFIG env var", async () => {
    const denyPath = process.platform === "linux" ? "/tmp" : "/custom/secret"
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: {
        denyRead: [denyPath],
      },
    })

    await SandboxPlugin(makeCtx())

    const callArg = mockInitialize.mock.calls[0]?.[0] as any
    expect(callArg.filesystem.denyRead).toEqual([denyPath])
  })

  test("fails open when wrap throws", async () => {
    if (process.platform === "win32") {
      mockWrapWithSandboxArgv.mockImplementationOnce(() => {
        throw new Error("srt-win not found")
      })
    } else {
      mockWrapWithSandbox.mockImplementationOnce(() => {
        throw new Error("bwrap not found")
      })
    }

    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "bash", sessionID: "s1", callID: "c1" }
    const output = { args: { command: "echo hello" } }

    await hooks["tool.execute.before"]?.(input, output)

    expect(output.args.command).toBe("echo hello")
  })

  test("blocks read tool on denied path", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: { denyRead: ["/home/user/.ssh", "/home/user/.aws"] },
    })
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "read", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/home/user/.ssh/id_rsa" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).rejects.toThrow(
      "Read denied by sandbox policy",
    )
  })

  test("allows read tool on non-denied path", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "read", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/tmp/project/src/foo.ts" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).resolves.toBeUndefined()
  })

  test("allows read when path is re-allowed via allowWithinDeny", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: {
        denyRead: ["/home/user/.ssh"],
        allowRead: ["/home/user/.ssh/known_hosts"],
      },
    })
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "read", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/home/user/.ssh/known_hosts" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).resolves.toBeUndefined()
  })

  test("blocks write tool on non-allowed path", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "write", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/etc/passwd" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).rejects.toThrow(
      "Write denied by sandbox policy",
    )
  })

  test("allows write tool on allowed path", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "write", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/tmp/project/src/foo.ts" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).resolves.toBeUndefined()
  })

  test("blocks edit tool on path within denyWithinAllow", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: {
        allowWrite: ["/tmp/project"],
        denyWrite: ["/tmp/project/secret"],
      },
    })
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "edit", sessionID: "s1", callID: "c1" }
    const output = { args: { filePath: "/tmp/project/secret/key.pem" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).rejects.toThrow(
      "Write denied by sandbox policy",
    )
  })

  test("blocks grep tool on denied path", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: { denyRead: ["/home/user/.ssh", "/home/user/.aws"] },
    })
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "grep", sessionID: "s1", callID: "c1" }
    const output = { args: { pattern: "SECRET", path: "/home/user/.aws" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).rejects.toThrow(
      "Read denied by sandbox policy",
    )
  })

  test("skips path check for glob with no path arg", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const input = { tool: "glob", sessionID: "s1", callID: "c1" }
    const output = { args: { pattern: "**/*.ts" } }

    await expect(hooks["tool.execute.before"]?.(input, output)).resolves.toBeUndefined()
  })

  test("restores correct command for concurrent bash calls", async () => {
    const hooks = await SandboxPlugin(makeCtx())

    // Simulate two concurrent bash commands with different callIDs
    const input1 = { tool: "bash", sessionID: "s1", callID: "c1" }
    const output1 = { args: { command: "echo first" } }
    const input2 = { tool: "bash", sessionID: "s1", callID: "c2" }
    const output2 = { args: { command: "echo second" } }

    // Both "before" hooks fire before either "after" (simulating concurrent execution)
    await hooks["tool.execute.before"]?.(input1, output1)
    await hooks["tool.execute.before"]?.(input2, output2)

    // Now restore both - each should get its own original command
    const afterInput1 = {
      tool: "bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: output1.args.command },
    }
    const afterInput2 = {
      tool: "bash",
      sessionID: "s1",
      callID: "c2",
      args: { command: output2.args.command },
    }

    const afterOutput1 = { title: output1.args.command, output: "", metadata: {} }
    const afterOutput2 = { title: output2.args.command, output: "", metadata: {} }

    await hooks["tool.execute.after"]?.(afterInput1, afterOutput1)
    await hooks["tool.execute.after"]?.(afterInput2, afterOutput2)

    expect(afterInput1.args.command).toBe("echo first")
    expect(afterInput2.args.command).toBe("echo second")
    expect(afterOutput1.title).toBe("echo first")
    expect(afterOutput2.title).toBe("echo second")
  })

  test("restores original command in output.title for UI display", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const beforeInput = { tool: "bash", sessionID: "s1", callID: "c1" }
    const beforeOutput = { args: { command: "ls -la" } }

    await hooks["tool.execute.before"]?.(beforeInput, beforeOutput)

    const afterInput = {
      tool: "bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: beforeOutput.args.command },
    }
    const afterOutput = { title: beforeOutput.args.command, output: "file1\nfile2", metadata: {} }

    await hooks["tool.execute.after"]?.(afterInput, afterOutput)

    expect(afterInput.args.command).toBe("ls -la")
    expect(afterOutput.title).toBe("ls -la")
  })

  test("replaces wrapped command with original in output.output", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const beforeInput = { tool: "bash", sessionID: "s1", callID: "c1" }
    const beforeOutput = { args: { command: "cat /etc/hosts" } }

    await hooks["tool.execute.before"]?.(beforeInput, beforeOutput)
    const wrappedCmd = beforeOutput.args.command

    const afterInput = {
      tool: "bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: wrappedCmd },
    }
    const afterOutput = {
      title: wrappedCmd,
      output: `$ ${wrappedCmd}\n127.0.0.1 localhost\n::1 localhost`,
      metadata: {},
    }

    await hooks["tool.execute.after"]?.(afterInput, afterOutput)

    expect(afterOutput.output).toBe("$ cat /etc/hosts\n127.0.0.1 localhost\n::1 localhost")
  })

  test("does not modify output when no wrapped command present", async () => {
    const hooks = await SandboxPlugin(makeCtx())
    const beforeInput = { tool: "bash", sessionID: "s1", callID: "c1" }
    const beforeOutput = { args: { command: "echo hello" } }

    await hooks["tool.execute.before"]?.(beforeInput, beforeOutput)

    const afterInput = {
      tool: "bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: beforeOutput.args.command },
    }
    const afterOutput = {
      title: beforeOutput.args.command,
      output: "hello\nworld",
      metadata: {},
    }

    await hooks["tool.execute.after"]?.(afterInput, afterOutput)

    expect(afterOutput.output).toBe("hello\nworld")
  })
})
