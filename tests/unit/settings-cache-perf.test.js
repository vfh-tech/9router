import { describe, it, expect, beforeEach } from "vitest";
import { getSettings, updateSettings, invalidateSettingsCache } from "@/lib/db/repos/settingsRepo.js";
import { getComboByNameCached } from "@/sse/services/model.js";

describe("settingsRepo TTL cache", () => {
  beforeEach(() => invalidateSettingsCache());

  it("returns same object within TTL (cache hit)", async () => {
    const a = await getSettings();
    const b = await getSettings();
    expect(b).toBe(a);
  });

  it("updateSettings invalidates and reflects new value", async () => {
    const before = await getSettings();
    expect(before.rtkEnabled).toBe(true);
    await updateSettings({ rtkEnabled: false });
    const after = await getSettings();
    expect(after.rtkEnabled).toBe(false);
    expect(after).not.toBe(before);
    await updateSettings({ rtkEnabled: true });
  });
});

describe("getComboByNameCached", () => {
  it("returns null for miss, stable across calls", async () => {
    const name = "nocombo-" + Date.now();
    const a = await getComboByNameCached(name);
    const b = await getComboByNameCached(name);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });
});
