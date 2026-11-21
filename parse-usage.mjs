const FIVE_HOUR_SECONDS = 5 * 60 * 60
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60
const MAX_EPOCH_MS = 253402300799999

const GLOG_LINE_PATTERN = /^\s*[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+[^\]]+\]/
const AUTH_ERROR_PATTERN = /not (?:logged|signed) in(?:to)?\b|unauthenticated|authentication required|login required|please (?:log|sign) in|sign in again|\binvalid_grant\b/i
const LICENSE_REFUSAL_PATTERN = /valid license of this product|\(#3501\)/i
const ELIGIBILITY_ERROR_PATTERN = /eligibility check failed|not eligible|unsupported (?:country|region)|does not support google tos/i
const NETWORK_ERROR_PATTERN = /\b(?:eof|timeout|timed out|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|ssl|certificate)\b/i

export class AgyUsageError extends Error {
  constructor(message, { kind = "", output = "" } = {}) {
    super(message)
    this.name = "AgyUsageError"
    this.kind = kind
    this.output = output
  }
}

function readTrimmedString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function readCamelOrSnake(obj, camelKey, snakeKey) {
  return obj?.[camelKey] ?? obj?.[snakeKey]
}

export function stripAgyDiagnosticLogs(rawOutput) {
  return String(rawOutput ?? "")
    .split(/\r?\n/)
    .filter((line) => !GLOG_LINE_PATTERN.test(line))
    .join("\n")
}

export function isSupportedAgyVersion(versionOutput) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(readTrimmedString(versionOutput))
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)))
}

export function classifyAgyCommandFailure(rawOutput) {
  const cleaned = stripAgyDiagnosticLogs(rawOutput)
  if (AUTH_ERROR_PATTERN.test(cleaned)) {
    return new AgyUsageError(
      "agy usage requires authentication. Run `agy` in a terminal to sign in again.",
      { kind: "auth" },
    )
  }
  if (LICENSE_REFUSAL_PATTERN.test(cleaned)) {
    return new AgyUsageError(
      "Google refused this account for Antigravity (403 #3501). Run `agy` in a terminal to re-authenticate or check account eligibility.",
    )
  }
  const isEligibility = ELIGIBILITY_ERROR_PATTERN.test(cleaned)
  const isNetwork = NETWORK_ERROR_PATTERN.test(String(rawOutput ?? ""))
  if (isNetwork) {
    return new AgyUsageError(
      `agy usage ${isEligibility ? "eligibility check " : ""}failed due to a network error. Check network or proxy settings.`,
    )
  }
  if (isEligibility) {
    return new AgyUsageError("agy reports that this account is not eligible for Antigravity.")
  }
  return new AgyUsageError("agy could not read usage. Run `agy` in a terminal to check its status.")
}

export function normalizeResetTimestamp(value) {
  if (value == null || value === "" || typeof value === "boolean") return undefined
  const raw = String(value).trim()
  let ms = Number.NaN
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const num = Number(raw)
    ms = num < 1e11 ? num * 1000 : num
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    ms = Date.parse(raw)
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_EPOCH_MS) return undefined
  return new Date(ms).toISOString()
}

export function resolveWindowCadence(bucket, bucketId, label) {
  const explicitWindow = readTrimmedString(bucket?.window)
  const probe = explicitWindow || `${bucketId} ${label}`
  if (
    /^(?:5h|five[_ -]?hours?|five_hour|session)$/i.test(probe)
    || (!explicitWindow && /(?:5h|five[ _-]hour|session)/i.test(probe))
  ) {
    return { name: "5 hours", span: FIVE_HOUR_SECONDS }
  }
  if (
    /^(?:weekly|week|7d|seven[_ -]?days?)$/i.test(probe)
    || (!explicitWindow && /(?:weekly|week|7d)/i.test(probe))
  ) {
    return { name: "7 days", span: SEVEN_DAY_SECONDS }
  }
  return { name: label || bucketId }
}

export function inferModelVendorFamily(modelId, modelName) {
  const lower = readTrimmedString(modelId).toLowerCase()
  if (lower.startsWith("gemini")) return "Gemini"
  if (lower.startsWith("claude")) return "Claude"
  if (lower.startsWith("gpt-oss")) return "GPT-OSS"
  if (lower.startsWith("gpt")) return "GPT"
  const fallbackName = readTrimmedString(modelName).split(/\s+/)[0]
  return fallbackName || lower.split("-")[0] || "Model"
}

