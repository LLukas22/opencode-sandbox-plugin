set windows-shell := ["powershell", "-NoProfile", "-Command"]

plugins_dir := join(env("USERPROFILE"), ".config", "opencode", "plugins")
log_file := join(env("USERPROFILE"), ".local", "share", "opencode", "log", "sandbox-plugin.log")
config_pkg := join(env("USERPROFILE"), ".config", "opencode", "package.json")

# Build and install plugin locally for testing
install: build-local
    @if (!(Test-Path "{{plugins_dir}}")) { New-Item -ItemType Directory -Path "{{plugins_dir}}" -Force | Out-Null }
    Copy-Item -Path "dist\local.js" -Destination "{{plugins_dir}}\sandbox-plugin.js" -Force
    @$pkg = '{{config_pkg}}'; $json = Get-Content $pkg -Raw | ConvertFrom-Json; if (-not $json.dependencies.'@anthropic-ai/sandbox-runtime') { $json.dependencies | Add-Member -NotePropertyName '@anthropic-ai/sandbox-runtime' -NotePropertyValue 'github:LLukas22/sandbox-runtime#elevation' -Force; $json | ConvertTo-Json -Depth 10 | Set-Content $pkg -Encoding UTF8; Write-Host 'Added @anthropic-ai/sandbox-runtime to config package.json' }
    @Write-Host "Installed sandbox-plugin.js to {{plugins_dir}}"

# Build for npm (both named + default export)
build:
    bun build ./src/index.ts --outdir dist --target node --format esm --external @opencode-ai/plugin; if ($?) { bun x tsc --emitDeclarationOnly --declaration --outDir dist }

# Build for local plugin loading (default export only)
build-local:
    bun build ./src/local.ts --outdir dist --target node --format esm --external @opencode-ai/plugin

# Remove the locally installed plugin
uninstall:
    @if (Test-Path "{{plugins_dir}}\sandbox-plugin.js") { Remove-Item "{{plugins_dir}}\sandbox-plugin.js" -Force; Write-Host "Removed sandbox-plugin.js" } else { Write-Host "Not installed" }

# Tail the sandbox plugin log file
logs:
    @if (Test-Path "{{log_file}}") { Get-Content "{{log_file}}" -Tail 50 -Wait } else { Write-Host "No log file yet at {{log_file}}" }

# Show the last N lines of the log (default 100)
log lines="100":
    @if (Test-Path "{{log_file}}") { Get-Content "{{log_file}}" -Tail {{lines}} } else { Write-Host "No log file yet" }

# Clear the log file
log-clear:
    @if (Test-Path "{{log_file}}") { Remove-Item "{{log_file}}" -Force; Write-Host "Log cleared" } else { Write-Host "No log file" }

# Run a command inside the sandbox directly (bypasses plugin hooks)
playground cmd:
    bun run src/playground.ts "{{cmd}}"

# Run tests
test:
    bun test

# Typecheck and lint
check:
    bun run typecheck
    bun run lint
