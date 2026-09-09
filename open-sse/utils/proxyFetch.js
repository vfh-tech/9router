import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { Agent as UndiciAgent } from "undici";
import { dbg } from "./debugLog.js";

const proxyDispatchers = new Map();

// Resolve the underlying fetch safely. This module patches globalThis.fetch
// with patchedFetch (below), so resolving at call time would recurse into
// ourselves. Unwrap rule: a global that is NOT our patch (test mock, the
// untouched native fetch, or ANOTHER proxyFetch instance's patch) is used
// as-is; our own patch unwraps one level to whatever it replaced at install
// time. Cross-instance ping-pong is impossible: unwrapping never re-enters
// a patch — it returns the captured predecessor directly.
function originalFetch() {
  const g = globalThis.fetch;
  return g === patchedFetch ? (patchedFetch.__unpatchedFetch || g) : g;
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();

// Shared keep-alive dispatcher for direct (no-proxy) requests. Lazy singleton:
// undici's default keepAliveTimeout is only 4s, so idle sockets between turns
// get dropped and the next request pays a fresh TCP+TLS handshake. 60s
// matches typical inter-request gaps in an agent loop.
let _directDispatcher = null;
function getDirectDispatcher() {
  if (!_directDispatcher) {
    _directDispatcher = new UndiciAgent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
    });
  }
  return _directDispatcher;
}
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    if (DNS_CACHE.size >= 500) {
      const now = Date.now();
      for (const [k, v] of DNS_CACHE) {
        if (v.expiry <= now) DNS_CACHE.delete(k);
      }
      if (DNS_CACHE.size >= 500) {
        const oldest = DNS_CACHE.keys().next().value;
        if (oldest) DNS_CACHE.delete(oldest);
      }
    }
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      const oldestKey = proxyDispatchers.keys().next().value;
      const oldest = proxyDispatchers.get(oldestKey);
      if (oldest?.close) {
        oldest.close().catch(() => {});
      } else if (oldest?.destroy) {
        oldest.destroy();
      }
      proxyDispatchers.delete(oldestKey);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Per-host undici dispatchers for MITM bypass. Connect is pinned to the
 * Google-DNS-resolved IP (DNS-bypass against /etc/hosts MITM) while SNI + cert
 * validation still use the hostname — undici handles both, and the pooled
 * agent reuses TCP+TLS across requests instead of hand-rolling a fresh socket.
 * Cached entries rebuild when the resolved IP changes (DNS refresh), so an
 * anycast endpoint moving IPs is followed, not stuck on the old pin.
 * ponytail: ceiling = per-host Agent cache, no size bound (MITM_BYPASS_HOSTS is
 * a small static list; upgrade path = LRU if the list ever becomes dynamic).
 */
const bypassDispatchers = new Map();

async function getBypassDispatcher(hostname, realIP) {
  const cached = bypassDispatchers.get(hostname);
  // Rebuild if the pinned IP changed (DNS refresh): an anycast endpoint moving
  // to a new IP must not keep the dispatcher dialing the old one forever.
  if (cached && cached.realIP === realIP) return cached.dispatcher;
  if (cached) {
    cached.dispatcher.close().catch(() => {});
  }
  const { Agent } = await import("undici");
  const dispatcher = new Agent({
    connect: {
      // Pin connect to the validated IP so no second DNS resolution can rebind (TOCTOU fix).
      lookup: (_h, _o, cb) => cb(null, [{ address: realIP, family: 4 }]),
      // SNI + cert hostname stay the caller's hostname (undici default servername),
      // and MITM_BYPASS_HOSTS targets are all public-CA-issued, so default
      // verification rejects on-path attackers without any extra trust store.
      servername: hostname,
    },
  });
  bypassDispatchers.set(hostname, { realIP, dispatcher });
  return dispatcher;
}

/**
 * HTTPS request with pinned-IP connection (bypass DNS), pooled via undici.
 */
async function createBypassRequest(targetUrl, realIP, options) {
  const dispatcher = await getBypassDispatcher(new URL(targetUrl).hostname, realIP);
  return originalFetch()(targetUrl, { ...options, dispatcher });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch()(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch()(url, { ...options, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — resolve real IP once, then pin connections to it via a pooled
    // per-host dispatcher (bypasses /etc/hosts MITM without fresh TLS per request)
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(targetUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await originalFetch()(url, { ...options, dispatcher });
    } catch (proxyError) {
      // If strictProxy is enabled, fail hard instead of falling back to direct
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return originalFetch()(url, { ...options, dispatcher: getDirectDispatcher() });
    }
  }

  // got-scraping disabled — use the shared keep-alive dispatcher directly.
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed.)
  // ponytail: undici's default keepAliveTimeout is 4s — idle sockets between
  // turns get dropped and the next request pays a fresh TCP+TLS handshake.
  // 60s matches typical inter-request gaps in an agent loop.
  return originalFetch()(url, { ...options, dispatcher: getDirectDispatcher() });
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times.
// Step down through any existing patch instances BEFORE capturing, so
// __unpatchedFetch always points at a real (non-patch) fetch — a test mock
// or the native fetch — never at another wrapper. This is what keeps
// originalFetch() free of cross-instance ping-pong under vi.resetModules.
if (globalThis.fetch !== patchedFetch) {
  let base = globalThis.fetch;
  while (base && base.__unpatchedFetch) base = base.__unpatchedFetch;
  patchedFetch.__unpatchedFetch = base;
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
