# P1-4 build timeout 변경 검수 — Codex 담당 (18차 사이클)

- 검수일: 2026-08-31
- 대상: Claude 17차의 CMake phase timeout, process cleanup, CI workflow backstop 및 README 변경
- 검수 방식: 기존 uncommitted 변경과 source/test는 보존하고 read-only 검수만 수행했다. 이 리포트만 추가했다.
- 종합 판정: **조건부 통과 — 구현·workflow·문서의 P1 요구사항과 전체 Rust gate는 통과했으나, timeout 경로의 tail/descendant/PID unregister를 직접 assertion하는 회귀 테스트 공백이 P2로 남는다.**

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| Configure/build phase timeout | 통과 | `src-tauri/src/runtime.rs:54,58`의 30분 configure / 3시간 build 상수, 실제 PR source-build 경로의 `:4648-4669` 호출, `:5440-5457` phase 선택 및 주입이 확인된다. |
| Timeout child/tree termination | 통과(정적) | `:5317-5334`가 deadline 초과 시 `terminate_build_child`와 reader finish를 수행하고, `:2387-2405`가 Unix process group 또는 Windows `taskkill /T /F` 후 child를 wait한다. |
| Bounded pipe drain / normal completion | 통과 | `:5364-5407`의 두 pipe drain은 tail cap을 유지하며 normal path는 `BUILD_READER_TIMEOUT`(pipe당 30초), cancel/timeout path는 `CANCEL_READER_TIMEOUT`(pipe당 2초)로 join/abort가 bounded다. 대량 출력·abandoned reader 테스트가 통과했다. |
| Active PID unregister | 통과(정적) | `:5471-5479`가 supervisor 반환 뒤 성공·실패·cancel·timeout 모두에서 tracked CMake PID를 unregister한다. shutdown race는 `:2348-2363`의 register 경로에서 즉시 kill로 처리한다. |
| Actionable phase/tail error | 통과(정적) | `:5324-5334`가 timeout label, configured duration, measured elapsed 및 `build_failure_detail()` tail을 반환하고, 일반 non-zero exit도 `:5480-5498`에서 phase/status/tail/hint를 반환한다. |
| Cancellation/large-output/grandchild regressions | 조건부 통과 | cancellation(`:8272-8308`), large output(`:6994-7018`), reader abandonment(`:7021-7036`) 및 Unix process-group grandchild(`:8353-8424`)는 통과했다. 다만 timeout 테스트에는 tail/descendant/PID assertion이 없고 grandchild 테스트는 Unix cancellation만 검증한다(P2, 아래 참조). |
| Workflow structure and semantics | 통과 | 세 workflow의 기존 trigger, permissions, action/step 순서는 diff에서 유지됐고 timeout-minutes 및 provenance `TimeoutSec`만 추가됐다. js-yaml parse와 값 assertion이 통과했다. |
| README consistency | 통과(보완 권고) | `README.md:176`이 configure/build 각각의 timeout, stuck child termination, phase/elapsed error를 설명한다. 실제 값(30분/3시간)은 명시하지 않아 운영 문서로는 보완 권고다. |

## 2. Runtime timeout 검수

### 실제 CMake 경로 적용

`install_pr`의 source-build 경로는 configure와 build를 각각 다음처럼 호출한다.

- `src-tauri/src/runtime.rs:4648-4657` — `run_cmake_command(..., "configuring", ...)`
- `src-tauri/src/runtime.rs:4661-4669` — `run_cmake_command(..., "building", ...)`
- `src-tauri/src/runtime.rs:5440-5445` — `configuring`만 `CMAKE_CONFIGURE_TIMEOUT`(30분), 그 외는 `CMAKE_BUILD_TIMEOUT`(3시간)
- `src-tauri/src/runtime.rs:5457-5476` — 선택된 deadline이 실제 child spawn/supervisor 호출에 전달됨

따라서 단순 상수 선언이 아니라 실제 `cmake -S/-B`와 `cmake --build` 양쪽에 phase별 budget이 적용된다.

### Timeout/cancel/normal 경로

`supervise_build_child`는 두 pipe reader를 child lifetime 전체에 걸쳐 drain하고(`:5308`, `:5364-5407`), loop 시작에서 cancel을 우선 확인한다(`:5311-5314`). deadline 초과 시 child/tree를 종료한 뒤 bounded reader join을 수행하고, 이미 읽은 stdout/stderr tail을 phase와 시간 정보에 붙여 반환한다(`:5317-5334`). 정상 종료는 `child.wait()` 뒤 bounded reader finish를 거쳐 status와 두 tail을 반환한다(`:5337-5361`).

Process cleanup은 Unix에서 spawn 직전 `setpgid(0, 0)`으로 private process group을 만들고(`:2292-2313`), 종료 시 음수 PGID에 `SIGKILL`을 보내며, Windows에서는 `taskkill /PID ... /T /F`를 사용한다(`:2385-2405`). `run_cmake_command`는 supervisor가 어떤 결과를 반환하든 `?` 처리 전에 PID를 unregister하므로 tracked PID가 남지 않는다(`:5471-5479`).

## 3. 회귀 테스트 검수

