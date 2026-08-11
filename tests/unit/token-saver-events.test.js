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