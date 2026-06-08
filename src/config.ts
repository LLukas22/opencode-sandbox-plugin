import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

/**
 * Configuration for the opencode sandbox plugin. Uses the same format as the
 * native SRT settings file (~/.srt-settings.json) with an additional `disabled`
 * flag. All opencode config files (project, global, env var) use this shape.
 */
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
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  enableWeakerNetworkIsolation?: boolean
  allowAppleEvents?: boolean
}

const DEFAULT_DENY_READ_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws/credentials",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".env",
]

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
  "/Library",
  "/System",
  "/private",
  "/Volumes",
  "/Users",
])

function isSafeWritePath(p: string): boolean {
  const normalized = path.resolve(p)
  if (UNSAFE_WRITE_PATHS.has(normalized)) {
    console.warn(`[opencode-sandbox] Rejecting unsafe write path: ${normalized}`)
    return false
  }
  return true
}

export function resolveConfig(
  projectDir: string,
  worktree: string,
  user?: SrtSettings,
  srt?: SrtSettings,
): SandboxRuntimeConfig {
  const homeDir = os.homedir()

  const candidatePaths = [projectDir, worktree, os.tmpdir()].filter(Boolean)
  const safePaths = candidatePaths.filter((p) => isSafeWritePath(p))
  const seen = new Set<string>()
  const defaultWritePaths = safePaths.filter((p) => {
    const resolved = path.resolve(p)
    if (seen.has(resolved)) return false
    seen.add(resolved)
    return true
  })

  // Priority: user (opencode config) > srt (~/.srt-settings.json) > defaults
  const writePaths =
    user?.filesystem?.allowWrite ?? srt?.filesystem?.allowWrite ?? defaultWritePaths

  return {
    filesystem: {
      denyRead:
        user?.filesystem?.denyRead ??
        srt?.filesystem?.denyRead ??
        DEFAULT_DENY_READ_DIRS.map((p) => path.join(homeDir, p)),
      allowRead: user?.filesystem?.allowRead ?? srt?.filesystem?.allowRead ?? [],
      allowWrite: writePaths,
      denyWrite: user?.filesystem?.denyWrite ?? srt?.filesystem?.denyWrite ?? [],
    },
    network: {
      allowedDomains:
        user?.network?.allowedDomains ?? srt?.network?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: user?.network?.deniedDomains ?? srt?.network?.deniedDomains ?? [],
      allowUnixSockets: user?.network?.allowUnixSockets ?? srt?.network?.allowUnixSockets,
      allowAllUnixSockets: user?.network?.allowAllUnixSockets ?? srt?.network?.allowAllUnixSockets,
      allowLocalBinding:
        user?.network?.allowLocalBinding ?? srt?.network?.allowLocalBinding ?? false,
    },
    ignoreViolations: user?.ignoreViolations ?? srt?.ignoreViolations,
    enableWeakerNestedSandbox: user?.enableWeakerNestedSandbox ?? srt?.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation:
      user?.enableWeakerNetworkIsolation ?? srt?.enableWeakerNetworkIsolation,
  }
}

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdgConfig, "opencode-sandbox")
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

function expandTildePaths(paths: string[] | undefined): string[] | undefined {
  return paths?.map(expandTilde)
}

async function tryLoadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    return JSON.parse(content) as T
  } catch {
    return null
  }
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

export async function loadSrtSettings(): Promise<SrtSettings | null> {
  const srtPath = path.join(os.homedir(), ".srt-settings.json")
  const raw = await tryLoadJsonFile<SrtSettings>(srtPath)
  if (!raw) return null
  return expandSettings(raw)
}

export async function loadConfig(projectDir: string): Promise<SrtSettings> {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG
  if (envConfig) {
    try {
      return expandSettings(JSON.parse(envConfig) as SrtSettings)
    } catch {
      console.warn("[opencode-sandbox] Invalid JSON in OPENCODE_SANDBOX_CONFIG, using defaults")
    }
  }

  const configDir = getConfigDir()

  const projectName = path.basename(projectDir)
  const projectConfig = await tryLoadJsonFile<SrtSettings>(
    path.join(configDir, "projects", `${projectName}.json`),
  )
  if (projectConfig) return expandSettings(projectConfig)

  const globalConfig = await tryLoadJsonFile<SrtSettings>(path.join(configDir, "config.json"))
  if (globalConfig) return expandSettings(globalConfig)

  return {}
}
