import { describe, expect, it } from "vitest";
import { buildNumber, canBuildPrBackend, defaultPrBackend, defaultPrBackendForDevice, formatRuntimeVersion, isInstallCancellation, PR_BUILD_BACKENDS, runtimeRowAction } from "./runtimeUtils";

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

describe("backend row actions", () => {
  it("always offers cancel while the row is busy", () => {
    expect(runtimeRowAction({ busy: true, newestInstalled: false })).toBe("cancel");
    // A PR build marks the row busy even when the newest release build is
    // already installed; hiding the button there stranded the build.
    expect(runtimeRowAction({ busy: true, newestInstalled: true })).toBe("cancel");
  });

  it("offers an install only when the newest build is missing", () => {
    expect(runtimeRowAction({ busy: false, newestInstalled: false })).toBe("install");
    expect(runtimeRowAction({ busy: false, newestInstalled: true })).toBe("none");
  });
});

describe("install cancellation", () => {
  it("recognises the backend's own cancellation message", () => {
    expect(isInstallCancellation("runtime install cancelled")).toBe(true);
    expect(isInstallCancellation("Error: runtime install cancelled")).toBe(true);
  });

  it("does not mistake a build log that mentions cancelling for a cancellation", () => {
    // A swallowed failure shows as a four-second flash instead of an error the
    // user can read, so this distinction has to be exact.
    expect(isInstallCancellation("CMake building failed with exit code: 1: ninja: build stopped: operation cancelled by user request")).toBe(false);
    expect(isInstallCancellation("the operation was canceled by the remote host")).toBe(false);
    expect(isInstallCancellation("CMake configuring failed with exit code: 1")).toBe(false);
    expect(isInstallCancellation("")).toBe(false);
  });
});

describe("pull request build backends", () => {
  it("accepts only the backends the local builder can honestly produce", () => {
    expect([...PR_BUILD_BACKENDS]).toEqual(["cpu", "vulkan", "cuda", "rocm"]);
    for (const backend of PR_BUILD_BACKENDS) expect(canBuildPrBackend(backend)).toBe(true);
    for (const backend of ["sycl", "openvino", "", "unknown"]) {
      expect(canBuildPrBackend(backend), backend).toBe(false);
    }
  });

  it("falls back to a buildable backend when the preferred one is refused", () => {
    expect(defaultPrBackend("cuda")).toBe("cuda");
    expect(defaultPrBackend("rocm")).toBe("rocm");
  });

  it("chooses a safe PR backend from detected NVIDIA, AMD, Intel, and unknown profiles", () => {
    expect(defaultPrBackendForDevice({ backends: [{ backend: "cuda", fit: "recommended" }] })).toBe("cuda");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "rocm", fit: "recommended" }] })).toBe("rocm");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "sycl", fit: "recommended" }, { backend: "openvino", fit: "recommended" }, { backend: "vulkan", fit: "recommended" }] })).toBe("vulkan");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "unknown", fit: "recommended" }, { backend: "cpu", fit: "recommended" }] })).toBe("cpu");
  });
});
