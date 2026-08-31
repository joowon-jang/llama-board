# P1-5 workflow 권한 경계 최종 검수 — Codex 30차

- 검수일: 2026-08-31
- 검수 범위: `.github/workflows/pr-runtime.yml`, `.github/workflows/release.yml`, README의 trust-boundary/environment 문서
- 검수 원칙: 기존 uncommitted 변경과 source/config를 보존하고 read-only 검증을 수행했다. 이 검수에서 추가한 파일은 이 리포트 하나다.
- 종합 판정: **조건부 통과**

현재 두 workflow의 `permissions`, `needs`, checkout, artifact, provenance, signing, release 경계는 P1-5 acceptance에 맞게 분리되어 있다. 특히 외부 PR CMake build와 release build/test에는 `contents: write` 및 signing secret이 없고, write-capable publish job에는 source/build/package 실행이 없다. 다만 PR package job의 smoke가 PR에서 만들어진 실행 파일을 같은 workspace에서 실행한 뒤 final archive를 업로드하므로, 악성 실행 파일이 `release-assets`를 바꾼 뒤 업로드할 수 있는 잔여 위험이 있어 “trusted package job”이라는 설명은 조건부이며, 환경 보호 규칙은 repository settings에서 별도 구성되어야 한다.

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
|---|---|---|
| PR build 권한/checkout 경계 | 통과 | `pr-runtime.yml:18-36,99-161`; `contents: read`만 있고 trusted `llama-board` checkout/package script/secrets가 없으며 PR source만 CMake로 빌드한다. |
| PR provenance/output 연결 | 통과 | `pr-runtime.yml:37-43,58-121,193-203`; API의 40-hex head SHA를 checkout 후 `git rev-parse`로 재검증하고 `needs.build.outputs`를 package env에 전달한다. |
| PR package trust transfer | 조건부/P1 잔여 | trusted checkout 및 package script 경계는 통과하지만 `pr-runtime.yml:205-243`에서 PR-derived `llama-server.exe`/`llama-bench.exe`를 실행하고 `:245-250`에서 같은 workspace의 archive를 최종 업로드한다. |
| PR publish 경계 | 통과 | `pr-runtime.yml:252-286`; environment와 `contents: write`/`actions: read`만 가진 job이며 artifact download와 GitHub release API action만 실행한다. |
| Release build/test와 publish 분리 | 통과(서명 정책은 조건부) | `release.yml:9-28,30-77,79-142`; build는 read-only unsigned artifact만 만들고 publish만 signing secret/`contents: write`를 가진다. |
| Artifact upload/download 권한 | 통과 | v4 artifact action은 current-run artifact service/runtime token을 사용하므로 `actions: write`가 불필요하며, 두 artifact 이름과 `needs` 연결도 일치한다. |
| Archive/provenance smoke | 통과(검사 범위 명시) | `PR_REPOSITORY`/`PR_COMMIT`가 `needs.build.outputs`에서 smoke step으로 연결되고 bundle manifest의 source repository/commit과 비교된다. 파일 digest 목록을 다시 계산하는 검사는 아니다. |
| Environment protection | 설정 조건부 | YAML의 `environment` 선언은 통과하나 required reviewers/branch rules/secrets는 repository settings에 있어야 한다. README:259도 이 전제만 문서화한다. |
| SHA/YAML/action input 정적 검증 | 통과 | 두 YAML의 js-yaml parse, expression/permission/needs/output/artifact/env assertion, 13개 SHA pin 및 upstream ref 교차 확인이 통과했다. |
| Local gates | 조건부 통과 | npm gate와 Rust fmt/clippy/no-run은 통과했다. full `cargo test`는 test body 실행 전 Windows application-control `os error 4551`로 차단됐다. |

## 2. 실제 workflow/job permissions

