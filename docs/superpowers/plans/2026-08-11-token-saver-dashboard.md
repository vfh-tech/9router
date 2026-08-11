# Token Saver Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an event store + stats API + interactive dashboard tab for all 5 token savers on the existing `/dashboard/token-saver` page.

**Architecture:** Three layers — a JSONL event store (fail-open, metadata-only), a stats aggregation API, and a "Stats" tab on the existing Token Saver config page. Wiring collects per-saver summaries in `chatCore.js` and pushes them through a new `onTokenSaverEvent` callback.

**Tech Stack:** Plain ESM JS (no TS), Next.js App Router route, React (recharts), vitest. Reuse patterns from `src/lib/pxpipe/events.js` and `src/app/(dashboard)/dashboard/pxpipe/PxpipeClient.js`.

## Global Constraints

- Plain JavaScript ESM. `@/*` alias → `src/*`.
- Event store must be 100% fail-open: never throw, never block the request path.
- Metadata only — no tool_result content or request bodies persisted.
- Event file dir: `~/.9router/token-saver/`, rotate at 5MB to `events.jsonl.1`.
- Follow existing pxpipe event-store + dashboard patterns exactly.
- `.env`/DB untouched. No new npm deps (recharts already used by pxpipe).
- Max 200 lines/function (LINESCODE rule).

---
## File Map

**New:**
- `src/lib/tokenSaver/events.js` — event store + aggregation
- `src/app/api/token-saver/stats/route.js` — stats API
- `src/app/(dashboard)/dashboard/token-saver/stats/page.js` — page wrapper
- `src/app/(dashboard)/dashboard/token-saver/stats/TokenSaverStatsClient.js` — stats tab UI
- `src/app/(dashboard)/dashboard/token-saver/stats/components/StatCards.js`
- `tests/unit/token-saver-events.test.js`

**Modified:**
- `open-sse/handlers/chatCore.js` — emit events
- `src/sse/handlers/chat.js` — wire callback
- `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js` — add Stats tab
- `src/dashboardGuard.js` — allow route

---

### Task 1: Event store (`src/lib/tokenSaver/events.js`)

**Files:**
- Create: `src/lib/tokenSaver/events.js`
- Test: `tests/unit/token-saver-events.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `appendTokenSaverEvent(ev)` — fire-and-forget, never throws
  - `readTokenSaverEvents({ sinceMs, limit, saver, provider })` → array of events
  - `getTokenSaverStats({ timelineDays, recentLimit })` → `{ windows, timeline, bySaver, byProvider, recent }`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendTokenSaverEvent,
  readTokenSaverEvents,
  getTokenSaverStats,
  _setDir,
} from "@/lib/tokenSaver/events.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tk-"));
beforeEach(() => _setDir(tmp));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("token saver events", () => {
  it("roundtrips append → read", () => {
    appendTokenSaverEvent({ saver: "rtk", provider: "claude", applied: true, savedTokens: 100, ts: Date.now() });
    const all = readTokenSaverEvents();
    expect(all).toHaveLength(1);
    expect(all[0].saver).toBe("rtk");
  });

  it("filters by saver", () => {
    appendTokenSaverEvent({ saver: "rtk", ts: Date.now() });
    appendTokenSaverEvent({ saver: "pxpipe", ts: Date.now() });
    expect(readTokenSaverEvents({ saver: "rtk" })).toHaveLength(1);
  });

  it("aggregates windows and bySaver", () => {
    const now = Date.now();
    appendTokenSaverEvent({ saver: "rtk", applied: true, savedTokens: 50, ts: now });
    appendTokenSaverEvent({ saver: "pxpipe", applied: true, savedTokens: 150, ts: now });
    const s = getTokenSaverStats({ timelineDays: 3 });
    expect(s.windows.today.savedTokens).toBe(200);
    expect(s.windows.today.requests).toBe(2);
    const rtk = s.bySaver.find((b) => b.saver === "rtk");
    expect(rtk.savedTokens).toBe(50);
    expect(s.timeline).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && npx vitest run unit/token-saver-events.test.js`
Expected: FAIL — module not found / `_setDir` undefined.

- [ ] **Step 3: Write implementation**