export function extractRemainingFraction(bucket) {
  const remaining = bucket?.remaining
  const candidate = readCamelOrSnake(bucket, "remainingFraction", "remaining_fraction")
    ?? readCamelOrSnake(remaining, "remainingFraction", "remaining_fraction")
    ?? (remaining?.case === "remainingFraction" ? remaining.value : undefined)
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    return undefined
  }
  return candidate
}

function extractGroupModels(group) {
  const rawModels = Array.isArray(group?.models)
    ? group.models
    : Array.isArray(readCamelOrSnake(group, "modelIds", "model_ids"))
      ? readCamelOrSnake(group, "modelIds", "model_ids")
      : []

  const byId = new Map()
  for (const item of rawModels) {
    if (typeof item === "string") {
      const id = readTrimmedString(item)
      if (id && !byId.has(id)) byId.set(id, { id, name: id })
      continue
    }
    if (item && typeof item === "object") {
      const id = readTrimmedString(readCamelOrSnake(item, "modelId", "model_id") ?? item.id)
      const name = readTrimmedString(readCamelOrSnake(item, "displayName", "display_name") ?? item.name) || id
      if (id && !byId.has(id)) byId.set(id, { id, name })
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function parseAgyUsageReport(rawInput) {
  let report
  if (typeof rawInput === "string") {
    try {
      report = JSON.parse(rawInput)
    } catch {
      throw new AgyUsageError("agy returned an invalid JSON usage report.")
    }
  } else {
    report = rawInput
  }

  if (report?.status !== "SUCCESS" || report?.command?.name !== "usage") {
    throw classifyAgyCommandFailure(readTrimmedString(report?.error) || readTrimmedString(report?.response))
  }

  const groups = Array.isArray(report.command.data?.groups) ? report.command.data.groups : []
  const poolWindows = []
  const modelWindows = new Map()

  for (const group of groups) {
    const rawPoolName = readTrimmedString(readCamelOrSnake(group, "displayName", "display_name"))
      || readTrimmedString(group?.name)
      || "Quota"
    const pool = rawPoolName.replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")
    const groupModels = extractGroupModels(group)
    const groupModelIds = groupModels.map((entry) => entry.id)

    let tightestBucket = null
    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    for (const bucket of buckets) {
      const bucketId = readTrimmedString(readCamelOrSnake(bucket, "bucketId", "bucket_id"))
        || readTrimmedString(bucket?.id)
      if (!bucketId || bucket?.disabled === true) continue

      const label = readTrimmedString(readCamelOrSnake(bucket, "displayName", "display_name"))
        || readTrimmedString(bucket?.name)
      const cadence = resolveWindowCadence(bucket, bucketId, label)
      const fraction = extractRemainingFraction(bucket)
      const resetsAt = normalizeResetTimestamp(readCamelOrSnake(bucket, "resetTime", "reset_time"))

      const poolWindow = {
        name: cadence.name,
        pool,
        aside: true,
        ...(groupModelIds.length ? { models: groupModelIds } : {}),
        ...(fraction !== undefined
          ? { used: Math.round((1 - fraction) * 1e8) / 1e6 }
          : { display: "Limits not available" }),
        ...(cadence.span ? { span: cadence.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      }
      poolWindows.push(poolWindow)

      if (fraction !== undefined && (!tightestBucket || poolWindow.used > tightestBucket.used)) {
        tightestBucket = poolWindow
      }
    }

    if (!tightestBucket) continue
    for (const modelEntry of groupModels) {
      const existing = modelWindows.get(modelEntry.id)
      if (existing && existing.used >= tightestBucket.used) continue
      modelWindows.set(modelEntry.id, {
        name: modelEntry.name,
        model: modelEntry.id,
        family: inferModelVendorFamily(modelEntry.id, modelEntry.name),
        pool,
        aside: true,
        models: [modelEntry.id],
        used: tightestBucket.used,
        ...(tightestBucket.span ? { span: tightestBucket.span } : {}),
        ...(tightestBucket.resetsAt ? { resetsAt: tightestBucket.resetsAt } : {}),
      })
    }
  }

  if (!poolWindows.some((windowItem) => windowItem.used !== undefined)) {
    throw new AgyUsageError("Limits not available: agy returned no enabled, measured quota buckets.")
  }

  const sortedModelWindows = [...modelWindows.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { windows: [...sortedModelWindows, ...poolWindows] }
}
