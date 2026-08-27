import { describe, expect, it } from "vitest";
import { buildNumber, formatRuntimeVersion } from "./runtimeUtils";

describe("runtime build labels", () => {
  it("strips the b prefix from llama.cpp CI build tags", () => {
    expect(buildNumber("b10638")).toBe("10638");
    expect(buildNumber("b1")).toBe("1");
  });

  it("leaves anything that is not a bNNNN tag alone", () => {
    for (const value of ["system", "", "beta", "b10638-rc1", "10638"]) {
      expect(buildNumber(value)).toBe(value);
    }
  });

  it("prefers the recorded semantic version over the bare build", () => {
    expect(formatRuntimeVersion("b10638", { semver: "0.3.0-dev", build: 10638, commit: "bf9421646" }))
      .toBe("0.3.0-dev · build 10638");
  });

  it("falls back to the build number when no version was recorded", () => {
    expect(formatRuntimeVersion("b10638")).toBe("build 10638");
    expect(formatRuntimeVersion("b10603", null)).toBe("build 10603");
    // A manifest without a usable semver must not render a dangling separator.
    expect(formatRuntimeVersion("b10638", { semver: "", build: 10638, commit: "" })).toBe("build 10638");
  });
});