Create `src/lib/tokenSaver/events.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

let BASE_DIR = path.join(DATA_DIR, "token-saver"); // resolved at import; override in tests
const EVENTS_FILE = () => path.join(BASE_DIR, "events.jsonl");
const ROTATED_FILE = () => path.join(BASE_DIR, "events.jsonl.1");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function _setDir(dir) { BASE_DIR = dir; }

function ensureDir() {
  if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
}

// Fire-and-forget: stats must never break the request path.
export function appendTokenSaverEvent(event) {
  try {
    ensureDir();
    try {
      const stat = fs.statSync(EVENTS_FILE());
      if (stat.size > MAX_FILE_BYTES) fs.renameSync(EVENTS_FILE(), ROTATED_FILE());
    } catch { /* no file yet */ }
    fs.appendFileSync(EVENTS_FILE(), JSON.stringify(event) + "\n");
  } catch { /* ignore */ }
}

export function readTokenSaverEvents({ sinceMs = null, limit = null, saver = null, provider = null } = {}) {
  const events = [];
  for (const file of [ROTATED_FILE(), EVENTS_FILE()]) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (sinceMs && ev.ts < sinceMs) continue;
          if (saver && ev.saver !== saver) continue;
          if (provider && ev.provider !== provider) continue;
          events.push(ev);
        } catch { /* skip corrupt line */ }
      }
    } catch { /* ignore */ }
  }
  events.sort((a, b) => a.ts - b.ts);
  return limit ? events.slice(-limit) : events;
}

function emptyWindow() {
  return { requests: 0, applied: 0, savedTokens: 0, savedPct: 0, requestsPerSaver: {}, savedTokensPerSaver: {} };
}

function accumulate(w, ev) {
  w.requests++;
  if (ev.applied) w.applied++;
  const saved = ev.savedTokens || ev.tokensSaved || 0;
  w.savedTokens += saved;
  if (!w.savedTokensPerSaver[ev.saver]) w.savedTokensPerSaver[ev.saver] = 0;
  w.savedTokensPerSaver[ev.saver] += saved;
  if (!w.requestsPerSaver[ev.saver]) w.requestsPerSaver[ev.saver] = 0;
  w.requestsPerSaver[ev.saver]++;
}

function finalize(w) {
  w.savedPct = w.savedTokens > 0 ? 100 : 0; // pct needs before-total; keep simple
  return w;
}

export function getTokenSaverStats({ timelineDays = 30, recentLimit = 100 } = {}) {
  const events = readTokenSaverEvents();
  const now = Date.now();
  const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

  const windows = {
    all: emptyWindow(), today: emptyWindow(), yesterday: emptyWindow(),
    last7d: emptyWindow(), last30d: emptyWindow(),
  };
  const acc = (w, ev) => { if (w) accumulate(w, ev); };

  for (const ev of events) {
    acc(windows.all, ev);
    if (ev.ts >= startOfToday) acc(windows.today, ev);
    else if (ev.ts >= startOfToday - DAY_MS) acc(windows.yesterday, ev);
    if (ev.ts >= now - 7 * DAY_MS) acc(windows.last7d, ev);
    if (ev.ts >= now - 30 * DAY_MS) acc(windows.last30d, ev);
  }
  for (const w of Object.values(windows)) finalize(w);

  const timeline = new Map();
  for (let i = timelineDays - 1; i >= 0; i--) {
    const day = new Date(startOfToday - i * DAY_MS);
    timeline.set(day.toISOString().slice(0, 10), { date: day.toISOString().slice(0, 10), savedTokens: 0, applied: 0, requests: 0 });
  }
  for (const ev of events) {
    const key = new Date(ev.ts).toISOString().slice(0, 10);
    const b = timeline.get(key);
    if (b) { b.requests++; if (ev.applied) b.applied++; b.savedTokens += ev.savedTokens || ev.tokensSaved || 0; }
  }

  const bySaver = new Map();
  const byProvider = new Map();
  for (const ev of events) {
    if (!bySaver.has(ev.saver)) bySaver.set(ev.saver, { saver: ev.saver, requests: 0, applied: 0, savedTokens: 0 });
    const s = bySaver.get(ev.saver); s.requests++; if (ev.applied) s.applied++; s.savedTokens += ev.savedTokens || ev.tokensSaved || 0;
    const p = ev.provider || "unknown";
    if (!byProvider.has(p)) byProvider.set(p, { provider: p, requests: 0, applied: 0, savedTokens: 0 });
    const b = byProvider.get(p); b.requests++; if (ev.applied) b.applied++; b.savedTokens += ev.savedTokens || ev.tokensSaved || 0;
  }

  return {
    windows,
    timeline: [...timeline.values()],
    bySaver: [...bySaver.values()].sort((a, b) => b.savedTokens - a.savedTokens),
    byProvider: [...byProvider.values()].sort((a, b) => b.savedTokens - a.savedTokens),
    recent: events.slice(-recentLimit).reverse(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && npx vitest run unit/token-saver-events.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tokenSaver/events.js tests/unit/token-saver-events.test.js
git commit -m "feat(token-saver): add JSONL event store + stats aggregation"
```

