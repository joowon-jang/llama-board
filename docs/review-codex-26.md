# P1-9 toolchain pinning 최종 검수 — Codex 26차

- 검수일: 2026-08-31
- 검수 원칙: 기존 uncommitted 변경과 source/config를 보존하고 read-only 검증을 수행했다. 새로 추가한 산출물은 이 리포트 하나뿐이다.
- 검수 대상: `.node-version`, `package.json`, `rust-toolchain.toml`, `src-tauri/Cargo.toml`, `.github/workflows/{ci,release,pr-runtime}.yml`, `README.md`
- 종합 판정: **조건부 통과** — P1-9의 Node/Rust 선언과 immutable action SHA는 모두 일관되고 upstream ref와 일치한다. npm 및 Rust 정적/컴파일 gate는 통과했지만, 이 Windows sandbox에서는 application-control 정책이 test exe 실행을 차단하여 full `cargo test` 결과만 직접 확인할 수 없었다. 이 환경 제한과 별도로, 기존 release/PR runtime의 build 권한 경계(P1-5) 및 문서/버전 강제력 보강(P2)을 남긴다.

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| Node 선언 일관성 | 통과 | `.node-version:1`=`22.23.2`; `package.json:6-10`의 `engines.node`/`engines.npm` 및 `packageManager`가 `22.23.2`/`12.0.2`와 일치한다. |
| Rust 선언 일관성 | 통과 | `rust-toolchain.toml:1-3`의 channel=`1.98.0`, `src-tauri/Cargo.toml:7-8`의 `rust-version`=`1.98.0`, CI/release의 dtolnay input이 모두 같다. |
| GitHub Actions SHA pin | 통과 | 세 workflow의 14개 `uses:`가 모두 소문자 40-hex SHA이며 trailing comment와 `git ls-remote` upstream tag/branch ref가 일치한다. |
| YAML/cache/permissions | 통과(구성) | `js-yaml` parse가 세 파일 모두 성공했다. `setup-node` 3개가 `.node-version` 및 `cache: npm`을 사용하고, workflow/job permissions가 명시돼 있다. |
| PR runtime dual checkout/artifact/release | 통과(구성), P1-5 잔여 | trusted repository checkout과 PR source checkout, commit 재검증, upload/download/release 순서는 보존된다. 다만 untrusted CMake build와 `actions: write`/trusted packaging이 한 job에 있어 경계 분리는 별도 P1-5다. |
| npm gate | 통과 | `npm ci --ignore-scripts --dry-run`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`가 모두 exit 0이다. |
| Rust gate | 조건부 통과 | `cargo fmt`, `cargo clippy`, `cargo build`, `cargo test --no-run`은 통과했다. full `cargo test`는 test exe가 os error 4551로 차단됐다. |
| whitespace/worktree 보존 | 통과 | `git diff --check` exit 0. 검수 중 source/config를 수정하지 않았고 report만 추가했다. |

## 2. Toolchain 선언 교차 검증

### Node/npm

현재 선언은 다음과 같다.

| 위치 | 값 | 판정 |
| --- | --- | --- |
| `.node-version:1` | `22.23.2` | 통과 |
| `package.json:6-8` `engines.node` | `22.23.2` | 통과 |
| `package.json:8` `engines.npm` | `12.0.2` | 통과 |
| `package.json:10` `packageManager` | `npm@12.0.2` | 통과 |
| `.github/workflows/ci.yml:22-25,51-54` | `node-version-file: ".node-version"`, `cache: npm` | 통과 |
| `.github/workflows/release.yml:26-29` | `node-version-file: ".node-version"`, `cache: npm` | 통과 |

읽기 전용 static assertion으로 `.node-version`, package JSON의 세 값, workflow setup-node occurrences를 함께 비교했다. CI에는 setup-node가 frontend/rust 두 job에 각각 있고 release에 하나 있어 총 3개이며, pr-runtime에는 Node 명령이 없고 trusted PowerShell packaging/CMake만 수행하므로 별도 Node setup이 필요한 경로가 아니다.

실행 환경도 선언과 일치했다.

```text
node --version                 v22.23.2
npm --version                  12.0.2
```

`npm ci --ignore-scripts --dry-run`은 lockfile을 변경하지 않고 `up to date`로 exit 0이었다. `engines`와 `packageManager`는 기본 npm 동작에서 advisory metadata이므로 CI가 npm 버전을 별도 assert하지 않는 점은 P2-1로 남긴다(아래 7절).

### Rust

| 위치 | 값 | 판정 |
| --- | --- | --- |
| `rust-toolchain.toml:2-3` | `channel = "1.98.0"`, `rustfmt`, `clippy` | 통과 |
| `src-tauri/Cargo.toml:7-8` | `rust-version = "1.98.0"` | 통과 |
| `.github/workflows/ci.yml:64-67` | dtolnay pinned SHA, `toolchain: "1.98.0"`, `rustfmt, clippy` | 통과 |
| `.github/workflows/release.yml:35-38` | dtolnay pinned SHA, `toolchain: "1.98.0"`, `rustfmt, clippy` | 통과 |

실행된 Rust toolchain은 다음과 같다.

```text
rustc --version               rustc 1.98.0 (88d9e12ae 2026-08-18)
cargo --version               cargo 1.98.0 (797e8a9bc 2026-08-05)
rustup show active-toolchain  1.98.0-x86_64-pc-windows-msvc (overridden by rust-toolchain.toml)
```

## 3. GitHub Actions SHA 및 upstream ref 검증

세 파일의 모든 `uses:` 라인을 정규식으로 추출해 action 이름, SHA 길이/문자 집합, trailing comment를 static assertion했다. 14개 전부 정확히 40개의 lowercase hex였으며, upstream 확인은 각 repository에 대해 `git ls-remote`로 해당 tag 또는 branch ref를 직접 조회했다. tag 이름을 SHA로 오인하지 않도록 `refs/tags/...`(tag)와 `refs/heads/stable`(branch)를 구분했다.

| Action | 사용 위치 | trailing comment | `git ls-remote` 확인 ref | upstream SHA | 판정 |
| --- | --- | --- | --- | --- | --- |
| `actions/checkout` | `ci.yml:20,49`; `release.yml:24`; `pr-runtime.yml:89,98` | `v4.4.0` | `refs/tags/v4.4.0` | `11d5960a326750d5838078e36cf38b85af677262` | 통과 |
| `actions/setup-node` | `ci.yml:22,51`; `release.yml:26` | `v4.4.0` | `refs/tags/v4.4.0` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | 통과 |
| `dtolnay/rust-toolchain` | `ci.yml:64`; `release.yml:35` | `stable branch` | `refs/heads/stable` | `4360b52568e2003a75bf9bc1d59f33a8e3fc893c` | 통과 |
| `softprops/action-gh-release` | `release.yml:100`; `pr-runtime.yml:230` | `v2.6.2` | `refs/tags/v2.6.2` | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` | 통과 |
| `actions/upload-artifact` | `pr-runtime.yml:206` | `v4.6.2` | `refs/tags/v4.6.2` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | 통과 |
| `actions/download-artifact` | `pr-runtime.yml:224` | `v4.3.0` | `refs/tags/v4.3.0` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | 통과 |

