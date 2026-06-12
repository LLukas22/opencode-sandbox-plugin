import fs from "node:fs/promises"
import path from "node:path"
import type { FsReadRestrictionConfig } from "@anthropic-ai/sandbox-runtime"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
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

const SRT_SIGNATURES = ["srt-win", "srt-linux", "srt-mac", "bwrap", "sandbox-exec"]

function isAlreadyWrapped(command: string): boolean {
  const lower = command.toLowerCase()
  return SRT_SIGNATURES.some((sig) => lower.includes(sig))
}

function cleanOutput(text: string, wrapped: string, original: string): string {
  let result = text.replaceAll(wrapped, original)

  for (const sig of SRT_SIGNATURES) {
    if (!result.toLowerCase().includes(sig)) continue
    result = result
      .split("\n")
      .map((line) => {
        if (!line.toLowerCase().includes(sig)) return line
        const cmdIdx = line.indexOf(original)
        if (cmdIdx !== -1) return line.slice(cmdIdx)
        return null
      })
      .filter((line): line is string => line !== null)
      .join("\n")
  }

  return result
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

function isPathDeniedForWrite(
  filePath: string,
  allowOnly: string[],
  denyWithinAllow: string[],
): boolean {
  const allowed = allowOnly.some((a) => isUnder(filePath, a))
  if (!allowed) return true
  return denyWithinAllow.some((d) => isUnder(filePath, d))
}

let disabled: boolean | null = null
let sandboxReady = false
const allowWritePaths: string[] = []
const denyWritePaths: string[] = []
const fsReadConfig: FsReadRestrictionConfig = { denyOnly: [], allowWithinDeny: [] }
const originalCommands = new Map<string, string>()
const wrappedCommands = new Map<string, string>()
const sandboxEnvs = new Map<string, Record<string, string | undefined>>()
const seenWritePaths = new Set<string>()
const seenProjects = new Set<string>()
let initLock: Promise<void> | null = null

function addWritePaths(paths: string[]): void {
  for (const p of paths) {
    const key = normalizePath(p)
    if (seenWritePaths.has(key)) continue
    seenWritePaths.add(key)
    allowWritePaths.push(p)
    logger.info(`Added write path: ${p}`)
  }
}

async function initForProject(directory: string, worktree: string): Promise<void> {
  const projectKey = `${normalizePath(directory)}|${normalizePath(worktree)}`
  if (seenProjects.has(projectKey)) return
  seenProjects.add(projectKey)

  logger.init()
  logger.info(
    `Plugin init for project | platform=${process.platform} | directory=${directory} | worktree=${worktree}`,
  )

  if (disabled === null) {
    if (
      process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
      process.env.OPENCODE_DISABLE_SANDBOX === "true"
    ) {
      logger.info("Plugin disabled via OPENCODE_DISABLE_SANDBOX env var")
      disabled = true
      return
    }

    const createdConfig = await ensureDefaultConfig()
    if (createdConfig) {
      logger.info(`Created default config at: ${createdConfig}`)
      console.log(`${TAG} Created default config at: ${createdConfig}`)
    }

    const config = await loadConfig()
    if (config.disabled) {
      logger.info("Plugin disabled via config.disabled=true")
      disabled = true
      return
    }
    disabled = false

    const runtimeConfig = resolveConfig(directory, worktree, config)
    fsReadConfig.denyOnly = runtimeConfig.filesystem?.denyRead ?? []
    fsReadConfig.allowWithinDeny = runtimeConfig.filesystem?.allowRead ?? []
    denyWritePaths.push(...(runtimeConfig.filesystem?.denyWrite ?? []))
    addWritePaths(runtimeConfig.filesystem?.allowWrite ?? [])

    logger.info(
      `Resolved config: allowWrite=${JSON.stringify(runtimeConfig.filesystem?.allowWrite)}`,
    )
    logger.info(`Resolved config: denyRead=${JSON.stringify(runtimeConfig.filesystem?.denyRead)}`)

    if (process.platform === "linux") {
      const denyReadPaths = runtimeConfig.filesystem?.denyRead ?? []
      await Promise.all(
        denyReadPaths.map((p) => fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {})),
      )
    }

    try {
      logger.info("Initializing SandboxManager...")
      await SandboxManager.initialize(runtimeConfig)
      sandboxReady = true
      logger.info("SandboxManager initialized successfully")
      console.log(
        `${TAG} Initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`,
      )
      if (process.platform === "win32") {
        console.log(
          `${TAG} Windows mode: network isolation active, filesystem restrictions apply to file tools only (not bash)`,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`SandboxManager.initialize() failed: ${errMsg}`)
      console.error(`${TAG} Failed to initialize:`, errMsg)
      console.warn(`${TAG} Commands will run without sandbox`)
    }
  } else {
    addWritePaths([directory, worktree].filter(Boolean))

    if (sandboxReady) {
      const config = await loadConfig()
      const runtimeConfig = resolveConfig(directory, worktree, config)
      try {
        await SandboxManager.initialize(runtimeConfig)
        logger.info(`Re-initialized SandboxManager for project: ${directory}`)
        console.log(
          `${TAG} Initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`,
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error(`SandboxManager re-initialize failed for ${directory}: ${errMsg}`)
      }
    }
  }
}

const SandboxPlugin: Plugin = async ({ directory, worktree }) => {
  if (!initLock) {
    initLock = initForProject(directory, worktree)
  } else {
    initLock = initLock.then(() => initForProject(directory, worktree))
  }
  await initLock

  if (disabled) return {}
  if (!sandboxReady) return {}

  addWritePaths([directory, worktree].filter(Boolean))
  logger.info(
    `Plugin call for directory=${directory} worktree=${worktree} — allowWrite now: ${JSON.stringify(allowWritePaths)}`,
  )

  const hooks: Hooks = {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        const command = output.args?.command
        if (typeof command !== "string" || !command) return

        if (originalCommands.has(input.callID)) {
          logger.warn(
            `[bash] callID=${input.callID} already wrapped — skipping duplicate hook call`,
          )
          return
        }

        if (isAlreadyWrapped(command)) {
          logger.warn(
            `[bash] callID=${input.callID} command already contains sandbox wrapper — skipping`,
          )
          return
        }

        originalCommands.set(input.callID, command)
        logger.debug(`[bash] callID=${input.callID} command="${command.slice(0, 200)}"`)

        try {
          if (process.platform === "win32") {
            const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command, "powershell")
            sandboxEnvs.set(input.callID, env)
            output.args.command = `& ${argv.map(psQuote).join(" ")}`
            wrappedCommands.set(input.callID, output.args.command)
            logger.debug(
              `[bash] callID=${input.callID} wrapped (Windows): ${output.args.command.slice(0, 300)}`,
            )
          } else {
            output.args.command = await SandboxManager.wrapWithSandbox(command)
            wrappedCommands.set(input.callID, output.args.command)
            logger.debug(`[bash] callID=${input.callID} wrapped successfully`)
          }
          ;(output as any).title = command
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
          const denied = isPathDeniedForWrite(filePath, allowWritePaths, denyWritePaths)
          if (denied) {
            const inAllowList = allowWritePaths.some((a) => isUnder(filePath, a))
            if (!inAllowList) {
              logger.warn(
                `[${input.tool}] WRITE DENIED path="${filePath}" reason="not in allowOnly" allowOnly=${JSON.stringify(allowWritePaths)}`,
              )
            } else {
              const matchedDeny = denyWritePaths.find((d) => isUnder(filePath, d))
              logger.warn(
                `[${input.tool}] WRITE DENIED path="${filePath}" reason="matched denyWithinAllow" matchedRule="${matchedDeny}"`,
              )
            }
            throw new Error(`${TAG} Write denied by sandbox policy: ${filePath}`)
          }
          const matchedAllow = allowWritePaths.find((a) => isUnder(filePath, a))
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
        const wrapped = wrappedCommands.get(input.callID)
        originalCommands.delete(input.callID)
        wrappedCommands.delete(input.callID)
        if (input.args && typeof input.args.command === "string") {
          input.args.command = originalCommand
        }
        if (typeof output.title === "string") {
          output.title = originalCommand
        }
        if (typeof output.output === "string" && wrapped) {
          output.output = cleanOutput(output.output, wrapped, originalCommand)
        }
        logger.debug(`[bash] callID=${input.callID} restored original command in after-hook`)
      } else {
        if (typeof output.title === "string" && isAlreadyWrapped(output.title)) {
          output.title = input.args?.command ?? output.title
        }
        if (typeof output.output === "string" && isAlreadyWrapped(output.output)) {
          output.output = output.output
            .split("\n")
            .filter((line) => !SRT_SIGNATURES.some((sig) => line.toLowerCase().includes(sig)))
            .join("\n")
        }
      }
    },
  }

  return hooks
}

export { SandboxPlugin }
export default SandboxPlugin

export function _resetPluginInstance(): void {
  disabled = null
  sandboxReady = false
  initLock = null
  allowWritePaths.length = 0
  denyWritePaths.length = 0
  fsReadConfig.denyOnly = []
  fsReadConfig.allowWithinDeny = []
  seenWritePaths.clear()
  seenProjects.clear()
  originalCommands.clear()
  wrappedCommands.clear()
  sandboxEnvs.clear()
}