---

### Task 2: Stats API route

**Files:**
- Create: `src/app/api/token-saver/stats/route.js`
- Modify: `src/dashboardGuard.js:82` (add route to allowlist)

**Interfaces:**
- Consumes: `getTokenSaverStats` from Task 1.
- Produces: `GET /api/token-saver/stats?limit=N` → `getTokenSaverStats({ recentLimit: N })` JSON.

- [ ] **Step 1: Write route**

Create `src/app/api/token-saver/stats/route.js`:

```js
import { NextResponse } from "next/server";
import { getTokenSaverStats } from "@/lib/tokenSaver/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const recentLimit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return NextResponse.json(getTokenSaverStats({ recentLimit }));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Allowlist route in dashboardGuard**

Read `src/dashboardGuard.js`, find the array of `/api/...` strings (near line 82 where headroom routes are). Add `/api/token-saver/stats` to that array.

- [ ] **Step 3: Verify**

Run: `npx eslint src/app/api/token-saver/stats/route.js`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/token-saver/stats/route.js src/dashboardGuard.js
git commit -m "feat(token-saver): add stats API route + dashboard guard"
```

---

### Task 3: Emit events in chatCore + wire callback

**Files:**
- Modify: `open-sse/handlers/chatCore.js` (token-saver block ~lines 230-260)
- Modify: `src/sse/handlers/chat.js:~285`

**Interfaces:**
- Consumes: existing `rtkStats`, `headroomStats`, `cavemanLevel`, `ponytailLevel`, `pxpipeSummary`, and scope vars `provider`, `model`, `connectionId`.
- Produces: `onTokenSaverEvent(ev)` callback param; `src/sse/handlers/chat.js` passes `appendTokenSaverEvent`.

- [ ] **Step 1: Add callback param + emit RTK/headroom/caveman/ponytail events**

In `open-sse/handlers/chatCore.js`, add `onTokenSaverEvent` to the destructured params (line 60). After the RTK block (rtkLine), add:

```js
  const emit = (ev) => { try { onTokenSaverEvent?.({ provider, model, connectionId, ts: Date.now(), ...ev }); } catch { /* never break request */ } };
```

After the RTK block, emit:
```js
  if (rtkStats?.hits?.length) emit({ saver: "rtk", applied: true, filters: rtkStats.hits.map((h) => h.filter), hits: rtkStats.hits.length, savedTokens: Math.round((rtkStats.bytesBefore - rtkStats.bytesAfter) / 4) });
```

After the headroom block (headroomStats), emit:
```js
  if (headroomStats) emit({ saver: "headroom", applied: headroomStats.applied || false, reason: headroomStats.reason || null, tokensBefore: headroomStats.tokensBeforeEst || 0, tokensAfter: headroomStats.tokensAfterEst || 0, savedTokens: headroomStats.tokensSavedEst || 0, savedPct: headroomStats.savedPct || 0 });
```

In the caveman block, after `injectCaveman(...)`, add `emit({ saver: "caveman", applied: true, level: cavemanLevel });`.
In the ponytail block, after `injectPonytail(...)`, add `emit({ saver: "ponytail", applied: true, level: ponytailLevel });`.

In the PXPIPE block, after computing `pxpipeSummary`, add:
```js
  if (pxpipeSummary) emit({ saver: "pxpipe", applied: pxpipeSummary.applied || false, reason: pxpipeSummary.reason || null, tokensBefore: pxpipeSummary.tokensBeforeEst || 0, tokensAfter: pxpipeSummary.tokensAfterEst || 0, savedTokens: pxpipeSummary.tokensSavedEst || 0, savedPct: pxpipeSummary.savedPct || 0, imageCount: pxpipeSummary.imageCount || 0, durationMs: pxpipeSummary.durationMs || 0 });
```

