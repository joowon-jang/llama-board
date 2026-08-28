# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it
privately through the repository's GitHub security advisory flow or contact the
maintainer listed in the repository profile with a minimal reproduction.

Do not include API keys, tokens, passwords, model credentials, or other secrets
in a report. Replace them with `[REDACTED]`.

## Scope

Reports involving runtime archive verification, archive path traversal,
pull-request source-build provenance, process lifecycle, local endpoint
exposure, installer integrity, and Tauri capabilities are in scope.

## Local authentication boundary

The app binds the managed server to loopback and creates a new bearer key for
each server start. The upstream `llama-server` interface currently receives
that key through its command-line API-key option, so another process running as
the same Windows user may be able to observe the key through process
inspection. The key is not intended to protect against same-user local
inspection; it protects the loopback endpoint from unrelated local clients and
is cleared when the server stops. Do not share the local endpoint or key with
other users or applications.

## Prebuilt PR artifacts and portable bundles

A PR runtime can be installed without a local compiler toolchain. The Runtimes
panel accepts a portable ZIP exported by a trusted build machine, and the
repository's manual Windows PR workflow publishes CPU artifacts in a
PR-specific prerelease. The app only accepts an artifact for the current
platform, architecture, backend, and PR build id. It verifies the GitHub asset
SHA-256, the bundle's file-level SHA-256 manifest, the embedded PR repository
and head commit, the required executables, and a clean runtime preflight before
activation. An artifact whose embedded commit does not match the freshly
resolved PR is rejected.

The ZIP is a binary delivery mechanism, not a review or sandbox boundary. The
release workflow and the build machine must be trusted, and the receiving PC
must still provide a compatible GPU driver for GPU runtimes. CMake, a compiler,
Git, and the vendor SDK are not needed on the receiving PC. On Windows export
also collects the MSVC runtime from the installed bundle, Visual Studio
redistributable, or the system redistributable when available; if no copy exists
on the build PC, export stops with an actionable error rather than creating a
bundle that only works by accident. The workflow in this repository publishes
CPU artifacts by default; GPU builds should be exported from a machine with the
relevant SDK and reviewed before transfer.

## Building a pull request from source

Building a llama.cpp pull request compiles and runs code written by whoever
opened that pull request, on your machine, with your user account. Treat it the
way you would treat running any unreviewed program: llama-board makes the
provenance visible, but it cannot make the code safe.

What llama-board does and does not guarantee:

- **The author and source are shown before anything is downloaded.** The
  confirmation dialog names the pull request title, the account that opened it,
  the head repository (which is often a contributor's fork, not
  `ggml-org/llama.cpp`), the head branch, the head commit, and the pull request
  state. Nothing is fetched, extracted, configured or compiled until you
  confirm that dialog.
- **You confirm a commit, not a pull request number.** The build is pinned to
  the head commit shown in the dialog. Before it starts, the backend re-resolves
  the pull request from GitHub and refuses to continue if the head has moved -
  so a branch that is force-pushed, or that receives new commits, between the
  dialog and the build is rejected and has to be reviewed and confirmed again.
  The check runs in the backend against freshly fetched data; it is not
  something the UI can skip.
- **The commit-pinned HTTPS request is the provenance check; the recorded hash
  is an audit record.** GitHub publishes no signature or digest for a source
  archive, so the SHA-256 stored in the runtime's source manifest is computed
  here from the bytes that were downloaded. It records what was built and lets
  two installs be compared - it is **not** independent verification of the
  download. The HTTPS connection protects the transfer, and the app checks that
  the archive GitHub returned actually carries the commit that was requested: a
  codeload archive unpacks into a directory named after the ref in the URL, and
  a tree carrying a different commit is refused rather than built. When the
  archive layout carries no recognisable commit at all, the build fails closed
  with `archive-layout-unrecognised`; no runtime is activated.
- **What is recorded.** Each PR-built runtime keeps a source manifest with the
  pull request number, head repository, head branch, author, state, commit,
  locally computed archive digest, and the result of the commit check, as they
  were at build time. That survives the pull request later being merged,
  closed, force-pushed, renamed, or its fork deleted.
- **The build is kept inside the downloaded archive.** BoringSSL, libcurl and
  OpenSSL support are turned off for PR builds. Those are the options that make
  llama.cpp's CMake fetch further dependencies over Git or HTTPS at configure
  time - code that would be outside the pinned, digest-recorded archive, and
  that would additionally require Git, a Go toolchain, and working network
  access on every machine. llama-board talks to `llama-server` over loopback
  HTTP and manages models itself, so none of it is needed. If a pull request
  still triggers a dependency fetch of its own, the failure is reported with an
  explanation rather than a raw CMake trace.
- **Every PR state that changes what the code is gets named.** Draft, closed,
  merged, a head branch that no longer exists, and a head repository that is not
  `ggml-org/llama.cpp` are each reported in the confirmation dialog. None of
  them refuses the build — each is a legitimate thing to compile — but none of
  them passes by unmentioned either. A pull request that cannot be looked up is
  reported by cause (not found, rate-limited, blocked by a proxy, GitHub
  outage) rather than as a bare HTTP status.
- **Backend dependencies are explicit.** PR builds support `cpu`, `vulkan`,
  `cuda`, and `rocm` when their local compiler/SDK preflight passes. CUDA and
  ROCm SDK runtime libraries are copied beside the staged binaries; GPU driver
  libraries remain host supplied, so ROCm PR builds are explicitly for the
  machine that built them. SYCL and OpenVINO are refused before download because
  their sourced vendor toolchains and runtime packaging are not supported here.

## Child process environment

Every process llama-board starts - `llama-server`, `llama-bench`, and the CMake
build - is launched with a cleared environment and an explicit allowlist, rather
than inheriting the app's own environment. The lists are per platform and cover
what a process needs to start, what CMake and the selected generator and
compiler need, and what SDK discovery needs for each supported backend.

Two consequences worth knowing:

- The build environment includes proxy and TLS-trust variables
  (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and their lowercase forms,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`). Without
  them a build cannot reach anything from behind a corporate proxy. A proxy URL
  of the form `http://user:password@proxy` therefore reaches the CMake process.
  That is your own proxy credential, going only to the build you started.
- Credentials are not passed. Tokens, keys and agent sockets - `GITHUB_TOKEN`,
  `GH_TOKEN`, `SSH_AUTH_SOCK`, cloud and registry credentials, and anything
  whose name reads as a secret - are excluded by construction, and a test
  asserts that no allowlist entry looks like a credential. Git and its
  credential helpers are additionally told never to prompt, so a build cannot
  stall waiting for a password behind a pipe with no terminal.

## Supported versions

The latest release and the default branch receive security fixes. Older
releases may require upgrading before a fix is available.
