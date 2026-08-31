# P1-5 PR smoke 격리 최종 검수 — Codex 32차

- 검수일: 2026-08-31 (Asia/Seoul)
- 검수 범위: `.github/workflows/pr-runtime.yml`, `.github/workflows/release.yml`, README trust-boundary 설명
- 검수 원칙: 검수 전부터 존재한 uncommitted 변경 및 source/config를 보존했다. 검수에서 새로 작성한 파일은 이 리포트 하나이며 workflow, README, source/config는 수정하지 않았다.
- 종합 판정: **조건부 통과** — 이전 P1 smoke/artifact 경계는 해결됐고, P2 운영 설정과 P3 release checkout hardening은 잔여다.

## 1. 판정 요약

| 항목 | 판정 | 근거 |
|---|---|---|
| PR 외부 source build 경계 | 통과 | `pr-runtime.yml:22-161`; `build`는 `ggml-org/llama.cpp` PR만 checkout/CMake/build하고 raw artifact를 올린다. trusted `llama-board` checkout/package script와 release/signing secret은 없다. |
| PR package trusted checkout/provenance | 통과 | `pr-runtime.yml:163-213`; `github.repository`의 `${{ github.sha }}`를 `llama-board` 경로로 checkout하고 raw artifact만 trusted script로 패키징한다. `PR_REPOSITORY`/`PR_COMMIT` 등 metadata는 `needs.build.outputs`에서 전달된다. package는 PR-derived executable을 실행하지 않는다. |
| PR isolated smoke | 통과(검사 범위 명시) | `pr-runtime.yml:215-277`; `permissions: {}`인 별도 Windows job이 package가 먼저 올린 final artifact의 다운로드 copy를 `RUNNER_TEMP`에 풀어 실행하고, copy/temporary tree만 삭제한다. |
| PR publish boundary | 통과 | `pr-runtime.yml:279-313`; `needs: smoke` 뒤 새 runner에서 final artifact를 다시 다운로드하고, `softprops/action-gh-release`만 호출한다. source checkout, CMake/build, npm/cargo, package script, smoke workspace 재사용이 없다. |
| Artifact edge/immutable semantics | 통과 | raw/final 이름이 분리되고 final upload가 smoke 전에 완료된다. `upload-artifact@v4` artifact는 immutable이며 smoke와 publish는 서로 다른 runner에서 같은 current-run artifact를 독립 다운로드한다. |
| Release build → publish 분리 | 통과(서명 정책은 조건부) | `release.yml:16-77` build는 own source의 검증/installer 생성과 unsigned artifact upload만, `:79-142` publish만 signing secret/`contents: write`와 release API를 가진다. |
| Source/bundle manifest 및 binary preflight | 부분 통과(범위 명시) | smoke `:252-258`은 두 manifest의 존재를 확인하고 bundle manifest의 `source.repository`/`source.commit`을 `needs.build.outputs` 값과 비교한다. `:260-274`에서 server/bench 존재 확인 및 네 가지 preflight를 실행한다. source manifest를 JSON으로 읽어 bundle manifest와 field-by-field 비교하거나 file digest/zip sidecar를 재계산하는 검사는 없다. |
| README trust boundary | 통과 | `README.md:246-259`가 PR build/read-only package/permission-less smoke/final publish 경계와 두 environment 설정 전제를 설명한다. |
| YAML/action static validation | 통과 | js-yaml parse 및 workflow-specific assertions 통과, actionlint는 설치되지 않아 fallback을 사용했다. 두 workflow의 14개 `uses` 모두 40-hex SHA이며 release/tag ref와 원격 교차 확인했다. |
| Local gates | 조건부 통과 | npm 및 Rust compile/static gates는 통과했다. full `cargo test`는 test body 전에 Windows application-control `os error 4551`로 차단됐다. |

## 2. Effective permissions, secrets, environment