| 테스트 | 확인 내용 | 결과 |
| --- | --- | --- |
| `a_build_that_outruns_the_log_cap_still_runs_to_completion` (`runtime.rs:6994-7018`) | 256 KiB tail cap을 초과하는 stdout을 pipe를 닫지 않고 drain하며 정상 완료 | 통과 |
| `an_abandoned_reader_still_hands_back_what_it_read` (`:7021-7036`) | reader join timeout 후 abort해도 이미 읽은 diagnostic 보존 | 통과 |
| `a_cancelled_build_kills_the_child_and_reports_the_cancel` (`:8272-8308`) | 긴 child의 cancel 경로가 즉시 종료되고 cancelled error 반환 | 통과 |
| `a_build_that_outlives_its_deadline_is_killed_and_reported` (`:8310-8351`) | 60초 child에 200ms deadline을 주입하고 `<10s` 내 timeout/label 반환 | 통과 |
| `cancelling_a_build_kills_a_grandchild_in_the_process_group` (`:8353-8424`) | Unix grandchild marker가 cancellation 뒤 더 이상 쓰지 않음 | 통과(Unix만) |

주입된 200ms deadline 테스트는 단순히 timeout 문자열을 보는 데 그치지 않고 60초 child 대비 `<10s` 반환을 assertion하므로 deadline이 실제로 supervisor를 깨우는 것은 검증한다. 남은 P2 공백은 이 테스트가 stdout/stderr tail 보존, timeout 시 grandchild 종료 및 `ACTIVE_BUILD_PIDS` unregister를 직접 assertion하지 않는 점이다. 또한 Windows에서 실행되는 실제 target의 `taskkill /T /F` descendant 동작은 별도 test가 없어, 현재 근거는 구현 inspection과 direct child timeout/cancel 통과에 한정된다.

## 4. Workflow 검수

현재 값은 다음과 같다.

| Workflow/job | timeout-minutes | 범위 판단 |
| --- | ---: | --- |
| `.github/workflows/ci.yml` `frontend` (`:12-17`) | 20 | npm install/rebuild/lint/audit/test/typecheck/build backstop으로 적절 |
| `.github/workflows/ci.yml` `rust` (`:41-46`) | 40 | Windows Node setup + Rust fmt/clippy/test + frontend metadata build를 포함하는 job 범위에 적절 |
| `.github/workflows/release.yml` `build` (`:18-21`) | 60 | verify, Tauri NSIS/MSI packaging, optional signing, asset collection/publish를 포함하는 전체 job backstop |
| `.github/workflows/pr-runtime.yml` `build` (`:25-29`) | 60 | provenance, source checkout, CPU CMake configure/build, preflight/package/smoke/upload를 포함 |
| `.github/workflows/pr-runtime.yml` `publish` (`:215-218`) | 15 | artifact download 및 release publish만 수행하는 짧은 job에 적절 |

`pr-runtime.yml:59`의 `Invoke-RestMethod`에는 `-TimeoutSec 30`이 추가됐다. `ci.yml`, `release.yml`, `pr-runtime.yml` 모두 기존 `on`, job permissions, action refs, step order/commands를 불필요하게 변경하지 않았다.

이미 설치된 `js-yaml`로 세 파일을 parse해 `ci(frontend,rust)`, `release(build)`, `pr-runtime(build,publish)` job을 확인했고, 위 다섯 timeout 값 및 `TimeoutSec 30` assertion이 모두 통과했다. `actionlint`는 현재 환경에 설치되어 있지 않아 실행하지 못했다.

## 5. README 검수

`README.md:176`은 source archive 확인 후 configure/build를 수행하며, 두 phase가 독립 timeout을 가지고 stuck network probe/compiler를 종료하고 phase/elapsed를 error에 표시한다고 설명한다. 이는 `CMAKE_CONFIGURE_TIMEOUT`과 `CMAKE_BUILD_TIMEOUT` 및 timeout branch의 실제 동작과 일치한다. 다만 사용자가 정확한 한도를 알 수 있도록 “configure 30분, build 3시간”을 문서에 명시하는 것이 좋다(P2 보완 권고; 현재 문장이 사실과 충돌하지는 않는다).

## 6. 직접 실행한 검증

| 명령 | 결과 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **통과**, exit 0 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **통과**, exit 0 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **통과**, exit 0 — lib 172 passed/1 ignored, CLI 8 passed, fake smoke 1 passed, live `runtime_install`/real smoke 각각 1 ignored |
| js-yaml workflow parse/value assertion | **통과**, 세 workflow parse 및 timeout policy 확인 |
| `actionlint` | 실행 불가 — 환경에 command가 없음 |

`cargo test` 중 Windows `taskkill`의 “process not found” race 메시지가 한 번 출력됐지만 해당 테스트는 모두 `ok`였고 전체 exit code는 0이다. npm 파일은 이번 timeout 검수 대상이 아니며 현재 worktree에 이미 광범위한 npm/frontend uncommitted 변경이 있으므로, worktree 영향과 범위 혼입을 피하기 위해 npm gate는 생략했다. CI YAML의 frontend timeout은 js-yaml 정적 검증으로 확인했다.

## 7. 최종 결론 및 남은 권고

P1-4의 핵심 구현은 승인 가능하다. 실제 CMake configure/build 양쪽에 서로 다른 deadline이 적용되고, timeout/cancel 시 process tree 종료·bounded drain·PID unregister·phase/tail error가 코드상 보장되며, required Rust gates와 짧은 deadline 회귀 테스트도 통과했다. 다만 다음 P2 보완을 권고한다.

1. timeout fake-child 테스트에서 stderr/stdout diagnostic tail과 timeout 후 descendant 종료를 직접 확인하고, `run_cmake_command` 수준에서 active PID unregister를 관찰 가능한 테스트 seam으로 검증한다.
2. Windows에서도 `taskkill /T /F` descendant termination을 검증하는 deterministic test를 추가한다(현재 grandchild test는 `#[cfg(unix)]`).
3. `README.md:176`에 configure 30분/build 3시간의 실제 값을 명시한다.

검수 중 source/test/workflow/npm 변경은 추가하지 않았으며, 이 사이클에서 추가한 artifact는 `docs/review-codex-18.md` 하나다.
