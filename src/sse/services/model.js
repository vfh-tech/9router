// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      // Concurrent — the 3 sequential full-table SELECTs sat on the TTFT path.
      const [openaiNodes, anthropicNodes, embeddingNodes] = await Promise.all([
        getProviderNodes({ type: "openai-compatible" }),
        getProviderNodes({ type: "anthropic-compatible" }),
        getProviderNodes({ type: "custom-embedding" }),
      ]);
      const matched = [openaiNodes, anthropicNodes, embeddingNodes]
        .flat()
        .find((node) => node.prefix === parsed.providerAlias);
      if (matched) {
        return { provider: matched.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

// ponytail: negative cache for combo-name misses (bare model names hit the
// combos table on every request). Ceiling: 5s TTL; CRUD through localDb
// invalidates naturally on TTL expiry — no cross-file invalidation wiring.
const COMBO_MISS_TTL_MS = 5000;
const comboMissCache = new Map(); // name -> ts

/**
 * Memoized getComboByName: returns null for misses without re-querying
 * within the TTL. Use in hot paths (chat.js handleChat) instead of the raw
 * repos call.
 */
export async function getComboByNameCached(name) {
  const missedAt = comboMissCache.get(name);
  if (missedAt) {
    if (Date.now() - missedAt < COMBO_MISS_TTL_MS) return null;
    comboMissCache.delete(name);
  }
  const combo = await getComboByName(name);
  if (!combo) comboMissCache.set(name, Date.now());
  // Bound the cache: misses are per model name, prune when oversized.
  if (comboMissCache.size > 500) comboMissCache.clear();
  return combo;
}
