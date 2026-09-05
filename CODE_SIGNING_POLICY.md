# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

This policy describes how the llama-board project builds, reviews, approves, and publishes Windows release artifacts.

## Project

- Project: [llama-board](https://github.com/joowon-jang/llama-board)
- Source repository: <https://github.com/joowon-jang/llama-board>
- License: MIT ([LICENSE](LICENSE))
- Download page: [GitHub Releases](https://github.com/joowon-jang/llama-board/releases)
- Privacy policy: [PRIVACY.md](PRIVACY.md)
- Security reports: [SECURITY.md](SECURITY.md)

llama-board is an actively maintained, released, open-source Windows desktop application for managing llama.cpp runtimes, models, local servers, chat, and benchmarks. It is not a malware, potentially unwanted program, exploit, vulnerability-scanning, or security-bypass tool.

The project team maintains this repository, its source files, build scripts, release workflow, installer script, and application artifacts. Third-party llama.cpp runtime files may be downloaded or included as upstream artifacts; they are not signed as llama-board binaries with the project certificate.

## Roles and members

- Authors and committers: `@joowon-jang`, the repository owner and project maintainer.
- Reviewers: `@joowon-jang` reviews every change proposed by a non-committer before it is merged.
- Approver: `@joowon-jang` approves each production signing request after checking the source revision, CI result, version, and release contents.

All project members must use multi-factor authentication for GitHub and SignPath access. If the project team grows, this document and the GitHub access groups will be updated before new signing roles are used.

The repository includes [CODEOWNERS](.github/CODEOWNERS) for the signing policy, CI workflow, artifact configuration, and privacy-policy changes. GitHub branch protection must require pull-request and Code Owner review on `main` before the Foundation signing policy is activated.

## Build and signing process

1. A version change is merged to `main` through the protected review process. The version must match in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, and `src-tauri/tauri-cli-build.conf.json`.
2. GitHub-hosted GitHub Actions runners run the project tests, type checks, lint, Rust checks, and Windows NSIS/MSI packaging.
3. The build job uploads the unsigned installers and `install.ps1` as a GitHub Actions artifact. The signing job does not build source code and receives no certificate private key.
4. After SignPath Foundation onboarding, the signing job submits that immutable GitHub Actions artifact to the `release-signing` policy. SignPath trusted-build and origin verification must be enabled for the project repository and `main` branch.
5. Every production release requires manual approval by the Approver in SignPath. Only the returned signed artifacts are published to the GitHub release, together with `checksums.txt`.
6. The published release links back to this policy and states the signing mode. Any transitional unsigned release is explicitly marked and is not considered a SignPath Foundation release.

The workflow uses the SignPath GitHub Action and the artifact configuration at [.signpath/artifact-configurations/windows-release.xml](.signpath/artifact-configurations/windows-release.xml). It signs the top-level NSIS installer, MSI installer, and PowerShell installer script. The artifact configuration requires the product name `llama-board` and passes the synchronized release version to the signed PE metadata.

## User privacy and system changes

See [PRIVACY.md](PRIVACY.md). The application is local-first and does not send telemetry or usage reports by default. Network requests are made only when the user starts a feature or configures a service, such as GitHub/llama.cpp runtime discovery, Hugging Face model discovery/download, or a user-selected LLM/MCP endpoint.

The Windows installer installs the application and registers the normal Windows uninstall entry. Runtime and model files are downloaded or removed only through user-requested actions in the application. No system security settings or background service are installed by llama-board.

Users can uninstall llama-board from Windows **Settings → Apps → Installed apps → llama-board → Uninstall**, or from **Control Panel → Programs and Features**. Application data and downloaded models/runtimes are user-managed data and may require separate removal from the configured folders.

## Verification

Before installing, users should download the installer from the same GitHub release, compare its SHA-256 value with `checksums.txt`, and check its Authenticode signature in Windows:

```powershell
(Get-FileHash -LiteralPath .\llama-board_*_x64-setup.exe -Algorithm SHA256).Hash.ToLowerInvariant()
(Get-AuthenticodeSignature -LiteralPath .\llama-board_*_x64-setup.exe).Status
```

See [docs/INSTALL.md](docs/INSTALL.md) for the complete verification and installation instructions.