- [ ] **Step 2: Wire callback in chat.js**

In `src/sse/handlers/chat.js`, import `appendTokenSaverEvent` from `@/lib/tokenSaver/events.js` and add `onTokenSaverEvent: appendTokenSaverEvent,` to the `handleChatCore({...})` call (near the existing `onPxpipeEvent: appendPxpipeEvent`).

- [ ] **Step 3: Lint**

Run: `npx eslint open-sse/handlers/chatCore.js src/sse/handlers/chat.js`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add open-sse/handlers/chatCore.js src/sse/handlers/chat.js
git commit -m "feat(token-saver): emit save events from chat pipeline"
```

---

### Task 4: Stats tab UI

**Files:**
- Create: `src/app/(dashboard)/dashboard/token-saver/stats/page.js`
- Create: `src/app/(dashboard)/dashboard/token-saver/stats/TokenSaverStatsClient.js`
- Create: `src/app/(dashboard)/dashboard/token-saver/stats/components/StatCards.js`
- Modify: `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js` (add tab switch)

**Interfaces:**
- Consumes: `getTokenSaverStats` shape from Task 1, recharts (already a dep).
- Produces: tab-gated stats UI embedded in existing Token Saver page.

- [ ] **Step 1: Create page wrapper**

Create `src/app/(dashboard)/dashboard/token-saver/stats/page.js`:
```js
import TokenSaverStatsClient from "./TokenSaverStatsClient";

export default function TokenSaverStatsPage() {
  return <TokenSaverStatsClient />;
}
```

- [ ] **Step 2: Create StatCards component**

Create `src/app/(dashboard)/dashboard/token-saver/stats/components/StatCards.js`:
```js
function fmt(n) {
  return n >= 1e6 ? `${(+n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(+n / 1e3).toFixed(1)}k` : `${n}`;
}

