import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

let BASE_DIR = path.join(DATA_DIR, "token-saver"); // override via _setDir in tests
const METADATA_ONLY = true; // events never carry request bodies or tool content

const EVENTS_FILE = () => path.join(BASE_DIR, "events.jsonl");
const ROTATED_FILE = () => path.join(BASE_DIR, "events.jsonl.1");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function _setDir(dir) { BASE_DIR = dir; }

function ensureDir() {
  if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
}

// Fire-and-forget: token-saver stats must never break the request path.
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
  w.savedPct = w.savedTokens > 0 ? 100 : 0;
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