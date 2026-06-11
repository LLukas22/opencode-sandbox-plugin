import fs from "node:fs/promises"
import path from "node:path"
import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
} from "@anthropic-ai/sandbox-runtime"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import type { Plugin } from "@opencode-ai/plugin"
import { version } from "../package.json"
import { ensureDefaultConfig, loadConfig, resolveConfig } from "./config"
import { logger } from "./logger"

const TAG = `[opencode-sandbox v${version}]`

export type { SrtSettings } from "./config"

const READ_TOOLS = new Set(["read", "glob", "grep"])
const WRITE_TOOLS = new Set(["write", "edit"])
const FILE_TOOL_PATH_ARG: Record<string, string> = {
  read: "filePath",
  glob: "path",
  grep: "path",
  write: "filePath",
  edit: "filePath",
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isUnder(filePath: string, dir: string): boolean {
  const resolved = normalizePath(filePath)
  const base = normalizePath(dir)
  const sep = base.endsWith(path.sep) ? "" : path.sep
  return resolved === base || resolved.startsWith(base + sep)
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

const SandboxPlugin: Plugin = async ({ directory, worktree }) => {
  logger.init()
  logger.info(
    `Plugin starting v${version} | platform=${process.platform} | directory=${directory} | worktree=${worktree}`,
  )

  if (
    process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
    process.env.OPENCODE_DISABLE_SANDBOX === "true"
  ) {
    logger.info("Plugin disabled via OPENCODE_DISABLE_SANDBOX env var")
    return {}
  }

  const createdConfig = await ensureDefaultConfig()
  if (createdConfig) {
    logger.info(`Created default config at: ${createdConfig}`)
    console.log(`${TAG} Created default config at: ${createdConfig}`)
  }

  const config = await loadConfig()
  if (config.disabled) {
    logger.info("Plugin disabled via config.disabled=true")
    return {}
  }

  const runtimeConfig = resolveConfig(directory, worktree, config)
  logger.info(`Resolved config: allowWrite=${JSON.stringify(runtimeConfig.filesystem?.allowWrite)}`)
  logger.info(`Resolved config: denyRead=${JSON.stringify(runtimeConfig.filesystem?.denyRead)}`)
  logger.info(`Resolved config: allowRead=${JSON.stringify(runtimeConfig.filesystem?.allowRead)}`)
  logger.info(`Resolved config: denyWrite=${JSON.stringify(runtimeConfig.filesystem?.denyWrite)}`)
  logger.info(
    `Network config: allowedDomains=${JSON.stringify(runtimeConfig.network?.allowedDomains)}`,
  )

  if (process.platform === "linux") {
    const denyReadPaths = runtimeConfig.filesystem?.denyRead ?? []
    await Promise.all(
      denyReadPaths.map((p) => fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {})),
    )
  }

  let sandboxReady = false
  try {
    logger.info("Initializing SandboxManager...")
    await SandboxManager.initialize(runtimeConfig)
    sandboxReady = true
    logger.info("SandboxManager initialized successfully")
    console.log(
      `${TAG} Initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`,
    )
    if (process.platform === "win32") {
      logger.info(
        "Windows mode: network isolation active, filesystem restrictions apply to file tools only",
      )
      console.log(
        `${TAG} Windows mode: network isolation active, filesystem restrictions apply to file tools only (not bash)`,
      )
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? err.stack : undefined
    logger.error(`SandboxManager.initialize() failed: ${errMsg}`)
    if (errStack) logger.error(`Stack: ${errStack}`)
    console.error(`${TAG} Failed to initialize:`, errMsg)
    console.warn(`${TAG} Commands will run without sandbox`)
  }

  if (!sandboxReady) {
    logger.warn("Sandbox not ready — returning empty hooks (fail-open)")
    return {}
  }

  const fsReadConfig: FsReadRestrictionConfig = {
    denyOnly: runtimeConfig.filesystem?.denyRead ?? [],
    allowWithinDeny: runtimeConfig.filesystem?.allowRead ?? [],
  }
  const fsWriteConfig: FsWriteRestrictionConfig = {
    allowOnly: runtimeConfig.filesystem?.allowWrite ?? [],
    denyWithinAllow: runtimeConfig.filesystem?.denyWrite ?? [],
  }

  logger.info("Hooks registered — plugin active")

  const originalCommands = new Map<string, string>()
  const sandboxEnvs = new Map<string, Record<string, string | undefined>>()

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        const command = output.args?.command
        if (typeof command !== "string" || !command) return

        originalCommands.set(input.callID, command)
        logger.debug(`[bash] callID=${input.callID} command="${command.slice(0, 200)}"`)

        try {
          if (process.platform === "win32") {
            const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command, "powershell")
            sandboxEnvs.set(input.callID, env)
            output.args.command = `& ${argv.map(psQuote).join(" ")}`
            logger.debug(
              `[bash] callID=${input.callID} wrapped (Windows): ${output.args.command.slice(0, 300)}`,
            )
          } else {
            output.args.command = await SandboxManager.wrapWithSandbox(command)
            logger.debug(`[bash] callID=${input.callID} wrapped successfully`)
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          logger.warn(`[bash] callID=${input.callID} wrap failed, running unsandboxed: ${errMsg}`)
          console.warn(`${TAG} Failed to wrap command, running unsandboxed:`, errMsg)
        }
        return
      }

      const pathKey = FILE_TOOL_PATH_ARG[input.tool]
      if (pathKey && typeof output.args?.[pathKey] === "string") {
        const filePath = output.args[pathKey]

        if (READ_TOOLS.has(input.tool)) {
          const denied = isPathDeniedForRead(filePath, fsReadConfig)
          if (denied) {
            const matchedRule = fsReadConfig.denyOnly.find((d) => isUnder(filePath, d))
            logger.warn(
              `[${input.tool}] READ DENIED path="${filePath}" matchedDenyRule="${matchedRule}"`,
            )
            throw new Error(`${TAG} Read denied by sandbox policy: ${filePath}`)
          }
          logger.debug(`[${input.tool}] read allowed path="${filePath}"`)
        } else if (WRITE_TOOLS.has(input.tool)) {
          const denied = isPathDeniedForWrite(filePath, fsWriteConfig)
          if (denied) {
            const inAllowList = fsWriteConfig.allowOnly.some((a) => isUnder(filePath, a))
            if (!inAllowList) {
              logger.warn(
                `[${input.tool}] WRITE DENIED path="${filePath}" reason="not in allowOnly" allowOnly=${JSON.stringify(fsWriteConfig.allowOnly)}`,
              )
            } else {
              const matchedDeny = fsWriteConfig.denyWithinAllow.find((d) => isUnder(filePath, d))
              logger.warn(
                `[${input.tool}] WRITE DENIED path="${filePath}" reason="matched denyWithinAllow" matchedRule="${matchedDeny}"`,
              )
            }
            throw new Error(`${TAG} Write denied by sandbox policy: ${filePath}`)
          }
          const matchedAllow = fsWriteConfig.allowOnly.find((a) => isUnder(filePath, a))
          logger.debug(
            `[${input.tool}] write allowed path="${filePath}" matchedAllowRule="${matchedAllow}"`,
          )
        }
      }
    },

    "shell.env": async (input, output) => {
      if (!input.callID || !sandboxEnvs.has(input.callID)) return
      const env = sandboxEnvs.get(input.callID)
      sandboxEnvs.delete(input.callID)
      if (!env) return
      for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) output.env[k] = v as string
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return

      sandboxEnvs.delete(input.callID)
      const originalCommand = originalCommands.get(input.callID)
      if (originalCommand) {
        originalCommands.delete(input.callID)
        if (input.args && typeof input.args.command === "string") {
          input.args.command = originalCommand
        }
        if (typeof output.title === "string") {
          output.title = originalCommand
        }
        logger.debug(`[bash] callID=${input.callID} restored original command in after-hook`)
      }
    },
  }
}

export { SandboxPlugin }
export default SandboxPlugin
