import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  getConfigDir,
  loadConfig,
  loadSrtSettings,
  resolveConfig,
  type SrtSettings,
} from "../src/config"

const PROJECT_DIR = `/tmp/test-project-sandbox-${process.pid}`
const CONFIG_DIR = `/tmp/test-sandbox-config-${process.pid}`
const WORKTREE = PROJECT_DIR

describe("resolveConfig", () => {
  test("returns sensible defaults when no user config", () => {
    const config = resolveConfig(PROJECT_DIR, WORKTREE)

    // Filesystem
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".ssh"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".gnupg"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".aws/credentials"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".azure"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".config/gcloud"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".config/gh"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".kube"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".docker/config.json"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".npmrc"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".netrc"))
    expect(config.filesystem?.denyRead).toContain(path.join(os.homedir(), ".env"))
    expect(config.filesystem?.allowRead).toEqual([])
    expect(config.filesystem?.allowWrite).toContain(PROJECT_DIR)
    expect(config.filesystem?.allowWrite).toContain(os.tmpdir())
    expect(config.filesystem?.denyWrite).toEqual([])

    // Network
    expect(config.network?.allowedDomains).toContain("registry.npmjs.org")
    expect(config.network?.allowedDomains).toContain("github.com")
    expect(config.network?.allowedDomains).toContain("api.openai.com")
    expect(config.network?.allowedDomains).toContain("api.anthropic.com")
    expect(config.network?.allowLocalBinding).toBe(false)
    expect(config.network?.deniedDomains).toEqual([])
  })

  test("user filesystem config overrides defaults", () => {
    const user: SrtSettings = {
      filesystem: {
        denyRead: ["/custom/secret"],
        allowRead: ["/custom/secret.pub"],
        allowWrite: ["/custom/output"],
        denyWrite: ["/custom/no-write"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    expect(config.filesystem?.denyRead).toEqual(["/custom/secret"])
    expect(config.filesystem?.allowRead).toEqual(["/custom/secret.pub"])
    expect(config.filesystem?.allowWrite).toEqual(["/custom/output"])
    expect(config.filesystem?.denyWrite).toEqual(["/custom/no-write"])
  })

  test("user network config overrides defaults", () => {
    const user: SrtSettings = {
      network: {
        allowedDomains: ["my-api.internal.com"],
        deniedDomains: ["evil.com"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    expect(config.network?.allowedDomains).toEqual(["my-api.internal.com"])
    expect(config.network?.deniedDomains).toEqual(["evil.com"])
  })

  test("partial user config keeps other defaults", () => {
    const user: SrtSettings = {
      filesystem: {
        denyRead: ["/only-this"],
        allowRead: ["/except-this"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    // overridden
    expect(config.filesystem?.denyRead).toEqual(["/only-this"])
    expect(config.filesystem?.allowRead).toEqual(["/except-this"])
    // defaults kept
    expect(config.filesystem?.allowWrite).toContain(PROJECT_DIR)
    expect(config.network?.allowedDomains).toContain("github.com")
  })

  test("includes both projectDir and worktree in allowWrite", () => {
    const config = resolveConfig("/project", "/worktree")
    expect(config.filesystem?.allowWrite).toContain("/project")
    expect(config.filesystem?.allowWrite).toContain("/worktree")
  })

  test("rejects root path '/' as worktree to prevent sandbox bypass", () => {
    const config = resolveConfig("/project", "/")
    expect(config.filesystem?.allowWrite).toContain("/project")
    expect(config.filesystem?.allowWrite).not.toContain("/")
  })

  test("rejects unsafe broad paths from allowWrite", () => {
    const config = resolveConfig("/home", "/usr")
    expect(config.filesystem?.allowWrite).not.toContain("/home")
    expect(config.filesystem?.allowWrite).not.toContain("/usr")
  })

  test("deduplicates identical projectDir and worktree", () => {
    const config = resolveConfig("/project", "/project")
    const writeList = config.filesystem?.allowWrite ?? []
    const projectCount = writeList.filter((p) => p === "/project").length
    expect(projectCount).toBe(1)
  })

  test("handles unix socket config", () => {
    const user: SrtSettings = {
      network: {
        allowUnixSockets: ["/var/run/docker.sock"],
        allowAllUnixSockets: false,
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user)

    expect(config.network?.allowUnixSockets).toEqual(["/var/run/docker.sock"])
    expect(config.network?.allowAllUnixSockets).toBe(false)
  })
})

describe("getConfigDir", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config"
    expect(getConfigDir()).toBe(path.join("/custom/config", "opencode-sandbox"))
    delete process.env.XDG_CONFIG_HOME
  })

  test("falls back to ~/.config when XDG_CONFIG_HOME is not set", () => {
    delete process.env.XDG_CONFIG_HOME
    expect(getConfigDir()).toBe(path.join(os.homedir(), ".config", "opencode-sandbox"))
  })
})

describe("loadConfig", () => {
  const sandboxConfigDir = path.join(CONFIG_DIR, "opencode-sandbox")
  const projectName = path.basename(PROJECT_DIR)

  beforeEach(async () => {
    delete process.env.OPENCODE_SANDBOX_CONFIG
    process.env.XDG_CONFIG_HOME = CONFIG_DIR
    await fs.rm(CONFIG_DIR, { recursive: true, force: true })
    await fs.mkdir(path.join(sandboxConfigDir, "projects"), { recursive: true })
  })

  afterAll(async () => {
    delete process.env.XDG_CONFIG_HOME
    await fs.rm(CONFIG_DIR, { recursive: true, force: true })
  })

  test("returns empty config when no file and no env var", async () => {
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })

  test("loads config from OPENCODE_SANDBOX_CONFIG env var", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      disabled: false,
      filesystem: { denyRead: ["/secret"], allowRead: ["/secret.pub"] },
    })
    const config = await loadConfig(PROJECT_DIR)
    expect(config.disabled).toBe(false)
    expect(config.filesystem?.denyRead).toEqual(["/secret"])
    expect(config.filesystem?.allowRead).toEqual(["/secret.pub"])
  })

  test("loads per-project config", async () => {
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ network: { allowedDomains: ["example.com"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.network?.allowedDomains).toEqual(["example.com"])
  })

  test("loads global config", async () => {
    await fs.writeFile(
      path.join(sandboxConfigDir, "config.json"),
      JSON.stringify({ filesystem: { denyRead: ["/global-secret"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/global-secret"])
  })

  test("env var takes priority over per-project config", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: { denyRead: ["/from-env"] },
    })
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-env"])
  })

  test("per-project config takes priority over global config", async () => {
    await fs.writeFile(
      path.join(sandboxConfigDir, "projects", `${projectName}.json`),
      JSON.stringify({ filesystem: { denyRead: ["/from-project"] } }),
    )
    await fs.writeFile(
      path.join(sandboxConfigDir, "config.json"),
      JSON.stringify({ filesystem: { denyRead: ["/from-global"] } }),
    )
    const config = await loadConfig(PROJECT_DIR)
    expect(config.filesystem?.denyRead).toEqual(["/from-project"])
  })

  test("handles invalid JSON in env var gracefully", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "not-valid-json"
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })

  test("handles invalid JSON in file gracefully", async () => {
    await fs.writeFile(path.join(sandboxConfigDir, "config.json"), "broken{json")
    const config = await loadConfig(PROJECT_DIR)
    expect(config).toEqual({})
  })
})

describe("loadSrtSettings", () => {
  const srtPath = path.join(os.homedir(), ".srt-settings.json")
  let originalExists = false

  beforeEach(async () => {
    try {
      await fs.access(srtPath)
      originalExists = true
    } catch {
      originalExists = false
    }
    if (originalExists) {
      await fs.rename(srtPath, `${srtPath}.bak`)
    }
  })

  afterEach(async () => {
    try {
      await fs.rm(srtPath, { force: true })
    } catch {}
    if (originalExists) {
      await fs.rename(`${srtPath}.bak`, srtPath)
    }
  })

  test("returns null when ~/.srt-settings.json does not exist", async () => {
    const result = await loadSrtSettings()
    expect(result).toBeNull()
  })

  test("loads network and filesystem settings", async () => {
    const settings: SrtSettings = {
      network: {
        allowedDomains: ["example.com"],
        deniedDomains: ["evil.com"],
        allowUnixSockets: ["/var/run/docker.sock"],
        allowLocalBinding: true,
      },
      filesystem: {
        denyRead: ["~/.ssh", "/etc/passwd"],
        allowWrite: ["/tmp/project"],
        denyWrite: [".env"],
      },
    }
    await fs.writeFile(srtPath, JSON.stringify(settings))

    const result = await loadSrtSettings()
    expect(result?.network?.allowedDomains).toEqual(["example.com"])
    expect(result?.network?.deniedDomains).toEqual(["evil.com"])
    expect(result?.network?.allowUnixSockets).toEqual(["/var/run/docker.sock"])
    expect(result?.filesystem?.allowWrite).toEqual(["/tmp/project"])
    expect(result?.filesystem?.denyWrite).toEqual([".env"])
  })

  test("expands ~ in filesystem paths", async () => {
    await fs.writeFile(
      srtPath,
      JSON.stringify({
        filesystem: {
          denyRead: ["~/.ssh", "~/.aws/credentials"],
          allowWrite: ["~/projects"],
        },
      }),
    )

    const result = await loadSrtSettings()
    expect(result?.filesystem?.denyRead).toEqual([
      path.join(os.homedir(), ".ssh"),
      path.join(os.homedir(), ".aws/credentials"),
    ])
    expect(result?.filesystem?.allowWrite).toEqual([path.join(os.homedir(), "projects")])
  })

  test("loads ignoreViolations and extra flags", async () => {
    await fs.writeFile(
      srtPath,
      JSON.stringify({
        ignoreViolations: { "*": ["/usr/bin"], "git push": ["/usr/bin/nc"] },
        enableWeakerNestedSandbox: true,
        enableWeakerNetworkIsolation: false,
      }),
    )

    const result = await loadSrtSettings()
    expect(result?.ignoreViolations).toEqual({ "*": ["/usr/bin"], "git push": ["/usr/bin/nc"] })
    expect(result?.enableWeakerNestedSandbox).toBe(true)
    expect(result?.enableWeakerNetworkIsolation).toBe(false)
  })

  test("handles invalid JSON gracefully", async () => {
    await fs.writeFile(srtPath, "not valid json{")
    const result = await loadSrtSettings()
    expect(result).toBeNull()
  })
})

describe("resolveConfig with SRT settings", () => {
  test("srt settings used when no user config", () => {
    const srt: SrtSettings = {
      filesystem: { denyRead: ["/srt/secret"], allowWrite: ["/srt/output"], denyWrite: [] },
      network: { allowedDomains: ["srt-domain.com"], deniedDomains: [] },
      ignoreViolations: { "*": ["/usr/bin"] },
      enableWeakerNestedSandbox: true,
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, undefined, srt)

    expect(config.filesystem?.denyRead).toEqual(["/srt/secret"])
    expect(config.filesystem?.allowWrite).toEqual(["/srt/output"])
    expect(config.network?.allowedDomains).toEqual(["srt-domain.com"])
    expect(config.ignoreViolations).toEqual({ "*": ["/usr/bin"] })
    expect(config.enableWeakerNestedSandbox).toBe(true)
  })

  test("user config takes priority over srt settings", () => {
    const user: SrtSettings = {
      filesystem: { denyRead: ["/user/secret"] },
      network: { allowedDomains: ["user-domain.com"] },
    }
    const srt: SrtSettings = {
      filesystem: { denyRead: ["/srt/secret"] },
      network: { allowedDomains: ["srt-domain.com"] },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user, srt)

    expect(config.filesystem?.denyRead).toEqual(["/user/secret"])
    expect(config.network?.allowedDomains).toEqual(["user-domain.com"])
  })

  test("user ignoreViolations takes priority over srt, flags merge with user first", () => {
    const user: SrtSettings = {
      filesystem: { denyRead: ["/user/secret"] },
      ignoreViolations: { npm: ["/user/tmp"] },
      enableWeakerNetworkIsolation: false,
    }
    const srt: SrtSettings = {
      ignoreViolations: { npm: ["/private/tmp"] },
      enableWeakerNetworkIsolation: true,
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, user, srt)

    expect(config.ignoreViolations).toEqual({ npm: ["/user/tmp"] })
    expect(config.enableWeakerNetworkIsolation).toBe(false)
  })

  test("srt ignoreViolations and flags used when no user config", () => {
    const srt: SrtSettings = {
      ignoreViolations: { npm: ["/private/tmp"] },
      enableWeakerNetworkIsolation: true,
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, undefined, srt)

    expect(config.ignoreViolations).toEqual({ npm: ["/private/tmp"] })
    expect(config.enableWeakerNetworkIsolation).toBe(true)
  })
})