GitHub workflow syntax에 따라 명시한 permission 외 scope는 `none`이 되며, job-level `permissions`가 workflow-level 설정을 덮어쓴다. `permissions: {}`는 모든 `GITHUB_TOKEN` scope를 비활성화한다. 참고: [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

| Workflow/job | Effective YAML permissions | 확인 내용 |
|---|---|---|
| `pr-runtime.yml` workflow | `contents: read` | workflow 기본값이며 job별 경계를 다시 명시한다. |
| PR `build` | `contents: read` | 외부 PR checkout/CMake/build/raw upload만 수행. `contents: write`, `actions: write`, signing/release secret 없음. |
| PR `package` | `contents: read` | trusted checkout/package와 raw download/final upload만 수행. PR binary 실행 없음. |
| PR `smoke` | `{}` | `GITHUB_TOKEN` write/read scope 없음. checkout, source/build/package/release API 없음; current-run artifact download만 수행. |
| PR `publish` | `contents: write`, `actions: read` | release API에 필요한 write는 이 job에만 있다. `actions: write`는 없고 source/build/package 실행도 없다. `actions: read`는 read-only scope다. |
| `release.yml` workflow | `contents: read` | build의 기본값. |
| Release `build` | `contents: read` | own source 검증/installer build/unsigned artifact upload. signing secret과 `contents: write` 없음. |
| Release `publish` | `contents: write`, `actions: read` | unsigned artifact download, optional signing/checksum, release API만 수행. |

Secrets/environment 정적 결과:

- `pr-runtime.yml`에는 `secrets.*` 참조가 없고 `environment`는 publish의 `pr-runtime-publish` 하나다(`:286`).
- `release.yml`의 build에는 secret 참조가 없고, 두 certificate secret은 publish의 signing step에만 주입된다(`:99-102`). publish environment는 `release-publish`다(`:86`).
- `actions: read`는 publish jobs에만 있고 어느 job에도 `actions: write`가 없다.
- required reviewers, allowed branches/tags, wait timer, self-review 방지, 실제 environment secret 값은 YAML로 보장되지 않는 repository settings다. GitHub는 environment protection rules가 통과하기 전 environment job을 runner에 보내지 않고 environment secret을 공개하지 않는다. 참고: [deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## 3. PR runtime trust boundary

### Build job: external PR source만 실행

`pr-runtime.yml:45-97`은 workflow input을 양의 decimal PR 번호와 `cpu`로 제한하고, GitHub API에서 base repository, head repository/ref/author/state, 40-hex head commit을 확인한다. `:99-106`은 고정된 `ggml-org/llama.cpp`의 `refs/pull/${{ inputs.pull_request }}/head`를 `llama.cpp` 경로에 `fetch-depth: 1`, `persist-credentials: false`로 checkout한다. `:108-121`은 실제 checkout `git rev-parse HEAD`가 API에서 확인한 commit과 같은지 재검증한다.

`pr-runtime.yml:123-154`의 CMake source는 `llama.cpp`뿐이고 tests/examples/UI/BoringSSL/CURL/OpenSSL을 끈 CPU build로 `llama-server`와 `llama-bench`만 생성한다. build tree의 server/bench에 대해 `--version`, `--help`, `--list-devices`, `llama-bench --help` preflight가 raw upload 전에 실제 실행된다. `:156-161`은 결과를 `pr-runtime-raw-${{ inputs.pull_request }}-${{ inputs.backend }}`로 upload한다.

이 job에서 PR CMake가 같은 runner의 파일을 바꾸더라도 영향 대상은 의도적으로 untrusted build workspace/raw artifact뿐이다. job에는 trusted `llama-board` checkout/package script와 release/signing secret이 없고 `contents: read` 외 write scope가 없다.

### Package job: trusted source와 raw artifact를 결합하되 PR code는 실행하지 않음

`pr-runtime.yml:179-186`은 `${{ github.repository }}`의 `${{ github.sha }}`를 `llama-board`에 checkout하고 `persist-credentials: false`를 사용한다. `:188-192`은 raw artifact를 `runtime-output`에 다운로드한다. `:194-206`은 `needs.build.outputs`의 `commit`, `repository`, `head_ref`, `author`, `state`, `fork`를 trusted `package-pr-runtime.ps1`에 명시적으로 전달하고 `-SourceRoot 'llama-board' -RuntimeRoot 'runtime-output'`로 호출한다.

package script는 raw runtime 파일을 copy하고 source manifest 및 file-level bundle manifest를 생성할 뿐, raw `llama-server.exe`/`llama-bench.exe`를 실행하지 않는다. `:208-213`에서 script 결과만 `pr-runtime-${{ inputs.pull_request }}-${{ inputs.backend }}` final artifact로 upload한다. 따라서 PR-derived executable은 final artifact가 immutable backend에 올라간 뒤 별도 smoke job에서만 실행된다.

### Smoke job: final artifact의 별도 copy만 실행

`pr-runtime.yml:217-237`의 smoke는 build/package 성공 후 `permissions: {}`로 실행되고 final artifact를 `release-assets`에 다운로드한다. `:245-251`은 그 ZIP을 고유한 `RUNNER_TEMP` 하위 directory에 압축 해제한다. 이 job은 repository checkout이나 trusted package/release command를 실행하지 않는다.

`pr-runtime.yml:252-258`은 `llama-board-runtime-source.json` 및 `llama-board-runtime-bundle.json` 존재를 확인하고 bundle manifest를 JSON으로 parse한 뒤 `manifest.source.repository`와 `manifest.source.commit`을 각각 `PR_REPOSITORY`/`PR_COMMIT`과 비교한다. 이 두 env 값은 `:241-243`의 `${{ needs.build.outputs.repository }}`/`${{ needs.build.outputs.commit }}`에서 직접 연결된다. `:260-274`는 추출된 `llama-server.exe`/`llama-bench.exe` 존재 및 `--version`, `--help`, `--list-devices`, `llama-bench --help` 성공을 확인하고 GPU SDK 환경 변수를 지운다. `:275-277`은 smoke temporary tree를 정리한다.

현재 smoke는 source manifest의 JSON을 다시 읽어 bundle manifest와 완전 비교하지 않으며, bundle `files[]`의 digest를 재계산하거나 ZIP/`.sha256`/`checksums.txt` sidecar를 검증하지 않는다. 이는 현재 P1 acceptance의 runner/artifact isolation과는 별개인 검사 범위다. 최종 소비자 import 경로는 `src-tauri/src/runtime.rs`에서 bundle/source equality와 file digest를 검증하지만, 이 workflow smoke가 앱 import path를 실행하는 것은 아니다.

### Publish job: smoke 이후 독립 download와 release API만 수행

`pr-runtime.yml:281-295`의 publish는 `needs: smoke`, `environment: pr-runtime-publish` 뒤에 새 `ubuntu-latest` runner에서 final artifact를 `release-assets`로 다시 다운로드한다. smoke runner의 workspace나 `RUNNER_TEMP` 경로를 공유하지 않는다. `:297-313`의 유일한 실행 action은 pinned `softprops/action-gh-release`이며 ZIP, ZIP sidecar, `checksums.txt`만 release asset으로 전달한다.

`actions/upload-artifact@v4`는 upload 후 immutable archive를 만들며 동일 artifact name의 후속 upload/append는 허용되지 않는다. raw와 final upload 이름은 다르고, final 이름은 package가 한 번 upload한 뒤 smoke와 publish가 읽는다. `actions/download-artifact`에 `github-token`, `repository`, `run-id` override가 없으므로 두 download 모두 current workflow run artifact를 대상으로 한다. 따라서 smoke 실행 파일이 자신의 `release-assets` ZIP 또는 임시 압축 해제 copy를 변조해도 server-side final artifact ID/bytes와 publish가 새로 받은 copy에는 영향이 없다. 참고: [upload-artifact v4](https://github.com/actions/upload-artifact), [artifact toolkit permissions and immutability](https://github.com/actions/toolkit/blob/main/packages/artifact/README.md), [download-artifact current-run behavior](https://github.com/actions/download-artifact).

Artifact edge는 다음과 같다.

| Edge | Upload | Download | 판정 |
|---|---|---|---|
| PR raw | `build:156-161`, `pr-runtime-raw-${{ inputs.pull_request }}-${{ inputs.backend }}` | `package:188-192`, 동일 이름 | 통과; untrusted build → trusted package input |
| PR final | `package:208-213`, `pr-runtime-${{ inputs.pull_request }}-${{ inputs.backend }}` | `smoke:233-237` 및 `publish:291-295`, 동일 이름 | 통과; immutable final artifact를 두 runner가 독립 read |
| Release unsigned | `release.yml:72-77`, `windows-release-assets-unsigned` | `release.yml:94-98`, 동일 이름 | 통과; build → publish artifact handoff |

## 4. Release unsigned/signing/checksum semantics

`release.yml:16-77`의 build는 own repository checkout, pinned Node/Rust setup, `npm test`, typecheck, frontend build, Rust fmt/clippy/test, NSIS/MSI build를 수행한 뒤 `.exe`/`.msi`와 `install.ps1`을 `release-assets`로 모아 `windows-release-assets-unsigned`에 upload한다. signing secret이나 `contents: write`는 이 job에 없다.

`release.yml:79-98`의 publish는 `needs: build`, `environment: release-publish` 뒤 unsigned artifact를 새 Windows runner에 다운로드한다. `:99-126`은 두 certificate secret이 모두 있을 때만 PFX를 만들고 `.exe`/`.msi` 각각에 SHA-256 Authenticode signing 및 `Get-AuthenticodeSignature`의 `Valid` 확인을 한다. secret이 하나라도 없으면 `:105-107`에서 warning을 남기고 signing을 skip한다.

`:127-136`의 checksum은 signing 이후 현재 `release-assets` 파일(installers와 `install.ps1`)을 이름순으로 SHA-256 hashing해 `checksums.txt`를 만든다. 새 `checksums.txt` 자체는 생성 전 목록에 포함되지 않는다. `:137-142`는 기존 asset semantics를 유지한 채 `release-assets/*` 전체를 release API에 전달한다. publish에는 checkout/npm/cargo/CMake/package script가 없고, artifact download → optional signing → checksum → release 순서만 있다.

README `:258-259`는 signed installer가 signing configuration에 의존하고 미구성 시 SHA-256 확인을 권장한다는 점 및 build/publish trust boundary를 설명한다. 따라서 현재 optional-signing 동작은 문서와 일치하지만, stable release 서명이 보안 정책상 필수라면 아래 P2 설정을 완료해야 한다.

## 5. Findings (severity 순)

### P2 / Medium — release signing은 certificate secret 미구성 시 unsigned publish를 허용함

- 위치: `.github/workflows/release.yml:99-107,120-142`; `README.md:258`
- `WINDOWS_CERTIFICATE_BASE64` 또는 `WINDOWS_CERTIFICATE_PASSWORD`가 비어 있으면 publish는 실패하지 않고 Authenticode signing을 건너뛴 뒤 checksum과 GitHub release를 계속한다.
- 이는 현재 unsigned artifact → optional signing → checksum → publish 설계 및 README와는 일관되지만, `v*` release가 unsigned 상태로 게시될 수 있는 운영 보안 위험이다.
- 서명이 필수인 정책이면 `release-publish` environment에 두 secret을 항상 구성하고, 누락/서명 실패를 hard-fail하는 정책을 운영에서 확정해야 한다. 이번 검수에서는 workflow/config를 수정하지 않았다.

### P2 / Medium — environment protection/reviewer/secrets 구성은 YAML 정적 검수로 보장할 수 없음

- 위치: `.github/workflows/pr-runtime.yml:279-289`; `.github/workflows/release.yml:79-102`; `README.md:259`
- 두 publish job의 `pr-runtime-publish`/`release-publish` environment 선언은 확인되지만 required reviewers, allowed branches/tags, wait timer, self-review 방지 및 실제 environment secrets 값은 repository settings에 있다.
- 보호 규칙이 없으면 release-writing job이 자동 진행될 수 있고, `release-publish` secret이 없으면 위 P2 동작으로 unsigned publish가 된다.
- 두 environment에 required reviewer와 적절한 branch/tag restriction을 설정하고, 승인 대기 및 secret 주입이 실제로 발생하는지 한 번 이상 운영 검증해야 한다. 이번 검수에서는 설정을 변경하지 않았다.

### P3 / Low — release build checkout에 `persist-credentials: false`가 명시되지 않음

- 위치: `.github/workflows/release.yml:30-31`
- pinned `actions/checkout`의 기본 동작은 token credential을 local git config에 persist하는 것이다. release build token은 `contents: read`뿐이라 P1-5 write/secrets 경계를 깨지는 않지만, compromised npm/cargo/build dependency가 workspace의 read-only checkout credential을 탐색할 노출면이 남는다.
- PR build/package checkout처럼 `persist-credentials: false`를 명시하는 것이 권장된다. 이번 검수에서는 workflow를 수정하지 않았다. 참고: [actions/checkout v4 README](https://github.com/actions/checkout/blob/main/README.md).

### Non-finding / 검사 범위 제한 — smoke의 manifest 검증은 비대칭임

source manifest 파일의 존재는 확인하지만 그 JSON을 bundle manifest와 비교하지 않고, bundle `files[]` digest 및 ZIP sidecar를 재계산하지 않는다(`pr-runtime.yml:252-258`). 현재 trusted package script가 두 manifest를 같은 source object에서 생성하고 final artifact가 smoke 전에 immutable upload되므로 P1 isolation failure로 분류하지 않았지만, end-to-end manifest/digest 검증을 workflow acceptance에 포함하려면 별도 hardening이 필요하다.

## 6. YAML, expression, action pin static validation

`js-yaml` fallback parse 결과:

```text
.github/workflows/pr-runtime.yml: YAML parse OK jobs=build,package,smoke,publish
.github/workflows/release.yml: YAML parse OK jobs=build,publish
```

Workflow-specific assertion에서 다음을 확인했고 모두 통과했다.

- top-level/job-level effective permissions 및 `smoke: permissions: {}`
- PR job `needs`: `package <- build`, `smoke <- [build, package]`, `publish <- smoke`
- release `publish <- build`
- build outputs와 package/smoke의 `needs.build.outputs` wiring
- trusted checkout `${{ github.repository }}` + `${{ github.sha }}` 및 PR checkout `ggml-org/llama.cpp` + `refs/pull/.../head`
- raw/final/release artifact names와 upload/download edge
- package no-PR-executable assertion, smoke manifest/preflight commands, release signing/checksum/publish sequence
- `${{ ... }}`/`}}` delimiter balance 및 floating action ref 부재

actionlint executable은 이 runner에 설치되어 있지 않아 js-yaml + workflow-specific assertion을 사용했다. 두 workflow의 `uses:`는 14회이며 모두 immutable 40-hex SHA다. 고유 action pin은 다음과 같다.

| Action | SHA | Ref 교차 확인 |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | `refs/tags/v4.4.0` |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `refs/tags/v4.4.0` |
| `dtolnay/rust-toolchain` | `4360b52568e2003a75bf9bc1d59f33a8e3fc893c` | `refs/heads/stable` |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `refs/tags/v4.6.2` |
| `actions/download-artifact` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | `refs/tags/v4.3.0` |
| `softprops/action-gh-release` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` | `refs/tags/v2.6.2` |

## 7. 실행 검증

| 명령 | 결과 |
|---|---|
| js-yaml parse + workflow-specific assertions | **통과**; jobs/permissions/needs/outputs/artifact names/secrets/environment/preflight/action pins/expression balance 확인 |
| `git ls-remote --refs` action pin 교차 확인 | **통과**; 6개 고유 action ref 모두 expected SHA와 일치 |
| `git diff --check` | **통과**; 기존 dirty 파일의 LF→CRLF 경고만 있고 whitespace error 없음 |
| `npm run typecheck` | **통과**, exit 0 |
| `npm run lint` | **통과**, exit 0 |
| `npm test` | **통과**, exit 0; direct harness와 Vitest 18 files/84 tests passed. jsdom canvas `getContext()` warning 2회는 비치명적 |
| `npm run build` | **통과**, exit 0; Vite 121 modules transformed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **통과**, exit 0 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **통과**, exit 0 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --no-run` | **통과**, exit 0; test executables compile/list됨 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **환경 조건부 실패**, exit 1; 첫 lib test executable이 실행되기 전에 Windows application-control 정책으로 차단됨 (`os error 4551`, `never executed`) |

full `cargo test` 실패는 Rust assertion/test failure가 아니다. Cargo가 test profile과 실행 파일 생성을 완료한 뒤 첫 test process를 시작하는 순간 로컬 Windows application-control policy가 차단했다. `fmt`, `clippy`, `--no-run`은 같은 pinned toolchain에서 통과했으며, 이 제한은 workflow P1-5 판정과 별개인 로컬 실행 환경 제한으로 분류한다.

검수 전 `git status --short`에는 workflow/README/package/Rust/frontend/test source의 기존 modified 및 untracked 변경이 다수 있었고, 검수 중 그 변경을 되돌리거나 수정하지 않았다. 최종 상태 확인에서도 해당 기존 dirty paths를 보존했다.

## 8. 남은 운영 작업

- `pr-runtime-publish`와 `release-publish` environment를 repository settings에서 생성/확인하고 required reviewers, branch/tag restriction, wait timer 및 self-review 정책을 구성한다.
- release signing이 필수이면 `release-publish` environment secrets에 `WINDOWS_CERTIFICATE_BASE64`/`WINDOWS_CERTIFICATE_PASSWORD`를 구성하고 누락 시 publish를 허용하지 않는 policy를 확정한다. optional이면 release notes/배포 문서에 unsigned 가능성을 계속 명시한다.
- `.github/workflows/release.yml:30-31` release build checkout의 credential persistence hardening은 후속 변경으로 남긴다.
- GitHub.com hosted runner와 current-run artifact backend 전제를 유지한다. `actions/upload-artifact@v4`/`download-artifact@v4`는 오래된 GHES artifact backend에서는 별도 호환성 검토가 필요하다.

결론: 이전 P1 finding인 “package가 final artifact 업로드 전에 PR executable을 실행하고 smoke workspace를 publish하는 위험”은 **해결**됐다. 현재 판정은 P2 signing/environment 운영 설정과 P3 release checkout credential persistence, 그리고 로컬 full cargo test 실행 제한을 조건으로 한 **conditional pass**다.