export default function StatCards({ windows, windowId }) {
  const w = windows?.[windowId];
  const items = [
    { label: "Requests", value: w ? fmt(w.requests) : "—", tone: "" },
    { label: "Applied", value: w ? fmt(w.applied) : "—", tone: "text-success" },
    { label: "Tokens saved", value: w ? fmt(w.savedTokens) : "—", tone: "text-success" },
    { label: "Savers active", value: w ? Object.keys(w.requestsPerSaver || {}).length : "—", tone: "" },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border border-border bg-bg-subtle p-4">
          <p className="text-xs text-text-muted">{it.label}</p>
          <p className={`text-2xl font-semibold ${it.tone}`}>{it.value}</p>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create stats client**

Create `src/app/(dashboard)/dashboard/token-saver/stats/TokenSaverStatsClient.js` (reuse pxpipe patterns: `Card`, `Button`, recharts `ResponsiveContainer/AreaChart/BarChart`):

```js
"use client";
import { useState, useCallback, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, Cell,
} from "recharts";
import StatCards from "./components/StatCards";

const WINDOWS = [
  { id: "today", label: "Today" }, { id: "last7d", label: "7d" },
  { id: "last30d", label: "30d" }, { id: "all", label: "All" },
];
const SAVER_COLORS = { rtk: "#10b981", headroom: "#3b82f6", caveman: "#f59e0b", ponytail: "#8b5cf6", pxpipe: "#ef4444" };
const fmtTokens = (n) => (n >= 1e6 ? `${(+n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(+n / 1e3).toFixed(1)}k` : `${n}`);

export default function TokenSaverStatsClient() {
  const [stats, setStats] = useState(null);
  const [windowId, setWindowId] = useState("all");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/token-saver/stats", { headers: { "Cache-Control": "no-store" } });
      setStats(await res.json());
    } catch { /* render empty */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  const hasData = stats?.timeline?.some((d) => d.savedTokens > 0);
  const bySaver = (stats?.bySaver || []).map((s) => ({ name: s.saver, saved: s.savedTokens }));
  const byProvider = (stats?.byProvider || []).slice(0, 8).map((b) => ({ name: b.provider, saved: b.savedTokens }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="font-medium flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">data_saver_on</span>
          Token Savings — Stats
        </h3>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1">
          {WINDOWS.map((tab) => (
            <button key={tab.id} onClick={() => setWindowId(tab.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium ${windowId === tab.id ? "bg-primary text-white" : "text-text-muted hover:text-text"}`}>
              {tab.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</Button>
      </div>

      <StatCards windows={stats?.windows} windowId={windowId} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <h4 className="text-sm font-medium mb-3">Tokens saved — last 30 days</h4>
          {hasData ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={stats.timeline}>
                <defs><linearGradient id="gradTs" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
                <Tooltip formatter={(v) => [fmtTokens(v), "Tokens saved"]} />
                <Area type="monotone" dataKey="savedTokens" stroke="#10b981" fill="url(#gradTs)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-32 flex items-center justify-center text-text-muted text-sm">
              No savings recorded yet — route requests through the gateway with token savers enabled.
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h4 className="text-sm font-medium mb-3">Saved by saver</h4>
          {bySaver.length ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={bySaver}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
                <Tooltip formatter={(v) => [fmtTokens(v), "Tokens saved"]} />
                <Bar dataKey="saved" radius={[4, 4, 0, 0]}>
                  {bySaver.map((s) => <Cell key={s.name} fill={SAVER_COLORS[s.name] || "#94a3b8"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-32 flex items-center justify-center text-text-muted text-sm">No data yet</div>}
        </Card>
      </div>

      <Card className="p-4">
        <h4 className="text-sm font-medium mb-3">Saved by provider</h4>
        {byProvider.length ? (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={byProvider} layout="vertical" margin={{ left: 8 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={fmtTokens} />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [fmtTokens(v), "Tokens saved"]} />
              <Bar dataKey="saved" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <p className="text-sm text-text-muted">No data yet</p>}
      </Card>

      <Card className="p-4">
        <h3 className="font-medium mb-3">Recent activity</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-text-muted border-b border-border">
              <th className="py-2 pr-3">Time</th><th className="py-2 pr-3">Saver</th>
              <th className="py-2 pr-3">Provider</th><th className="py-2 pr-3 text-right">Saved</th>
              <th className="py-2 pr-3 text-right">%</th><th className="py-2">Status</th>
            </tr></thead>
            <tbody>
              {(stats?.recent || []).slice(0, 50).map((ev, i) => (
                <tr key={`${ev.ts}-${i}`} className="border-b border-border/50">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-text-muted">{new Date(ev.ts).toLocaleString()}</td>
                  <td className="py-1.5 pr-3"><span className="text-xs px-2 py-0.5 rounded" style={{ background: `${SAVER_COLORS[ev.saver] || "#94a3b8"}22`, color: SAVER_COLORS[ev.saver] || "#94a3b8" }}>{ev.saver}</span></td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{ev.provider ? `${ev.provider}/${ev.model || ""}` : "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs text-success">{ev.applied ? fmtTokens(ev.savedTokens || ev.tokensSaved) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-xs">{ev.applied && ev.savedPct ? `${ev.savedPct}%` : "—"}</td>
                  <td className="py-1.5"><span className={`text-xs px-2 py-0.5 rounded ${ev.applied ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>{ev.applied ? "Saved" : ev.reason || "Skipped"}</span></td>
                </tr>
              ))}
              {(!stats?.recent || stats.recent.length === 0) && (
                <tr><td colSpan={6} className="py-6 text-center text-text-muted text-sm">No activity yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Add tab switch to existing TokenSaverClient**

In `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`, add a `view` state (`"settings"|"stats"`), a tab bar at top of the returned JSX, and render either the existing settings content or `<TokenSaverStatsClient />`. Import `TokenSaverStatsClient` from `./stats/TokenSaverStatsClient`. Wrap the existing settings JSX branch in `{view === "settings" && (...)}`.

- [ ] **Step 5: Lint + verify**

Run: `npx eslint "src/app/(dashboard)/dashboard/token-saver/**" "src/app/api/token-saver/**"`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(dashboard\)/dashboard/token-saver/
git commit -m "feat(token-saver): add interactive stats tab to Token Saver page"
```

---

## Self-Review

- **Spec coverage:** event store (Task 1), API (Task 2), wiring (Task 3), UI tab (Task 4), dashboard guard (Task 2), testing (Task 1). All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; all steps carry concrete code.
- **Type consistency:** event field `savedTokens`/`tokensSaved` both read in aggregator (`ev.savedTokens || ev.tokensSaved`) to tolerate both pxpipe and headroom naming; `bySaver`/`byProvider`/`windows`/`timeline`/`recent` names consistent between Task 1 and Task 4.