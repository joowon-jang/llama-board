import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { createElement } from "react";
import RuntimesPanel from "./Runtimes";
import { I18nProvider } from "../i18n";
import * as api from "../api";
import type { AppStore } from "../store";

vi.mock("../api", () => ({
  rtList: vi.fn(),
  rtLatest: vi.fn(),
  rtInstall: vi.fn(),
  rtInstallPr: vi.fn(),
  rtPrPreview: vi.fn(),
  rtExport: vi.fn(),
  rtImport: vi.fn(),
  rtCancel: vi.fn(),
  rtUninstall: vi.fn(),
  rtSelect: vi.fn(),
  rtProbe: vi.fn(),
  deviceProfile: vi.fn(),
  onRuntimeProgress: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const store = {
  cfg: null,
  status: { state: "stopped" },
  loadConfig: async () => undefined,
} as unknown as AppStore;

const NVIDIA_REPORT = {
  profile: {
    schema_version: 1,
    os: "windows",
    arch: "x86_64",
    cpu: { name: "Test CPU", logical_cores: 8 },
    gpus: [{ vendor: "nvidia", name: "Test GPU", vram_mb: 8192, integrated: false }],
    detection: "test",
    fingerprint: "test-nvidia",
  },
  backends: [
    { backend: "cuda", fit: "recommended", reason: "nvidia" },
    { backend: "vulkan", fit: "compatible", reason: "vulkan" },
    { backend: "cpu", fit: "compatible", reason: "cpu" },
  ],
} satisfies api.DeviceReport;

function renderPanel(active = true) {
  return render(createElement(I18nProvider, { initialLocale: "en", children: createElement(RuntimesPanel, { store, active }) }));
}

/** The cuda row already has the newest release build installed. */
function installedNewestCuda() {
  mocked.rtList.mockResolvedValue([{ backend: "cuda", build: "b10638", dir: "C:/runtimes/cuda-b10638", size_mb: 512 }]);
  mocked.rtLatest.mockImplementation(async (backend: string) => ({
    build: "b10638",
    file_name: `llama-b10638-bin-win-${backend}-x64.zip`,
    url: "https://example.invalid/runtime.zip",
  }));
}

/** The provenance the backend resolves for PR #27342. */
const PREVIEW = {
  pull_request: 27342,
  title: "server: add a thing",
  state: "open",
  draft: false,
  author: "contributor",
  repository: "contributor/llama.cpp",
  head_ref: "feature-branch",
  commit: "0123456789abcdef0123456789abcdef01234567",
  fork: true,
  url: "https://github.com/ggml-org/llama.cpp/pull/27342",
  archive_url: "https://codeload.github.com/contributor/llama.cpp/zip/0123456789abcdef0123456789abcdef01234567",
  updated_at: "2026-08-20T10:00:00Z",
  advisories: ["fork"],
} satisfies api.PullRequestPreview;

/**
 * ConfirmDialog always renders its markup and only calls showModal(), so
 * presence in the DOM proves nothing - the dialog's own open state does.
 */
function confirmDialogOpen() {
  return screen.getByText("Build this pull request?").closest("dialog")?.open === true;
}

/** Step one: type a PR and open the confirmation dialog. */
async function reviewPullRequest(expectedBackend = "cuda") {
  const picker = await screen.findByLabelText("Backend to build");
  await waitFor(() => expect(picker).toHaveValue(expectedBackend));
  const input = await screen.findByLabelText("PR number or URL");
  fireEvent.change(input, { target: { value: "27342" } });
  fireEvent.click(screen.getByRole("button", { name: "Review PR…" }));
  await waitFor(() => expect(confirmDialogOpen()).toBe(true));
}

/** Both steps: review, then confirm, so the build actually starts. */
async function startPullRequestBuild() {
  const picker = await screen.findByLabelText("Backend to build");
  await waitFor(() => expect(picker).toHaveValue("cuda"));
  await reviewPullRequest();
  fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
  await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cuda", "27342", PREVIEW.commit));
}

describe("RuntimesPanel pull-request builds", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    installedNewestCuda();
    mocked.deviceProfile.mockResolvedValue(NVIDIA_REPORT);
    mocked.onRuntimeProgress.mockResolvedValue(() => undefined);
    mocked.rtCancel.mockResolvedValue(undefined);
    mocked.rtExport.mockResolvedValue({
      path: "C:/exports/runtime.zip",
      backend: "cuda",
      build: "b10638",
      archive_sha256: "a".repeat(64),
      bytes: 1024,
    } satisfies api.RuntimeBundleInfo);
    mocked.rtImport.mockResolvedValue({
      build: "pr27342",
      backend: "cpu",
      dir: "C:/runtimes/pr27342-cpu",
      size_mb: 512,
    } satisfies api.InstalledRuntime);
    mocked.rtPrPreview.mockResolvedValue(PREVIEW);
    // A build that never settles keeps the panel in its busy state.
    mocked.rtInstallPr.mockImplementation(() => new Promise(() => undefined));
  });

  it("keeps a working cancel action while a PR build runs on the newest installed backend", async () => {
    renderPanel();
    await screen.findByRole("heading", { name: "Install a llama.cpp PR build" });
    await startPullRequestBuild();

    // The regression: the cuda row hid its button entirely once the newest
    // release build was installed, so a PR build on that row could not be
    // stopped. Both the section and the row must offer a cancel.
    const sectionCancel = await screen.findByRole("button", { name: "Cancel build" });
    const rowCancel = await screen.findByRole("button", { name: "Cancel install" });

    fireEvent.click(rowCancel);
    await waitFor(() => expect(mocked.rtCancel).toHaveBeenCalledTimes(1));
    expect(sectionCancel).toBeInTheDocument();
  });

  it("does not fire a second cancel while the first is still in flight", async () => {
    let releaseCancel: () => void = () => undefined;
    mocked.rtCancel.mockImplementation(() => new Promise<void>((resolve) => { releaseCancel = () => resolve(); }));
    renderPanel();
    await screen.findByRole("heading", { name: "Install a llama.cpp PR build" });
    await startPullRequestBuild();

    const cancel = await screen.findByRole("button", { name: "Cancel build" });
    fireEvent.click(cancel);
    await waitFor(() => expect(mocked.rtCancel).toHaveBeenCalledTimes(1));
    // Both the section and the row button reflect the in-flight cancel.
    const cancelling = await screen.findAllByRole("button", { name: "Cancelling…" });
    expect(cancelling).toHaveLength(2);
    for (const button of cancelling) expect(button).toBeDisabled();
    fireEvent.click(cancelling[0]);
    releaseCancel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel build" })).toBeEnabled());
    expect(mocked.rtCancel).toHaveBeenCalledTimes(1);
  });

  it("offers PR builds for supported source backends and marks unsupported ones", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    const option = (backend: string) => Array.from((picker as HTMLSelectElement).options).find((item) => item.value === backend)!;
    for (const backend of ["cpu", "vulkan", "cuda", "rocm"]) {
      expect(option(backend).disabled, backend).toBe(false);
    }
    for (const backend of ["sycl", "openvino"]) {
      expect(option(backend).disabled, backend).toBe(true);
      expect(option(backend).textContent, backend).toContain("not buildable here");
    }
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("imports a portable runtime without invoking a local build", async () => {
    renderPanel();
    await screen.findByRole("heading", { name: "Portable runtime bundles" });
    fireEvent.click(screen.getByRole("button", { name: "Import runtime ZIP" }));
    await waitFor(() => expect(mocked.rtImport).toHaveBeenCalledTimes(1));
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("offers export for each installed runtime", async () => {
    renderPanel();
    const exportButton = await screen.findByRole("button", { name: /Export runtime: cuda 10638/ });
    fireEvent.click(exportButton);
    await waitFor(() => expect(mocked.rtExport).toHaveBeenCalledWith("cuda", "b10638"));
  });

  it("shows who wrote the code and where it comes from before building it", async () => {
    renderPanel();
    await reviewPullRequest();

    // The PR number the user typed says nothing about any of this, so all of
    // it has to be on screen before they can agree to compile it.
    expect(screen.getByText(PREVIEW.commit)).toBeInTheDocument();
    expect(screen.getByText("contributor")).toBeInTheDocument();
    expect(screen.getByText("contributor/llama.cpp")).toBeInTheDocument();
    expect(screen.getByText("feature-branch")).toBeInTheDocument();
    expect(screen.getByText(/not from ggml-org\/llama\.cpp/)).toBeInTheDocument();
    // Nothing is downloaded or built until the user confirms.
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("discloses when a matching prebuilt PR artifact removes the toolchain requirement", async () => {
    mocked.rtPrPreview.mockResolvedValue({
      ...PREVIEW,
      artifact: {
        name: "llama-board-pr27342-cuda-win-x64.zip",
        sha256: "b".repeat(64),
        bytes: 128 * 1024 * 1024,
      },
    } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();
    expect(screen.getByText(/matching prebuilt artifact is available/)).toBeInTheDocument();
    expect(screen.getByText(/does not need CMake/)).toBeInTheDocument();
  });

  it("builds nothing when the confirmation is dismissed", async () => {
    renderPanel();
    await reviewPullRequest();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirmDialogOpen()).toBe(false));
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("sends the confirmed head commit, not just the PR number", async () => {
    renderPanel();
    await startPullRequestBuild();
    // The backend re-resolves the PR and refuses anything but this commit, so
    // a force-push between the dialog and the build cannot ride in on it.
    expect(mocked.rtInstallPr).toHaveBeenCalledWith("cuda", "27342", PREVIEW.commit);
  });

  it("reports a pull request that cannot be resolved without starting a build", async () => {
    mocked.rtPrPreview.mockRejectedValue(new Error("GitHub API 404"));
    renderPanel();
    const input = await screen.findByLabelText("PR number or URL");
    fireEvent.change(input, { target: { value: "27342" } });
    fireEvent.click(screen.getByRole("button", { name: "Review PR…" }));
    await screen.findByText(/Could not resolve that pull request/);
    expect(confirmDialogOpen()).toBe(false);
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("names every pull request state that changes what the code is", async () => {
    // The backend decides which advisories apply; the dialog must render each
    // of them rather than silently dropping one it has no branch for.
    mocked.rtPrPreview.mockResolvedValue({
      ...PREVIEW,
      state: "closed",
      draft: true,
      advisories: ["draft", "closed", "fork", "no-head-ref"],
    } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();

    expect(screen.getByText(/still a draft/)).toBeInTheDocument();
    expect(screen.getByText(/closed without being merged/)).toBeInTheDocument();
    expect(screen.getByText(/not from ggml-org\/llama\.cpp/)).toBeInTheDocument();
    expect(screen.getByText(/no longer has a head branch/)).toBeInTheDocument();
  });

  it("says a merged pull request is already upstream instead of calling it closed", async () => {
    mocked.rtPrPreview.mockResolvedValue({ ...PREVIEW, state: "merged", advisories: ["merged"] } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();
    expect(screen.getByText(/already been merged upstream/)).toBeInTheDocument();
    expect(screen.queryByText(/closed without being merged/)).not.toBeInTheDocument();
  });

  it("warns about nothing when an ordinary open upstream PR is reviewed", async () => {
    mocked.rtPrPreview.mockResolvedValue({
      ...PREVIEW,
      repository: "ggml-org/llama.cpp",
      fork: false,
      advisories: [],
    } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();
    expect(screen.queryByText(/still a draft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not from ggml-org\/llama\.cpp/)).not.toBeInTheDocument();
    // The build plan is not a warning and is always shown.
    expect(screen.getByText("What gets built")).toBeInTheDocument();
  });

  it("states what the build produces before the user agrees to it", async () => {
    renderPanel();
    await reviewPullRequest();
    expect(screen.getByText(/llama-server and llama-bench targets only/)).toBeInTheDocument();
    expect(screen.getByText(/embedded web UI is disabled/)).toBeInTheDocument();
    expect(screen.getByText(/BoringSSL, libcurl and OpenSSL support are off/)).toBeInTheDocument();
    // The backend is cuda here, so the architecture policy is disclosed too.
    expect(screen.getByText(/LLAMA_BOARD_CUDA_ARCHITECTURES/)).toBeInTheDocument();
    // And so is the fact that one PR keeps one directory.
    expect(screen.getByText(/Installs as pr27342-cuda/)).toBeInTheDocument();
  });

  it("hides the CUDA architecture note for a backend that has no CUDA kernels", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    fireEvent.change(picker, { target: { value: "cpu" } });
    const input = await screen.findByLabelText("PR number or URL");
    fireEvent.change(input, { target: { value: "27342" } });
    fireEvent.click(screen.getByRole("button", { name: "Review PR…" }));
    await waitFor(() => expect(confirmDialogOpen()).toBe(true));
    expect(screen.queryByText(/LLAMA_BOARD_CUDA_ARCHITECTURES/)).not.toBeInTheDocument();
    expect(screen.getByText(/Installs as pr27342-cpu/)).toBeInTheDocument();
  });

  it("binds progress to the confirmed backend when the picker changes", async () => {
    let emitProgress: ((progress: api.DownloadProgress) => void) | undefined;
    mocked.onRuntimeProgress.mockImplementation(async (callback: (progress: api.DownloadProgress) => void) => {
      emitProgress = callback;
      return () => undefined;
    });
    const view = renderPanel();
    await startPullRequestBuild();
    await waitFor(() => expect(emitProgress).toBeTypeOf("function"));

    await act(async () => {
      emitProgress?.({ backend: "cuda", build: "pr27342", phase: "building", received: 50, total: 100 });
    });
    expect(screen.getAllByText("Building")).toHaveLength(2);

    // The picker is disabled during a build in the real UI. Dispatching the
    // change directly still verifies that a stale picker value cannot switch
    // the progress banner away from the backend that was confirmed.
    fireEvent.change(await screen.findByLabelText("Backend to build"), { target: { value: "cpu" } });
    expect(screen.getAllByText("Building")).toHaveLength(2);

    // App models tab navigation by keeping the panel mounted and toggling its
    // active/hidden state. The native listener and build state must survive
    // that transition.
    view.rerender(createElement(I18nProvider, { initialLocale: "en", children: createElement(RuntimesPanel, { store, active: false }) }));
    expect(screen.getAllByText("Building")).toHaveLength(2);

    // A progress event for another backend must not replace the pinned
    // section progress either.
    await act(async () => {
      emitProgress?.({ backend: "cpu", build: "pr27342", phase: "configuring", received: 20, total: 100 });
    });
    expect(screen.getAllByText("Building")).toHaveLength(2);
    expect(screen.queryByText("Configuring")).not.toBeInTheDocument();
  });

  it("uses the picker value that was selected before confirmation", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    fireEvent.change(picker, { target: { value: "cpu" } });
    await reviewPullRequest("cpu");
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cpu", "27342", PREVIEW.commit));
  });

  it("keeps the reviewed backend when the picker changes before confirmation", async () => {
    renderPanel();
    await reviewPullRequest();
    fireEvent.change(await screen.findByLabelText("Backend to build"), { target: { value: "cpu" } });
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cuda", "27342", PREVIEW.commit));
  });

  it("reports which commit a rebuild displaced", async () => {
    mocked.rtInstallPr.mockResolvedValue({
      build: "pr27342",
      backend: "cuda",
      dir: "C:/runtimes/pr27342-cuda",
      size_mb: 512,
      source: { pull_request: 27342, repository: "contributor/llama.cpp", commit: PREVIEW.commit, archive_sha256: "", url: PREVIEW.url },
      replaced: { previous_commit: "fedcba9876543210fedcba9876543210fedcba98", previous_pull_request: 27342 },
    } satisfies api.InstalledRuntime);
    renderPanel();
    await startPullRequestBuild();
    // One directory per PR means the bytes behind an unchanged row name have
    // changed; the short commit that went away has to be named.
    await screen.findByText(/replacing the earlier build of commit fedcba9/);
  });

  it("reports a plain install when nothing was displaced", async () => {
    mocked.rtInstallPr.mockResolvedValue({
      build: "pr27342",
      backend: "cuda",
      dir: "C:/runtimes/pr27342-cuda",
      size_mb: 512,
      source: { pull_request: 27342, repository: "contributor/llama.cpp", commit: PREVIEW.commit, archive_sha256: "", url: PREVIEW.url },
    } satisfies api.InstalledRuntime);
    renderPanel();
    await startPullRequestBuild();
    await screen.findByText(/Installed cuda from llama\.cpp PR #27342\./);
    expect(screen.queryByText(/replacing the earlier build/)).not.toBeInTheDocument();
  });

  it("keeps the confirmation closed and the panel idle after a cancelled build", async () => {
    mocked.rtInstallPr.mockRejectedValue(new Error("runtime install cancelled"));
    renderPanel();
    await reviewPullRequest();
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await screen.findByText(/cancelled/i);
    // A cancelled build is not a failure banner, and it must leave the panel
    // ready for another attempt rather than stuck busy.
    await waitFor(() => expect(confirmDialogOpen()).toBe(false));
    expect(await screen.findByRole("button", { name: "Review PR…" })).toBeEnabled();
  });

  it("surfaces a build failure without clearing the typed pull request", async () => {
    mocked.rtInstallPr.mockRejectedValue(new Error("CMake configuring failed with exit code: 1"));
    renderPanel();
    await startPullRequestBuild();
    await screen.findByText(/CMake configuring failed/);
    // The source stays so the user can fix the toolchain and retry.
    expect(await screen.findByLabelText("PR number or URL")).toHaveValue("27342");
  });
});
