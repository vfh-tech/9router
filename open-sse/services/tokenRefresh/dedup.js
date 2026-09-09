const REFRESH_RESULT_TTL_MS = 10_000;
const MAX_DEDUP_ENTRIES = 200;
const refreshDedupCache = new Map();

function pruneExpiredOrOldest() {
  const now = Date.now();
  for (const [k, v] of refreshDedupCache) {
    if (v.expiresAt && v.expiresAt <= now) refreshDedupCache.delete(k);
  }
  while (refreshDedupCache.size >= MAX_DEDUP_ENTRIES) {
    const oldest = refreshDedupCache.keys().next().value;
    if (!oldest) break;
    refreshDedupCache.delete(oldest);
  }
}

export async function dedupRefresh(provider, oldToken, fn, log) {
  if (!oldToken) return fn();
  const key = `${provider}:${oldToken}`;
  const hit = refreshDedupCache.get(key);
  if (hit) {
    if (hit.promise) {
      log?.info?.("TOKEN_REFRESH", `Reusing in-flight refresh for ${provider}`);
      return hit.promise;
    }
    if (hit.expiresAt > Date.now()) {
      log?.info?.("TOKEN_REFRESH", `Reusing recent refresh result for ${provider}`);
      return hit.result;
    }
    refreshDedupCache.delete(key);
  }
  pruneExpiredOrOldest();
  const promise = (async () => {
    try {
      const result = await fn();
      pruneExpiredOrOldest();
      refreshDedupCache.set(key, { result, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });
      return result;
    } catch (err) {
      refreshDedupCache.delete(key);
      throw err;
    }
  })();
  refreshDedupCache.set(key, { promise });
  return promise;
}
