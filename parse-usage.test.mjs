import { describe, expect, test } from "bun:test"
import { createAgyUsageCoordinator } from "./agy-usage.mjs"
import {
  AgyUsageError,
  classifyAgyCommandFailure,
  isSupportedAgyVersion,
  normalizeResetTimestamp,
  parseAgyUsageReport,
} from "./parse-usage.mjs"

describe("isSupportedAgyVersion", () => {
  test("accepts 1.1.11 and newer", () => {
    expect(isSupportedAgyVersion("1.1.11")).toBe(true)
    expect(isSupportedAgyVersion("1.5.14\n")).toBe(true)
    expect(isSupportedAgyVersion("2.0.0")).toBe(true)
  })

  test("rejects older or invalid versions", () => {
    expect(isSupportedAgyVersion("1.1.10")).toBe(false)
    expect(isSupportedAgyVersion("0.9.9")).toBe(false)
    expect(isSupportedAgyVersion("unknown")).toBe(false)
  })
})

describe("normalizeResetTimestamp", () => {
  test("normalizes ISO, seconds, and milliseconds", () => {
    expect(normalizeResetTimestamp("2026-11-22T00:00:00Z")).toBe("2026-11-22T00:00:00.000Z")
    expect(normalizeResetTimestamp(1795305600)).toBe("2026-11-22T00:00:00.000Z")
    expect(normalizeResetTimestamp(1795305600000)).toBe("2026-11-22T00:00:00.000Z")
    expect(normalizeResetTimestamp("")).toBeUndefined()
    expect(normalizeResetTimestamp(null)).toBeUndefined()
  })
})

describe("parseAgyUsageReport", () => {
  test("parses multi-pool report with 5h and 7d buckets", () => {
    const report = {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              displayName: "Gemini models",
              models: [
                { id: "gemini-3-pro", displayName: "Gemini 3 Pro" },
                { id: "gemini-3-flash", displayName: "Gemini 3 Flash" },
              ],
              buckets: [
                {
                  bucketId: "5h",
                  remainingFraction: 0.75,
                  resetTime: "2026-11-21T18:00:00Z",
                },
                {
                  bucketId: "weekly",
                  remaining: { remainingFraction: 0.6 },
                  resetTime: "2026-11-28T00:00:00Z",
                },
              ],
            },
            {
              displayName: "Claude and GPT models",
              modelIds: ["claude-sonnet-4-5"],
              buckets: [
                {
                  bucketId: "5h",
                  remainingFraction: 0.2,
                  resetTime: "2026-11-21T19:00:00Z",
                },
                {
                  bucketId: "disabled-bucket",
                  disabled: true,
                  remainingFraction: 0,
                },
              ],
            },
          ],
        },
      },
    }

    const parsed = parseAgyUsageReport(report)
    expect(parsed.windows.every((item) => item.aside === true)).toBe(true)

    const gemini5h = parsed.windows.find((w) => w.pool === "Gemini" && !w.model && w.name === "5 hours")
    expect(gemini5h).toEqual({
      name: "5 hours",
      pool: "Gemini",
      aside: true,
      models: ["gemini-3-flash", "gemini-3-pro"],
      used: 25,
      span: 18000,
      resetsAt: "2026-11-21T18:00:00.000Z",
    })

    const gemini7d = parsed.windows.find((w) => w.pool === "Gemini" && !w.model && w.name === "7 days")
    expect(gemini7d?.used).toBe(40)
    expect(gemini7d?.span).toBe(604800)

    const geminiPro = parsed.windows.find((w) => w.model === "gemini-3-pro")
    expect(geminiPro).toEqual({
      name: "Gemini 3 Pro",
      model: "gemini-3-pro",
      family: "Gemini",
      pool: "Gemini",
      aside: true,
      models: ["gemini-3-pro"],
      used: 40,
      span: 604800,
      resetsAt: "2026-11-28T00:00:00.000Z",
    })

    const claudePool = parsed.windows.find((w) => w.pool === "Claude & GPT" && !w.model)
    expect(claudePool?.used).toBe(80)
  })

  test("omits used when fraction is unknown and keeps display text", () => {
    const parsed = parseAgyUsageReport({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              displayName: "Gemini",
              buckets: [
                { bucketId: "5h", remainingFraction: 0.5 },
                { bucketId: "weekly" },
              ],
            },
          ],
        },
      },
    })

    const weekly = parsed.windows.find((w) => w.name === "7 days")
    expect(weekly?.used).toBeUndefined()
    expect(weekly?.display).toBe("Limits not available")
  })

  test("throws when no measured buckets exist", () => {
    expect(() =>
      parseAgyUsageReport({
        status: "SUCCESS",
        command: {
          name: "usage",
          data: { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "5h" }] }] },
        },
      }),
    ).toThrow(AgyUsageError)
  })

  test("classifies authentication failures as kind=auth", () => {
    const err = classifyAgyCommandFailure("I1121 21:00:00.123 1 main.go:1] boot\nError: not logged in")
    expect(err.kind).toBe("auth")
  })
})

describe("createAgyUsageCoordinator", () => {
  test("deduplicates concurrent reads and backs off after failures", async () => {
    let calls = 0
    let currentTime = 1_000
    const coordinator = createAgyUsageCoordinator({
      resolveBinary: () => "/mock/agy",
      now: () => currentTime,
      queryCli: async () => {
        calls++
        if (calls === 1) {
          throw new AgyUsageError("not signed in", { kind: "auth" })
        }
        return { windows: [{ name: "5 hours", pool: "Gemini", used: 10, aside: true }] }
      },
    })

    const [first, second] = await Promise.all([
      coordinator.readUsage(),
      coordinator.readUsage(),
    ])
    expect(calls).toBe(1)
    expect(first.signIn).toBe("expired")
    expect(second.signIn).toBe("expired")

    // Within backoff window: does not invoke CLI again.
    currentTime += 60_000
    const cachedFailure = await coordinator.readUsage()
    expect(calls).toBe(1)
    expect(cachedFailure.signIn).toBe("expired")

    // After backoff expires: retries and succeeds.
    currentTime += 10 * 60 * 1000
    const recovered = await coordinator.readUsage()
    expect(calls).toBe(2)
    expect(recovered.windows).toHaveLength(1)
  })
})