repository에는 이 세 workflow 외의 `.github/workflows` 파일이 없으므로 action ref 누락은 확인되지 않았다. actionlint는 이 sandbox에 설치되어 있지 않았고, 대신 `js-yaml` parser와 정적 input assertion을 사용했다.

## 4. YAML, cache, permissions 및 PR runtime 흐름

### YAML/setup-node

로컬 `js-yaml`로 다음 세 파일을 parse했고 모두 exit 0이었다.

```text
.github/workflows/ci.yml:          YAML parse OK; jobs=frontend,rust
.github/workflows/release.yml:     YAML parse OK; jobs=build
.github/workflows/pr-runtime.yml:  YAML parse OK; jobs=build,publish
```

`actions/setup-node`는 CI frontend/rust 및 release에 모두 `node-version-file: ".node-version"`과 `cache: npm`을 사용한다(`ci.yml:22-25,51-54`, `release.yml:26-29`). repository root에 `package-lock.json`이 있으므로 setup-node의 기본 npm cache dependency path와 맞는다. `npm ci --ignore-scripts` 뒤 `npm rebuild esbuild` 순서도 세 Node job의 기존 동작과 일치한다.

### Effective permissions

- `ci.yml:8-9`은 workflow 전체 `contents: read`만 허용한다.
- `release.yml:9-10`은 release action에 필요한 `contents: write`를 명시한다.
- `pr-runtime.yml:18-20` 및 build job `:30-32`는 `contents: read`, `actions: write`를 사용한다. publish job `:219-221`은 `contents: write`, `actions: read`로 분리돼 있다.
- PR runtime의 두 checkout은 `:89-104`에서 모두 pinned checkout, 별도 path, `fetch-depth: 1`, `persist-credentials: false`를 사용한다.

