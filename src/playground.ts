import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { ensureDefaultConfig, loadConfig, resolveConfig } from "./config"

const directory = process.cwd()
const worktree = directory

async function main() {
  const command = process.argv[2]
  if (!command) {
    console.error("Usage: bun run src/playground.ts <command>")
    console.error(
      'Example: bun run src/playground.ts "curl https://registry.npmjs.org/left-pad/latest"',
    )
    process.exit(1)
  }

  const createdConfig = await ensureDefaultConfig()
  const config = await loadConfig()
  const runtimeConfig = resolveConfig(directory, worktree, config)

  console.log("Initializing SandboxManager...")
  console.log(`  allowedDomains: ${JSON.stringify(runtimeConfig.network?.allowedDomains)}`)
  console.log(`  allowWrite: ${JSON.stringify(runtimeConfig.filesystem?.allowWrite)}`)
  await SandboxManager.initialize(runtimeConfig)
  console.log("SandboxManager ready.\n")

  if (process.platform === "win32") {
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command, "powershell")

    console.log("Spawning (Windows):")
    console.log(`  argv: ${JSON.stringify(argv)}`)
    console.log("")

    const proc = Bun.spawn(argv, {
      env,
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await proc.exited
    process.exit(exitCode)
  } else {
    const wrapped = await SandboxManager.wrapWithSandbox(command)

    console.log("Spawning (Unix):")
    console.log(`  command: ${wrapped.slice(0, 300)}...`)
    console.log("")

    const proc = Bun.spawn(["bash", "-c", wrapped], {
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await proc.exited
    process.exit(exitCode)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
