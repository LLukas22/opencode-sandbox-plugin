import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

const MAX_FILE_SIZE = 5 * 1024 * 1024
const MAX_ROTATED_FILES = 3

function getLogDir(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".local", "share", "opencode", "log")
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "log")
}

function getLogFilePath(): string {
  return path.join(getLogDir(), "sandbox-plugin.log")
}

function getConfiguredLevel(): LogLevel {
  const env = process.env.OPENCODE_SANDBOX_LOG_LEVEL?.toUpperCase()
  if (env && env in LEVEL_ORDER) return env as LogLevel
  return "DEBUG"
}

function ensureLogDir(): void {
  const dir = getLogDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size < MAX_FILE_SIZE) return
  } catch {
    return
  }

  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const older = `${filePath}.${i}`
    const newer = i === 1 ? filePath : `${filePath}.${i - 1}`
    try {
      if (i === MAX_ROTATED_FILES) {
        fs.unlinkSync(older)
      }
    } catch {}
    try {
      fs.renameSync(newer, older)
    } catch {}
  }
}

class Logger {
  private filePath: string
  private minLevel: LogLevel
  private initialized = false

  constructor() {
    this.filePath = getLogFilePath()
    this.minLevel = getConfiguredLevel()
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true
    ensureLogDir()
    rotateIfNeeded(this.filePath)
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel]
  }

  private write(level: LogLevel, message: string): void {
    if (!this.shouldLog(level)) return
    if (!this.initialized) this.init()
    const timestamp = new Date().toISOString()
    const line = `[${level}] ${timestamp} ${message}\n`
    try {
      fs.appendFileSync(this.filePath, line, "utf-8")
    } catch {}
  }

  debug(message: string): void {
    this.write("DEBUG", message)
  }

  info(message: string): void {
    this.write("INFO", message)
  }

  warn(message: string): void {
    this.write("WARN", message)
  }

  error(message: string): void {
    this.write("ERROR", message)
  }
}

export const logger = new Logger()