### PR runtime dual checkout/download/release

`pr-runtime.yml`의 trusted/untrusted 경계와 artifact 이동을 정적으로 확인했다.

1. `:47-86`에서 GitHub API로 PR head repository/ref/author/state/40-hex commit을 확인한다.
2. `:88-95`에서 trusted repository를 `github.sha`에 고정해 `llama-board` path로 checkout한다.
3. `:97-104`에서 `ggml-org/llama.cpp` PR head를 `llama.cpp` path로 checkout한다.
4. `:106-119`에서 checkout된 commit을 `provenance.outputs.commit`과 비교한다.
5. `:121-152`에서 PR source를 CMake CPU runtime으로 build하고 preflight한다. `:154-166`의 packaging script는 trusted checkout path에서 호출된다.
6. `:168-203`에서 archive를 풀어 source/bundle manifest, provenance, server/bench 실행을 확인한다.
7. `:205-210`에서 `actions/upload-artifact`로 업로드하고, publish job `:223-227`에서 동일한 이름으로 다운로드한다.
8. `:229-245`에서 pinned `softprops/action-gh-release`로 prerelease를 publish한다.

구성상 dual checkout과 commit 재검증, upload→download→release 연결은 통과다. 다만 untrusted `llama.cpp` CMake가 실행되는 build job이 `actions: write`를 가지고 trusted `llama-board` workspace를 sibling path로 볼 수 있으며, 같은 job에서 trusted packaging/upload를 이어간다. 이는 action SHA/Node/Rust pin 자체의 실패는 아니지만, 이전 전체 검수에서 지적된 **P1-5 잔여**(untrusted build와 write-capable/trusted packaging job 분리)를 재확인한다. release도 `contents: write`가 build/test/package와 publish를 같은 job에 부여된다(`release.yml:16-55,100-104`).

## 5. 직접 실행 결과

| 명령 | 결과 | 근거/비고 |
| --- | --- | --- |
| `node --version; npm --version; rustc --version` | **통과** | Node `v22.23.2`, npm `12.0.2`, rustc `1.98.0` |
| `npm ci --ignore-scripts --dry-run` | **통과**, exit 0 | `up to date` |
| `npm run typecheck` | **통과**, exit 0 | root 및 scripts tsconfig 검사 |
| `npm run lint` | **통과**, exit 0 | `eslint src scripts vite.config.ts` |
| `npm test` | **통과**, exit 0 | harness + 24 direct tests + Vitest: 18 files/84 tests passed; coverage lines 51.09% |
| `npm run build` | **통과**, exit 0 | TypeScript + Vite, 121 modules transformed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **통과**, exit 0 | 출력 없음 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **통과**, exit 0 | `Finished dev profile` |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml` | **통과**, exit 0 | Rust compile pass |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --no-run` | **통과**, exit 0 | 7 test executables 모두 compile/list됨 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **환경 조건부 실패** | 첫 lib test exe가 실행되기 전에 `애플리케이션 제어 정책에서 이 파일을 차단했습니다. (os error 4551)`; test body는 실행되지 않음 |
| `git diff --check` | **통과**, exit 0 | LF→CRLF 경고만 있고 whitespace error 없음 |

