import fs from "node:fs/promises"
import path from "node:path"
import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
} from "@anthropic-ai/sandbox-runtime"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import type { Plugin } from "@opencode-ai/plugin"
import { version } from "../package.json"
import { loadConfig, loadSrtSettings, resolveConfig } from "./config"

const TAG = `[opencode-sandbox v${version}]`

export type { SrtSettings } from "./config"

/**
 * These tools run in the host Node.js process and are not covered by the
 * bash sandbox (bwrap/seatbelt), which only wraps child processes. We
 * enforce the same denyRead / allowWrite rules from the sandbox config here
 * explicitly so that file access policy applies uniformly across all tools.
 */
const READ_TOOLS = new Set(["read", "glob", "grep"])
const WRITE_TOOLS = new Set(["write", "edit"])
const FILE_TOOL_PATH_ARG: Record<string, string> = {
  read: "filePath",
  glob: "path",
  grep: "path",
  write: "filePath",
  edit: "filePath",
}

function isUnder(filePath: string, dir: string): boolean {
  const resolved = path.resolve(filePath)
  const base = path.resolve(dir)
  return resolved === base || resolved.startsWith(base + path.sep)
}

function isPathDeniedForRead(filePath: string, config: FsReadRestrictionConfig): boolean {
  const denied = config.denyOnly.some((d) => isUnder(filePath, d))
  if (!denied) return false
  const allowedBack = config.allowWithinDeny?.some((a) => isUnder(filePath, a)) ?? false
  return !allowedBack
}

function isPathDeniedForWrite(filePath: string, config: FsWriteRestrictionConfig): boolean {
  const allowed = config.allowOnly.some((a) => isUnder(filePath, a))
  if (!allowed) return true
  return config.denyWithinAllow.some((d) => isUnder(filePath, d))
}

export const SandboxPlugin: Plugin = async ({ directory, worktree }) => {
  if (
    process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
    process.env.OPENCODE_DISABLE_SANDBOX === "true"
  ) {
    return {}
  }

  const userConfig = await loadConfig(directory)
  if (userConfig.disabled) return {}

  const srtSettings = await loadSrtSettings()
  if (srtSettings) {
    console.log(`${TAG} Loaded settings from ~/.srt-settings.json`)
  }

  const runtimeConfig = resolveConfig(directory, worktree, userConfig, srtSettings ?? undefined)

  if (process.platform === "linux") {
    const denyReadPaths = runtimeConfig.filesystem?.denyRead ?? []
    await Promise.all(
      denyReadPaths.map((p) => fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {})),
    )
  }

  let sandboxReady = false
  try {
    await SandboxManager.initialize(runtimeConfig)
    sandboxReady = true
    console.log(
      `${TAG} Initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`,
    )
    if (process.platform === "win32") {
      console.log(
        `${TAG} Windows mode: network isolation active, filesystem restrictions apply to file tools only (not bash)`,
      )
    }
  } catch (err) {
    console.error(`${TAG} Failed to initialize:`, err instanceof Error ? err.message : err)
    console.warn(`${TAG} Commands will run without sandbox`)
  }

  if (!sandboxReady) return {}

  const originalCommands = new Map<string, string>()

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        const command = output.args?.command
        if (typeof command !== "string" || !command) return

        originalCommands.set(input.callID, command)

        try {
          output.args.command = await SandboxManager.wrapWithSandbox(command)
        } catch (err) {
          console.warn(
            `${TAG} Failed to wrap command, running unsandboxed:`,
            err instanceof Error ? err.message : err,
          )
        }
        return
      }

      // Enforce filesystem access policy for native file tools. These tools
      // run in the host Node.js process and bypass the bash sandbox entirely,
      // so we check paths here against the same config used by bwrap/seatbelt.
      const pathKey = FILE_TOOL_PATH_ARG[input.tool]
      if (pathKey && typeof output.args?.[pathKey] === "string") {
        const filePath = output.args[pathKey]
        if (READ_TOOLS.has(input.tool)) {
          if (isPathDeniedForRead(filePath, SandboxManager.getFsReadConfig())) {
            throw new Error(`${TAG} Read denied by sandbox policy: ${filePath}`)
          }
        } else if (WRITE_TOOLS.has(input.tool)) {
          if (isPathDeniedForWrite(filePath, SandboxManager.getFsWriteConfig())) {
            throw new Error(`${TAG} Write denied by sandbox policy: ${filePath}`)
          }
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return

      // Restore original command so the UI shows it instead of the bwrap wrapper
      const originalCommand = originalCommands.get(input.callID)
      if (originalCommand) {
        originalCommands.delete(input.callID)
        if (input.args && typeof input.args.command === "string") {
          input.args.command = originalCommand
        }
        if (typeof output.title === "string") {
          output.title = originalCommand
        }
      }
    },
  }
}

export default SandboxPlugin
