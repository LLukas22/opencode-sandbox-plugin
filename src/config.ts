import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { logger } from "./logger"

export interface SrtSettings {
  disabled?: boolean
  network?: {
    allowedDomains?: string[]
    deniedDomains?: string[]
    allowUnixSockets?: string[]
    allowAllUnixSockets?: boolean
    allowLocalBinding?: boolean
  }
  filesystem?: {
    denyRead?: string[]
    allowRead?: string[]
    allowWrite?: string[]
    denyWrite?: string[]
  }
  windows?: {
    groupName?: string
    groupSid?: string
    wfpSublayerGuid?: string
    proxyPortRange?: [number, number]
  }
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  enableWeakerNetworkIsolation?: boolean
  allowAppleEvents?: boolean
}

function getDefaultDenyReadPaths(homeDir: string): string[] {
  const common = [
    ".ssh",
    ".aws/credentials",
    ".azure",
    ".kube",
    ".docker/config.json",
    ".npmrc",
    ".netrc",
    ".env",
  ].map((p) => path.join(homeDir, p))

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(homeDir, "AppData", "Roaming")
    return [
      ...common,
      path.join(homeDir, ".gnupg"),
      path.join(appData, "gnupg"),
      path.join(appData, "gcloud"),
      path.join(appData, "GitHub CLI"),
    ]
  }

  return [
    ...common,
    path.join(homeDir, ".gnupg"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".config", "gh"),
  ]
}

const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "crates.io",
  "*.crates.io",
  "github.com",
  "*.github.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "*.googleapis.com",
]

const UNSAFE_WRITE_PATHS = new Set([
  "/",
  "/home",
  "/usr",
  "/etc",
  "/var",
  "/opt",
  "/library",
  "/system",
  "/private",
  "/volumes",
  "/users",
  "/windows",
  "/program files",
  "/program files (x86)",
  "/programdata",
])

function isSafeWritePath(p: string): boolean {
  const resolved = path.resolve(p)
  const isDriveRoot = /^[A-Za-z]:\\?$/.test(resolved)
  const unixLike = resolved
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:/, "")
    .toLowerCase()
  if (UNSAFE_WRITE_PATHS.has(unixLike) || isDriveRoot) {
    logger.warn(`Rejecting unsafe write path: ${resolved}`)
    return false
  }
  return true
}

export function getConfigPath(): string {
  return path.join(os.homedir(), ".srt-settings.json")
}

export function resolveConfig(
  projectDir: string,
  worktree: string,
  config?: SrtSettings,
): SandboxRuntimeConfig {
  const candidatePaths = [projectDir, worktree, os.tmpdir()].filter(Boolean)
  const safePaths = candidatePaths.filter((p) => isSafeWritePath(p))
  const seen = new Set<string>()
  const defaultWritePaths = safePaths.filter((p) => {
    // Normalise to a canonical lowercase forward-slash key for deduplication.
    // Do NOT strip the drive letter: paths on different Windows drives that
    // share the same relative structure (e.g. C:\repos\proj vs E:\repos\proj)
    // must be treated as distinct entries, not collapsed into one.
    const key = path.resolve(p).replace(/\\/g, "/").toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const configuredWrite = config?.filesystem?.allowWrite
  const writePaths =
    configuredWrite && configuredWrite.length > 0 ? configuredWrite : defaultWritePaths

  return {
    filesystem: {
      denyRead: config?.filesystem?.denyRead ?? [],
      allowRead: config?.filesystem?.allowRead ?? [],
      allowWrite: writePaths,
      denyWrite: config?.filesystem?.denyWrite ?? [],
    },
    network: {
      allowedDomains: config?.network?.allowedDomains ?? [],
      deniedDomains: config?.network?.deniedDomains ?? [],
      allowUnixSockets: config?.network?.allowUnixSockets,
      allowAllUnixSockets: config?.network?.allowAllUnixSockets,
      allowLocalBinding: config?.network?.allowLocalBinding ?? false,
    },
    windows:
      process.platform === "win32"
        ? {
            groupName: config?.windows?.groupName ?? "sandbox-runtime-net",
            groupSid: config?.windows?.groupSid,
            wfpSublayerGuid: config?.windows?.wfpSublayerGuid,
            proxyPortRange: config?.windows?.proxyPortRange,
          }
        : undefined,
    ignoreViolations: config?.ignoreViolations,
    enableWeakerNestedSandbox: config?.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: config?.enableWeakerNetworkIsolation,
    // macOS only — silently ignored on other platforms by the runtime.
    allowAppleEvents: config?.allowAppleEvents,
  }
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir()
  // Slice off "~/" or "~\" (2 chars) so path.join receives a plain relative
  // segment instead of a leading separator, which could be mis-interpreted as
  // a UNC prefix ("\\") or a drive-root ("/") on Windows.
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

function expandTildePaths(paths: string[] | undefined): string[] | undefined {
  return paths?.map(expandTilde)
}

function expandSettings(raw: SrtSettings): SrtSettings {
  return {
    ...raw,
    filesystem: raw.filesystem
      ? {
          ...raw.filesystem,
          denyRead: expandTildePaths(raw.filesystem.denyRead),
          allowRead: expandTildePaths(raw.filesystem.allowRead),
          allowWrite: expandTildePaths(raw.filesystem.allowWrite),
          denyWrite: expandTildePaths(raw.filesystem.denyWrite),
        }
      : undefined,
  }
}

function toTildePath(filePath: string, homeDir: string): string {
  if (filePath === homeDir) return "~"
  if (filePath.startsWith(homeDir + path.sep)) {
    return `~/${filePath.slice(homeDir.length + 1).replace(/\\/g, "/")}`
  }
  return filePath
}

export async function ensureDefaultConfig(): Promise<string | null> {
  const configPath = getConfigPath()

  try {
    await fs.access(configPath)
    return null
  } catch {
    // does not exist — create it
  }

  const homeDir = os.homedir()
  const defaultConfig: SrtSettings = {
    network: {
      allowedDomains: DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: getDefaultDenyReadPaths(homeDir).map((p) => toTildePath(p, homeDir)),
      allowRead: [],
      denyWrite: [],
    },
  }

  await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8")
  return configPath
}

export async function loadConfig(): Promise<SrtSettings> {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG
  if (envConfig) {
    try {
      const parsed = expandSettings(JSON.parse(envConfig) as SrtSettings)
      logger.info("Config loaded from OPENCODE_SANDBOX_CONFIG env var")
      logger.debug(`Config contents: ${JSON.stringify(parsed)}`)
      return parsed
    } catch {
      logger.warn("Invalid JSON in OPENCODE_SANDBOX_CONFIG env var, falling back to file")
    }
  }

  const configPath = getConfigPath()
  logger.info(`Loading config from file: ${configPath}`)
  try {
    const content = await fs.readFile(configPath, "utf-8")
    const parsed = expandSettings(JSON.parse(content) as SrtSettings)
    logger.debug(`Config contents: ${JSON.stringify(parsed)}`)
    return parsed
  } catch (err) {
    logger.warn(
      `Failed to read config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
}