GitHub Actions에서 `permissions`를 지정하면 지정하지 않은 token scope는 `none`이 된다. 따라서 아래 표는 workflow/job YAML의 실제 유효 경계를 기준으로 판단했다. 참고: [GitHub workflow syntax — permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

| Workflow/job | workflow/job 선언 | 보안 판정 |
|---|---|---|
| `pr-runtime.yml` workflow | `:18-19` `contents: read` | 기본값을 read-only로 제한한다. |
| PR `build` | `:35-36` `contents: read` | 외부 `ggml-org/llama.cpp` source checkout/CMake/build와 raw upload만 한다. `actions: write`, `contents: write`, signing/release secret이 없다. |
| PR `package` | `:173-174` `contents: read` | `${{ github.sha }}`의 trusted repository를 checkout하고 package script를 실행한다. `contents: write`와 secrets가 없다. |
| PR `publish` | `:259-262` environment `pr-runtime-publish`, `contents: write`, `actions: read` | final artifact를 내려받고 `softprops/action-gh-release`로 release API를 호출한다. source checkout, CMake/build, npm/cargo, package script가 없다. |
| `release.yml` workflow | `:9-10` `contents: read` | release build의 기본 경계를 read-only로 제한한다. |
| Release `build` | `:27-28` `contents: read` | own source의 npm/Rust test/build와 unsigned installer artifact 수집/upload만 한다. signing secrets와 `contents: write`가 없다. |
| Release `publish` | `:86`, `:90-92` environment `release-publish`, `contents: write`, `actions: read` | unsigned artifact download, optional Authenticode signing, checksum 생성, release API만 실행한다. checkout/npm/cargo/CMake/package script가 없다. secrets는 `:99-102`의 publish signing step에만 주입된다. |

`actions: read`는 두 publish job에만 있고 `actions: write`는 어느 job에도 없다. current workflow run의 artifact download에는 별도 `GITHUB_TOKEN` Actions write가 필요하지 않으며, publish의 `actions: read`는 보수적으로 부여된 read-only scope다.

## 3. PR runtime의 trust boundary와 provenance

### Build job

1. `pr-runtime.yml:45-56`에서 workflow-dispatch 입력을 양의 PR 번호와 `cpu`로 제한한다.
2. `:58-97`에서 `api.github.com/repos/ggml-org/llama.cpp/pulls/<number>`를 조회하고 base repository, head repository/ref/author/state, 40-hex head commit을 검증한다. 줄바꿈과 repository 형식도 거부한다.
3. `:99-106`은 `ggml-org/llama.cpp`의 `refs/pull/${{ inputs.pull_request }}/head`만 `llama.cpp` path로 checkout하며 `fetch-depth: 1`, `persist-credentials: false`다.
4. `:108-121`은 실제 checked-out `HEAD`를 `git rev-parse`하고 API output SHA와 비교한다.
5. `:123-154`는 `llama.cpp`에서만 CPU CMake configure/build와 preflight를 실행하고 `:156-161`에서 `pr-runtime-raw-<PR>-<backend>`로 raw runtime을 업로드한다.

이 job은 trusted `llama-board` source/package script를 checkout하거나 실행하지 않고, `contents: write` 및 release/signing secrets에도 접근하지 않는다. raw artifact upload는 package/publish와 분리된 이름을 사용한다.

### Package job

`pr-runtime.yml:163-189`의 `needs: build`와 job-level `contents: read` 뒤에 trusted checkout이 있다. checkout ref는 `${{ github.sha }}`(`:176-183`)이고 path는 `llama-board`이며 credentials는 유지하지 않는다. raw artifact는 `:185-189`에서 `pr-runtime-raw-${{ inputs.pull_request }}-${{ inputs.backend }}`로 download된다.

`:191-203`은 `needs.build.outputs`의 commit/repository/head ref/author/state/fork를 환경 변수로 넘기고, `-SourceRoot 'llama-board' -RuntimeRoot 'runtime-output'`로 trusted package script를 호출한다. script의 explicit `HeadRef` 전달은 detached trusted checkout에서도 provenance fallback이 비어 버리지 않게 하며, package script는 source manifest와 file-level SHA-256 bundle manifest를 archive 안에 쓴다.

`:205-243`의 smoke는 archive를 `RUNNER_TEMP`로 풀고 다음을 확인한다.

- source/bundle manifest 존재
- `manifest.source.repository`와 `manifest.source.commit`이 각각 `PR_REPOSITORY`, `PR_COMMIT`과 일치
- `llama-server.exe`, `llama-bench.exe` 존재
- `--version`, `--help`, `--list-devices`, `llama-bench --help` 성공
- CUDA/HIP/Vulkan 관련 환경 변수 제거

`PR_REPOSITORY`와 `PR_COMMIT`은 같은 package job의 임의 값이 아니라 `needs.build.outputs`에서 직접 연결되어 있으므로 step boundary와 output wiring 자체는 유효하다. 다만 smoke가 file-level manifest의 각 digest를 재계산하거나 archive hash를 smoke 전후 비교하지는 않는다.

### Publish job

`pr-runtime.yml:252-268`의 `needs: package`와 `pr-runtime-publish` environment는 final artifact download까지의 순서를 보장한다. `:270-286`의 유일한 release action은 `release-assets/*.zip`, `.zip.sha256`, `checksums.txt`를 GitHub release로 게시한다. 이 job에는 source checkout, build/package command, npm/cargo/CMake run이 없으므로 write-capable job의 실행면은 acceptance에 맞다.

## 4. Artifact permission과 이름/edge 검증

다음 공식 동작을 기준으로 판정했다.

- [actions/upload-artifact v4.6.2](https://github.com/actions/upload-artifact/tree/v4.6.2)는 runner가 제공하는 artifact service/runtime credential을 사용해 current run artifact를 업로드한다. `actions: write`를 요구하는 repository Actions API 호출이 아니다.
- [actions/download-artifact v4.3.0](https://github.com/actions/download-artifact/tree/v4.3.0)은 기본적으로 current repository/current workflow run artifact를 받는다. 다른 run/repository를 지정할 때만 `github-token`과 `actions: read`가 필요하다.
- v4 artifact는 immutable이므로 raw와 final 이름이 같은 run에서 재사용/덮어쓰기되지 않는다. 현재 workflow의 raw/final 이름은 다음처럼 분리된다.

| Edge | 이름 | 결과 |
|---|---|---|
| PR build upload | `pr-runtime-raw-${{ inputs.pull_request }}-${{ inputs.backend }}` | `package`의 download 이름과 동일 |
| PR package upload | `pr-runtime-${{ inputs.pull_request }}-${{ inputs.backend }}` | `publish`의 download 이름과 동일 |
| Release build upload | `windows-release-assets-unsigned` | release `publish`의 download 이름과 동일 |

각 upload는 `if-no-files-found: error`를 사용한다. 따라서 `actions: write`를 추가하지 않아도 current-run upload/download edge는 GitHub.com Actions artifact backend에서 실행 가능하다. publish job의 `actions: read`는 불필요한 write 권한은 아니지만, same-run 기본 download만 전제하면 최소권한 관점에서 제거 가능한 보수적 read scope다.

## 5. Release unsigned/signing/checksum 경계

`release.yml:30-77`의 build는 own source checkout, Node/Rust setup, npm/Rust verification, NSIS/MSI build, installer와 `install.ps1` 수집, unsigned artifact upload를 담당한다. build token은 `contents: read`뿐이며 signing certificate secret을 받지 않는다.

`release.yml:81-98`의 publish가 unsigned artifact를 download한 뒤 `:99-126`에서 certificate secret이 모두 있을 때만 `.exe`/`.msi`를 Authenticode 서명하고 `Status -eq Valid`를 확인한다. secret이 없으면 `:105-107`에서 warning을 남기고 signing을 skip한다. `:127-136`의 checksum 생성은 signing 이후 현재 `release-assets` 파일(installers와 `install.ps1`)을 이름순으로 SHA-256 hashing하며, 새로 생성하는 `checksums.txt` 자체는 manifest에 포함하지 않는다. `:137-142`는 이 결과를 `release-assets/*`로 publish한다.

따라서 unsigned build → artifact download → optional signing → checksum → release 순서와 checksum의 “실제 게시 bytes” semantics는 보존된다. 다만 certificate가 없어도 `v*` release가 게시되는 동작은 의도적으로 optional이며, README:34-38 및 `:258-262`의 “prefer signed / SHA-256 확인” 및 environment 설정 문서와 일치한다. signature가 정책상 필수라면 아래 findings의 설정 작업이 완료되어야 한다.

## 6. Findings (severity 순)

### P1 / High — PR package smoke가 final artifact 업로드 전 동일 workspace의 PR 실행 파일을 실행함

- 위치: `.github/workflows/pr-runtime.yml:205-243,245-250`
- 영향: smoke가 `RUNNER_TEMP`에 archive를 풀어 실행하지만 실행 파일은 PR이 생성한 binary다. 같은 package runner/workspace의 `release-assets`, `llama-board`, `runtime-output`는 OS 수준에서 별도 read-only 경계가 아니므로 악성 binary가 smoke 중 파일을 바꿀 수 있다. smoke 후에는 final archive/sidecar를 재패키징하거나 archive/file-level digest를 재검증하지 않고 바로 upload한다.
- acceptance 관계: PR build가 `contents: write`를 얻거나 publish가 source/build/package를 실행하는 문제는 이미 해소되어 **좁은 permission acceptance는 통과**한다. 그러나 package job을 “trusted tooling only”로 간주하고 final artifact를 trusted transfer로 보는 보안 모델에는 잔여 위험이며, provenance manifest가 선언하는 source commit과 실제 archive bytes의 연결을 약화시킨다.
- 권고: smoke를 별도 low-trust runner/job에서 수행하고 final artifact를 smoke 이후 trusted runner에서 raw artifact로부터 다시 생성하거나, 최소한 smoke 전후 immutable archive/hash 비교와 재검증을 추가한다. 이 report에서는 source/config를 수정하지 않았다.

### P2 / Medium — release signing은 certificate secret 미구성 시 조용히 optional로 skip됨

- 위치: `.github/workflows/release.yml:99-107,127-142`; README:34-38,258-262
- `WINDOWS_CERTIFICATE_BASE64` 또는 password가 비어 있으면 publish는 실패하지 않고 unsigned installer와 SHA-256 checksum을 게시한다.
- 이는 현재 unsigned artifact → publish 설계와 문서에는 일관되므로 workflow boundary 실패는 아니다. 그러나 `v*` stable release에도 서명이 없을 수 있다는 운영 보안 위험이다.
- signature가 필수이면 environment에서 두 secret을 항상 구성하고, secret 미구성/서명 실패를 hard fail하도록 policy를 정해야 한다. optional 정책이면 release notes와 배포 문서에 unsigned 상태를 명시해야 한다.

### P2 / Medium — environment protection/reviewer/secrets는 YAML 정적 검수로 보장할 수 없음

- 위치: `.github/workflows/pr-runtime.yml:259-262`, `.github/workflows/release.yml:86,90-102`, README:259-262
- 두 publish job은 각각 `pr-runtime-publish`, `release-publish` environment를 참조하지만 required reviewers, allowed branches, wait timer 및 environment secrets의 실제 값은 repository settings에 있다.
- settings에서 protection rule이 구성되지 않으면 job은 자동으로 진행될 수 있고, release signing secret이 없으면 위 P2 동작으로 unsigned publish가 된다.
- [Using environments for deployment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)에 따라 두 environment 모두 required reviewers와 필요한 branch/deployment policy를 실제 repository settings에서 구성하고, 구성 후 승인 대기/secret 주입을 한 번 이상 실행 검증해야 한다.

### P3 / Low — release build checkout의 credential persistence가 명시되지 않음

- 위치: `.github/workflows/release.yml:30-36`
- release build checkout에는 `persist-credentials: false`가 없다. 이 job은 `contents: read`뿐이라 P1-5의 write/secrets 경계를 깨지는 않지만, compromised dependency가 workspace의 read-only checkout credential을 탐색할 노출면을 줄이려면 PR workflow와 같이 명시적으로 false로 두는 편이 안전하다.

## 7. SHA, YAML, expression, action input 검증

두 workflow에서 확인된 `uses:`는 총 13개이며 모두 소문자 40-hex SHA다. upstream ref와 comment를 다음처럼 교차 확인했다.

| Action | Pin | 확인한 ref/comment |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | `v4.4.0` |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` |
| `dtolnay/rust-toolchain` | `4360b52568e2003a75bf9bc1d59f33a8e3fc893c` | stable branch |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `v4.6.2` |
| `actions/download-artifact` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | `v4.3.0` |
| `softprops/action-gh-release` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` | `v2.6.2` |

`js-yaml 4.3.1` parse 결과는 다음과 같다.

```text
.github/workflows/pr-runtime.yml: YAML parse OK jobs=build,package,publish
.github/workflows/release.yml: YAML parse OK jobs=build,publish
```

별도 static assertion으로 jobs/permissions/needs/job outputs, checkout ref, `SourceRoot`, raw/final artifact names, smoke env, release input, signing/checksum/publish steps, expression delimiter balance 및 floating action ref 부재를 검사했고 모두 통과했다. actionlint는 이 환경에 설치되어 있지 않아 js-yaml과 workflow-specific assertion을 fallback으로 사용했다.

## 8. 실행 검증

| 명령 | 결과 |
|---|---|
| YAML parse + workflow static assertions | 통과 |
| `git ls-remote --refs` action pin 교차 확인 | 통과 |
| `git diff --check` | 통과; 기존 dirty 파일의 LF/CRLF 경고만 있었고 whitespace error는 없었다. |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm test` | 통과; direct test harness 24개와 Vitest 18 files/84 tests |
| `npm run build` | 통과; Vite 121 modules transformed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 통과 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | 통과 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --no-run` | 통과; test binaries compile |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 조건부 실패; test body 실행 전 Windows application-control이 test exe를 차단, `os error 4551` |

full cargo test의 4551은 assertion/test failure가 아니라 Windows application-control 정책으로 process가 `never executed` 상태에서 차단된 것이다. 이 로컬 환경 제한은 workflow YAML의 P1-5 판정과 별개로 기록한다.

## 9. 실제 GitHub Actions 실행 가능성 및 남은 설정

현재 workflow는 GitHub.com hosted `windows-latest`/`ubuntu-latest`, Actions artifact backend, API network, 그리고 다음 repository 설정이 전제되면 실행 가능한 구조다.

- `pr-runtime-publish`와 `release-publish` environment를 만들고 required reviewers/branch restrictions 등 보호 규칙을 설정한다.
- release 서명이 필수인 정책이면 `WINDOWS_CERTIFICATE_BASE64`와 `WINDOWS_CERTIFICATE_PASSWORD`를 `release-publish` environment secrets로 구성하고 secret 누락을 허용하지 않는 정책을 정한다.
- PR workflow는 manual dispatch의 PR 번호와 `cpu` 입력을 전제로 하며, `ggml-org/llama.cpp` PR API/checkout에 접근할 수 있어야 한다.
- `actions/upload-artifact@v4`/`download-artifact@v4`는 current-run artifact edge에 적합하지만, 오래된 GHES artifact backend를 대상으로 하는 구성이라면 별도 호환성 확인이 필요하다.

결론적으로 permission/needs/action pin 및 publish write boundary는 **통과**, PR package smoke에 의한 final artifact tamper 가능성과 repository environment 설정은 **남은 조건**, unsigned release는 **문서화된 optional 정책이지만 서명 필수 여부를 운영 설정으로 확정해야 하는 위험**이다. 기존 source/config와 uncommitted 변경은 보존했다.