`cargo test`의 실패는 Rust assertion/code failure가 아니다. Cargo가 test profile을 완성하고 `llama_board_lib-...exe`를 실행하려는 순간 Windows application-control policy가 차단했으며, `cargo build`, `cargo clippy`, `cargo test --no-run`이 같은 pinned toolchain에서 통과했고 test binary 7개가 compile됐다. CI는 `ci.yml:43`의 `windows-latest` Rust job에서 동일한 `cargo fmt`/`clippy`/`test` command를 수행하도록 선언돼 있어 remote CI 실행이 full test의 최종 근거가 된다.

`npm test`에서 jsdom의 `HTMLCanvasElement.getContext()` 미구현 경고가 2회 출력됐지만 18/18 test file, 84/84 test 및 coverage threshold는 통과했다.

## 6. 기존 변경 보존 확인

검수 전부터 존재하던 workflow, README, package, Rust, frontend/test source의 dirty 변경을 유지했다. 검수 명령은 `coverage/`, `dist/`, `src-tauri/target/` 같은 기존 ignore 산출물만 갱신했으며, tracked source/config를 편집하지 않았다. 최종 변경 산출물은 `docs/review-codex-26.md` 추가다.

## 7. Findings 및 남은 작업

### P1-5 (범위 외 잔여) — write 권한과 untrusted build 경계 분리

- 위치: `.github/workflows/pr-runtime.yml:18-32,121-210`, `.github/workflows/release.yml:9-10,16-55,100-104`
- PR runtime build가 외부 PR source를 실행하면서 `actions: write`를 가진 동일 job에서 trusted packaging/upload를 수행한다. CMake/build 단계와 trusted workspace는 같은 runner workspace에 있고, build job에는 artifact upload 권한이 있다.
- release는 `contents: write`가 build/test/sign/package와 release publish 전체 job에 걸린다.
- P1-9 SHA pinning은 이 위험을 줄이지 않는다. untrusted build를 read-only job에서 끝내고, 검증된 immutable artifact를 별도 write-only publish job에서 다루도록 후속 분리한다.

### P2-1 — npm exact version을 workflow에서 hard-assert하지 않음

- 위치: `package.json:6-10`, `.github/workflows/ci.yml:22-27,51-56`, `.github/workflows/release.yml:26-31`
- Node는 `.node-version`으로 exact pin되지만 setup-node input은 npm 버전이 아니라 Node 파일만 읽는다. `engines`/`packageManager`도 기본 npm에서 advisory metadata다.
- 현재 runner는 `npm 12.0.2`로 일치하지만, CI/release 초기에 `npm --version`을 assert하거나 동등한 strict policy를 두면 선언 drift를 즉시 차단할 수 있다.

### P2-2 — README validation snippet이 canonical/CI 명령과 부분적으로 drift

- 위치: `README.md:118-121`, `package.json:44`, `.github/workflows/ci.yml:71-77`
- README는 `npx tsc --noEmit -p tsconfig.json`만 실행하지만 canonical `npm run typecheck`는 root와 `tsconfig.scripts.json`을 모두 검사한다.
- README의 `cargo clippy`/`cargo test` 예시는 `--locked`가 없어 CI의 재현성 gate와 다르다. README의 toolchain version 설명(`README.md:100-106`) 자체는 정확하다.

### P2-3 — immutable action pin 갱신 자동화 부재

- 현재 SHA/comment는 upstream 검증을 통과하지만, 주기적인 action tag→commit 갱신 및 review를 자동화하는 Dependabot/동등 policy가 검수 대상에서 확인되지 않았다.
- action SHA를 수동 갱신할 때는 이번 리포트의 `git ls-remote` 절차로 tag/branch와 comment를 다시 교차 검증한다.

## 결론

P1-9 toolchain pinning acceptance는 **충족**했다. Node `22.23.2`/npm `12.0.2`, Rust `1.98.0`, CI/release input, 14개 action SHA/comment가 현재 선언과 upstream ref에서 모두 일치하며, npm gate와 Rust compile/lint/format gate도 통과했다. 이 sandbox의 os error 4551 때문에 full Rust test만 조건부로 남고, P1-5 권한 경계 및 위 P2를 후속 작업으로 기록한다.
