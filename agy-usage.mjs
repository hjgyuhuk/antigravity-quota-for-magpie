import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  AgyUsageError,
  classifyAgyCommandFailure,
  isSupportedAgyVersion,
  parseAgyUsageReport,
} from "./parse-usage.mjs"

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_TIMEOUT_MS = 18_000 // Magpie caps auth.usage at 20 seconds.
const VERSION_TIMEOUT_MS = 3_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const BACKOFF_FIRST_MS = 10 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

export const AGY_NOT_FOUND_MESSAGE =
  "agy CLI not found. Install Antigravity CLI or specify the agy binary path when signing in."

function isExecutableFile(filePath) {
  try {
    fsSync.accessSync(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
    return fsSync.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function resolveAgyBinaryPath(customPath = "", env = process.env) {
  const trimmedCustom = typeof customPath === "string" ? customPath.trim() : ""
  if (trimmedCustom) {
    const expanded = trimmedCustom.startsWith("~/")
      ? path.join(os.homedir(), trimmedCustom.slice(2))
      : trimmedCustom
    return isExecutableFile(expanded) ? expanded : ""
  }

  const binName = process.platform === "win32" ? "agy.exe" : "agy"
  const candidates = []
  if (env.AGY_BIN) candidates.push(env.AGY_BIN)

  const pathVar = env.PATH || env.Path || ""
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, binName))
  }

  const homeDir = os.homedir()
  if (process.platform === "win32") {
    candidates.push(path.join(homeDir, ".local", "bin", binName))
  } else {
    candidates.push(
      path.join(homeDir, ".local", "bin", binName),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    )
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return ""
}

function buildIsolatedChildEnv(baseEnv, shimDir) {
  const nextEnv = { ...baseEnv }
  const inheritedPath = baseEnv.PATH || baseEnv.Path || (process.platform === "win32" ? "" : "/usr/bin:/bin")
  for (const key of Object.keys(nextEnv)) {
    if (/^path$/i.test(key) && key !== "PATH") delete nextEnv[key]
  }
  nextEnv.PATH = `${shimDir}${path.delimiter}${inheritedPath}`
  nextEnv.BROWSER = path.join(shimDir, process.platform === "win32" ? "open.cmd" : "open")
  return nextEnv
}

function clampUsageTimeout(rawTimeout) {
  const parsed = Number(rawTimeout)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(parsed, MAX_TIMEOUT_MS)
}

function terminateChildProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.unref?.()
    } catch {
      try {
        child.kill("SIGKILL")
      } catch (killErr) {
        if (killErr?.code !== "ESRCH") throw killErr
      }
    }
    return
  }

  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (groupErr) {
    if (groupErr?.code !== "ESRCH") {
      try {
        child.kill("SIGKILL")
      } catch (killErr) {
        if (killErr?.code !== "ESRCH") throw killErr
      }
    }
  }
}

