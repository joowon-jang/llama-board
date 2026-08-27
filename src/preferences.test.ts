import { describe, expect, it, beforeEach } from "vitest";
import { defaultPreferences, importPreferences, loadPreferences, savePreferences } from "./preferences";

describe("preferences persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips validated preferences through versioned storage", () => {
    const values = { ...defaultPreferences(), locale: "ko" as const, theme: "dark" as const };
    savePreferences(values);
    expect(loadPreferences()).toMatchObject({ locale: "ko", theme: "dark" });
  });

  it("rejects unsupported export envelopes", () => {
    expect(() => importPreferences(JSON.stringify({ schemaVersion: 2, preferences: {} }))).toThrow(/Unsupported/);
  });
});
