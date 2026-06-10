import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ensureDefaultConfig,
  getConfigPath,
  loadConfig,
  resolveConfig,
  type SrtSettings,
} from "../src/config"

const PROJECT_DIR = path.join(os.tmpdir(), `test-project-sandbox-${process.pid}`)
const WORKTREE = PROJECT_DIR

describe("resolveConfig", () => {
  test("returns dynamic allowWrite defaults when no config", () => {
    const config = resolveConfig(PROJECT_DIR, WORKTREE)

    expect(config.filesystem?.denyRead).toEqual([])
    expect(config.filesystem?.allowRead).toEqual([])
    expect(config.filesystem?.allowWrite).toContain(PROJECT_DIR)
    expect(config.filesystem?.allowWrite).toContain(os.tmpdir())
    expect(config.filesystem?.denyWrite).toEqual([])

    expect(config.network?.allowedDomains).toEqual([])
    expect(config.network?.deniedDomains).toEqual([])
    expect(config.network?.allowLocalBinding).toBe(false)
  })

  test("config overrides defaults", () => {
    const cfg: SrtSettings = {
      filesystem: {
        denyRead: ["/custom/secret"],
        allowRead: ["/custom/secret.pub"],
        allowWrite: ["/custom/output"],
        denyWrite: ["/custom/no-write"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, cfg)

    expect(config.filesystem?.denyRead).toEqual(["/custom/secret"])
    expect(config.filesystem?.allowRead).toEqual(["/custom/secret.pub"])
    expect(config.filesystem?.allowWrite).toEqual(["/custom/output"])
    expect(config.filesystem?.denyWrite).toEqual(["/custom/no-write"])
  })

  test("network config overrides defaults", () => {
    const cfg: SrtSettings = {
      network: {
        allowedDomains: ["my-api.internal.com"],
        deniedDomains: ["evil.com"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, cfg)

    expect(config.network?.allowedDomains).toEqual(["my-api.internal.com"])
    expect(config.network?.deniedDomains).toEqual(["evil.com"])
  })

  test("partial config only overrides specified fields", () => {
    const cfg: SrtSettings = {
      filesystem: {
        denyRead: ["/only-this"],
        allowRead: ["/except-this"],
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, cfg)

    expect(config.filesystem?.denyRead).toEqual(["/only-this"])
    expect(config.filesystem?.allowRead).toEqual(["/except-this"])
    expect(config.filesystem?.allowWrite).toContain(PROJECT_DIR)
    expect(config.network?.allowedDomains).toEqual([])
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
    const cfg: SrtSettings = {
      network: {
        allowUnixSockets: ["/var/run/docker.sock"],
        allowAllUnixSockets: false,
      },
    }
    const config = resolveConfig(PROJECT_DIR, WORKTREE, cfg)

    expect(config.network?.allowUnixSockets).toEqual(["/var/run/docker.sock"])
    expect(config.network?.allowAllUnixSockets).toBe(false)
  })
})

describe("loadConfig", () => {
  const srtPath = getConfigPath()
  let originalExists = false

  beforeEach(async () => {
    delete process.env.OPENCODE_SANDBOX_CONFIG
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
    delete process.env.OPENCODE_SANDBOX_CONFIG
    try {
      await fs.rm(srtPath, { force: true })
    } catch {}
    if (originalExists) {
      await fs.rename(`${srtPath}.bak`, srtPath)
    }
  })

  test("returns empty config when no file and no env var", async () => {
    const config = await loadConfig()
    expect(config).toEqual({})
  })

  test("loads config from OPENCODE_SANDBOX_CONFIG env var", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      disabled: false,
      filesystem: { denyRead: ["/secret"], allowRead: ["/secret.pub"] },
    })
    const config = await loadConfig()
    expect(config.disabled).toBe(false)
    expect(config.filesystem?.denyRead).toEqual(["/secret"])
    expect(config.filesystem?.allowRead).toEqual(["/secret.pub"])
  })

  test("loads config from ~/.srt-settings.json", async () => {
    await fs.writeFile(srtPath, JSON.stringify({ filesystem: { denyRead: ["/secret"] } }))
    const config = await loadConfig()
    expect(config.filesystem?.denyRead).toEqual(["/secret"])
  })

  test("env var takes priority over config file", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
      filesystem: { denyRead: ["/from-env"] },
    })
    await fs.writeFile(srtPath, JSON.stringify({ filesystem: { denyRead: ["/from-file"] } }))
    const config = await loadConfig()
    expect(config.filesystem?.denyRead).toEqual(["/from-env"])
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

    const config = await loadConfig()
    expect(config.filesystem?.denyRead).toEqual([
      path.join(os.homedir(), ".ssh"),
      path.join(os.homedir(), ".aws/credentials"),
    ])
    expect(config.filesystem?.allowWrite).toEqual([path.join(os.homedir(), "projects")])
  })

  test("handles invalid JSON in env var gracefully", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "not-valid-json"
    const config = await loadConfig()
    expect(config).toEqual({})
  })

  test("handles invalid JSON in file gracefully", async () => {
    await fs.writeFile(srtPath, "broken{json")
    const config = await loadConfig()
    expect(config).toEqual({})
  })
})

describe("ensureDefaultConfig", () => {
  const srtPath = getConfigPath()
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

  test("creates config file with defaults when it does not exist", async () => {
    const result = await ensureDefaultConfig()
    expect(result).toBe(srtPath)

    const content = JSON.parse(await fs.readFile(srtPath, "utf-8")) as SrtSettings

    expect(content.network?.allowedDomains).toContain("registry.npmjs.org")
    expect(content.network?.allowedDomains).toContain("github.com")
    expect(content.network?.deniedDomains).toEqual([])
    expect(content.network?.allowLocalBinding).toBe(false)
    expect(content.filesystem?.denyRead).toContain("~/.ssh")
    expect(content.filesystem?.denyRead).toContain("~/.npmrc")
    expect(content.filesystem?.allowRead).toEqual([])
    expect(content.filesystem?.denyWrite).toEqual([])
    expect(content.filesystem?.allowWrite).toBeUndefined()
  })

  test("returns null and does not overwrite when config already exists", async () => {
    await fs.writeFile(srtPath, JSON.stringify({ disabled: true }), "utf-8")

    const result = await ensureDefaultConfig()
    expect(result).toBeNull()

    const content = JSON.parse(await fs.readFile(srtPath, "utf-8")) as SrtSettings
    expect(content.disabled).toBe(true)
  })

  test("created config is loadable by loadConfig", async () => {
    await ensureDefaultConfig()
    const config = await loadConfig()
    expect(config.network?.allowedDomains).toContain("registry.npmjs.org")
    expect(config.filesystem?.denyRead).toBeDefined()
  })

  test("full stack: ensureDefaultConfig + loadConfig + resolveConfig", async () => {
    await ensureDefaultConfig()
    const config = await loadConfig()
    const resolved = resolveConfig(PROJECT_DIR, WORKTREE, config)

    expect(resolved.filesystem?.denyRead).toContain(path.join(os.homedir(), ".ssh"))
    expect(resolved.network?.allowedDomains).toContain("registry.npmjs.org")
    expect(resolved.filesystem?.allowWrite).toContain(PROJECT_DIR)
  })
})