function spawnAgySubprocess(binaryPath, args, { cwd, env, deadline, signal, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child = null
    let settled = false
    let totalBytes = 0
    let timer = null
    const stdoutChunks = []
    const stderrChunks = []

    const settle = (error, result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", handleAbort)
      if (child && (process.platform !== "win32" || error || child.exitCode === null)) {
        terminateChildProcessTree(child)
      }
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (error) reject(error)
      else resolve(result)
    }

    const handleAbort = () => {
      settle(new AgyUsageError("agy usage query was cancelled.", { kind: "cancel" }))
    }

    const handleTimeout = () => {
      const partialOutput =
        `${Buffer.concat(stdoutChunks).toString("utf8")}\n${Buffer.concat(stderrChunks).toString("utf8")}`
      settle(new AgyUsageError("agy usage query timed out.", { kind: "timeout", output: partialOutput }))
    }

    if (signal?.aborted) {
      handleAbort()
      return
    }
    if (Date.now() >= deadline) {
      settle(new AgyUsageError("agy usage query timed out.", { kind: "timeout" }))
      return
    }

    try {
      child = spawn(binaryPath, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch {
      settle(new AgyUsageError("agy usage could not start the CLI."))
      return
    }

    signal?.addEventListener("abort", handleAbort, { once: true })
    timer = setTimeout(handleTimeout, Math.max(1, deadline - Date.now()))

    const appendChunk = (target) => (chunk) => {
      if (settled) return
      totalBytes += chunk.length
      if (totalBytes > maxOutputBytes) {
        settle(new AgyUsageError("agy usage output exceeded the size limit."))
        return
      }
      target.push(chunk)
    }

    child.stdout.on("data", appendChunk(stdoutChunks))
    child.stderr.on("data", appendChunk(stderrChunks))
    child.on("error", () => settle(new AgyUsageError("agy usage could not start the CLI.")))
    child.on("close", (code) => {
      settle(null, {
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      })
    })
  })
}

async function prepareIsolationDirectory(tempRoot) {
  const workDir = await fs.mkdtemp(path.join(tempRoot, "magpie-agy-quota-"))
  await fs.chmod(workDir, 0o700)

  const agentDir = path.join(workDir, ".agents", "agents", "magpie-usage")
  await fs.mkdir(agentDir, { recursive: true })
  await fs.writeFile(
    path.join(agentDir, "agent.md"),
    [
      "---",
      "name: magpie-usage",
      "description: Read CLI usage only",
      "mainAgent: true",
      "subagent: false",
      "tools: []",
      "mcpServers: []",
      "---",
      "Do not run model prompts or tools.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  )

  if (process.platform === "win32") {
    await fs.writeFile(path.join(workDir, "open.cmd"), "@exit /b 1\r\n")
  } else {
    for (const shimName of ["open", "xdg-open"]) {
      await fs.writeFile(path.join(workDir, shimName), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    }
  }
  return workDir
}

async function removeIsolationDirectory(workDir) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.rm(workDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 3 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) return
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export async function queryAgyUsageFromCli(binaryPath, {
  env = process.env,
  timeoutMs = env.AGY_QUOTA_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  signal,
  tempRoot = os.tmpdir(),
} = {}) {
  if (!binaryPath) throw new AgyUsageError(AGY_NOT_FOUND_MESSAGE)

  const deadline = Date.now() + clampUsageTimeout(timeoutMs)
  const workDir = await prepareIsolationDirectory(tempRoot)
  try {
    const childEnv = buildIsolatedChildEnv(env, workDir)
    const runOptions = { cwd: workDir, env: childEnv, deadline, signal, maxOutputBytes }

    const versionResult = await spawnAgySubprocess(binaryPath, ["--version"], {
      ...runOptions,
      deadline: Math.min(deadline, Date.now() + VERSION_TIMEOUT_MS),
    })
    if (versionResult.code !== 0) {
      throw classifyAgyCommandFailure(versionResult.stderr || versionResult.stdout)
    }
    if (!isSupportedAgyVersion(versionResult.stdout)) {
      throw new AgyUsageError("agy usage reports require Antigravity CLI version 1.1.11 or later.")
    }

    const remainingSecs = Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
    const usageResult = await spawnAgySubprocess(
      binaryPath,
      [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--agent",
        "magpie-usage",
        "--print-timeout",
        `${remainingSecs}s`,
      ],
      runOptions,
    )

    let parsedReport = null
    try {
      parsedReport = JSON.parse(usageResult.stdout)
    } catch {
      parsedReport = null
    }

    if (usageResult.code === 0 && parsedReport?.status === "SUCCESS") {
      return parseAgyUsageReport(parsedReport)
    }
    if (usageResult.code === 0 && !parsedReport?.status) {
      return parseAgyUsageReport(usageResult.stdout)
    }

    const failureText = parsedReport?.status && parsedReport.status !== "SUCCESS"
      ? (parsedReport.error || parsedReport.response || "")
      : `${usageResult.stderr}\n${usageResult.stdout}`
    throw classifyAgyCommandFailure(failureText)
  } finally {
    await removeIsolationDirectory(workDir)
  }
}

function computeBackoffMs(consecutiveFailures) {
  const exponent = Math.max(0, Math.min(consecutiveFailures, 20) - 1)
  return Math.min(BACKOFF_FIRST_MS * 2 ** exponent, BACKOFF_MAX_MS)
}

export function createAgyUsageCoordinator({
  resolveBinary = resolveAgyBinaryPath,
  queryCli = queryAgyUsageFromCli,
  now = () => Date.now(),
} = {}) {
  const pendingByPath = new Map()
  const backoffByPath = new Map()

  return {
    async readUsage({ customPath = "", signal } = {}) {
      const binaryPath = resolveBinary(customPath)
      if (!binaryPath) {
        return { windows: [], error: AGY_NOT_FOUND_MESSAGE, signIn: "kept" }
      }

      const held = backoffByPath.get(binaryPath)
      if (held && now() < held.until) {
        return { windows: [], error: held.error, signIn: held.signIn }
      }

      try {
        let inflight = pendingByPath.get(binaryPath)
        if (!inflight) {
          inflight = queryCli(binaryPath, { signal }).finally(() => {
            if (pendingByPath.get(binaryPath) === inflight) {
              pendingByPath.delete(binaryPath)
            }
          })
          pendingByPath.set(binaryPath, inflight)
        }
        const usage = await inflight
        backoffByPath.delete(binaryPath)
        return usage
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to read agy usage."
        const isAuthError = error instanceof AgyUsageError && error.kind === "auth"
        const signIn = isAuthError ? "expired" : "kept"

        const isCancelled = error instanceof AgyUsageError && error.kind === "cancel"
        if (!isCancelled) {
          const nextFailures = (held?.failures ?? 0) + 1
          backoffByPath.set(binaryPath, {
            failures: nextFailures,
            until: now() + computeBackoffMs(nextFailures),
            error: message,
            signIn,
          })
        }
        return { windows: [], error: message, signIn }
      }
    },
  }
}
