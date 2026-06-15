set windows-shell := ["powershell", "-NoProfile", "-Command"]

home := if os() == "windows" { env("USERPROFILE") } else { env("HOME") }
plugins_dir := join(home, ".config", "opencode", "plugins")
log_file := join(home, ".local", "share", "opencode", "log", "sandbox-plugin.log")
config_pkg := join(home, ".config", "opencode", "package.json")

# Build and install plugin locally for testing
[windows]
install: build
    @if (!(Test-Path "{{plugins_dir}}")) { New-Item -ItemType Directory -Path "{{plugins_dir}}" -Force | Out-Null }
    Copy-Item -Path "dist\index.js" -Destination "{{plugins_dir}}\sandbox-plugin.js" -Force
    @Write-Host "Installed sandbox-plugin.js to {{plugins_dir}}"

[unix]
install: build
    mkdir -p "{{plugins_dir}}"
    cp dist/index.js "{{plugins_dir}}/sandbox-plugin.js"
    @echo "Installed sandbox-plugin.js to {{plugins_dir}}"

# Build (bundles sandbox-runtime inline, only @opencode-ai/plugin is external)
[windows]
build:
    bun build ./src/index.ts --outdir dist --target node --format esm --external @opencode-ai/plugin; if ($?) { bun x tsc --emitDeclarationOnly --declaration --outDir dist }

[unix]
build:
    bun build ./src/index.ts --outdir dist --target node --format esm --external @opencode-ai/plugin && bun x tsc --emitDeclarationOnly --declaration --outDir dist

# Remove the locally installed plugin
[windows]
uninstall:
    @if (Test-Path "{{plugins_dir}}\sandbox-plugin.js") { Remove-Item "{{plugins_dir}}\sandbox-plugin.js" -Force; Write-Host "Removed sandbox-plugin.js" } else { Write-Host "Not installed" }

[unix]
uninstall:
    @if [ -f "{{plugins_dir}}/sandbox-plugin.js" ]; then rm -f "{{plugins_dir}}/sandbox-plugin.js" && echo "Removed sandbox-plugin.js"; else echo "Not installed"; fi

# Tail the sandbox plugin log file
[windows]
logs:
    @if (Test-Path "{{log_file}}") { Get-Content "{{log_file}}" -Tail 50 -Wait } else { Write-Host "No log file yet at {{log_file}}" }

[unix]
logs:
    @if [ -f "{{log_file}}" ]; then tail -f -n 50 "{{log_file}}"; else echo "No log file yet at {{log_file}}"; fi

# Show the last N lines of the log (default 100)
[windows]
log lines="100":
    @if (Test-Path "{{log_file}}") { Get-Content "{{log_file}}" -Tail {{lines}} } else { Write-Host "No log file yet" }

[unix]
log lines="100":
    @if [ -f "{{log_file}}" ]; then tail -n {{lines}} "{{log_file}}"; else echo "No log file yet"; fi

# Clear the log file
[windows]
log-clear:
    @if (Test-Path "{{log_file}}") { Remove-Item "{{log_file}}" -Force; Write-Host "Log cleared" } else { Write-Host "No log file" }

[unix]
log-clear:
    @if [ -f "{{log_file}}" ]; then rm -f "{{log_file}}" && echo "Log cleared"; else echo "No log file"; fi

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
