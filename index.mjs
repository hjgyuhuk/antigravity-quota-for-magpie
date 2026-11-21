import {
  AGY_NOT_FOUND_MESSAGE,
  createAgyUsageCoordinator,
  resolveAgyBinaryPath,
} from "./agy-usage.mjs"

const PROVIDER_ID = "agy-quota"
const QUOTA_ONLY_BASE_URL = "http://127.0.0.1:0/agy-quota-only"

function extractCustomAgyPath(auth) {
  const fromMeta = typeof auth?.metadata?.agyPath === "string" ? auth.metadata.agyPath.trim() : ""
  if (fromMeta) return fromMeta
  const rawKey = typeof auth?.key === "string" ? auth.key.trim() : ""
  if (!rawKey || rawKey === "local" || rawKey.startsWith("local:")) return ""
  return rawKey
}

async function createAgyQuotaPlugin() {
  const coordinator = createAgyUsageCoordinator()

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
        name: "Antigravity CLI Quota",
        npm: "@ai-sdk/openai-compatible",
        api: QUOTA_ONLY_BASE_URL,
        models: {
          "quota-only": {
            name: "Antigravity Quota Only",
            limit: { context: 1, output: 1 },
            disabled: true,
          },
        },
      }
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Connect local agy CLI",
          placeholder: "local",
          prompts: [
            {
              type: "text",
              key: "agyPath",
              message: "agy binary path (leave blank to auto-detect)",
              placeholder: "/Users/.../.local/bin/agy",
            },
          ],
          async authorize(inputs) {
            const rawInput = typeof inputs === "string"
              ? inputs.trim()
              : typeof inputs?.agyPath === "string"
                ? inputs.agyPath.trim()
                : typeof inputs?.key === "string"
                  ? inputs.key.trim()
                  : ""
            const customPath = !rawInput || rawInput === "local" ? "" : rawInput
            const resolvedPath = resolveAgyBinaryPath(customPath)
            if (!resolvedPath) {
              return {
                type: "failed",
                error: customPath
                  ? `agy CLI not found at: ${customPath}`
                  : AGY_NOT_FOUND_MESSAGE,
              }
            }
            return {
              type: "success",
              key: customPath || `local:${resolvedPath}`,
              metadata: {
                email: "local-agy",
                agyPath: customPath,
                resolvedPath,
              },
            }
          },
        },
      ],

      async loader() {
        return {
          baseURL: QUOTA_ONLY_BASE_URL,
          async fetch() {
            return new Response(
              JSON.stringify({
                error: {
                  message:
                    "agy-quota is a quota-viewing plugin only and does not proxy model requests.",
                  type: "not_implemented",
                },
              }),
              {
                status: 501,
                headers: { "content-type": "application/json" },
              },
            )
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const customPath = extractCustomAgyPath(auth)
        return coordinator.readUsage({ customPath })
      },
    },
  }
}

export default {
  id: PROVIDER_ID,
  server: createAgyQuotaPlugin,
}

export const _internal = {
  PROVIDER_ID,
  extractCustomAgyPath,
}
