# P1-4 timeout 보강 최종 검수 — Codex 담당 (20차 사이클)

- 검수일: 2026-08-31
- 대상: Claude 19차의 CMake phase deadline, timeout 진단 tail, Unix process-group 회귀 테스트, CI backstop 및 README 변경
- 검수 방식: 기존 uncommitted 변경과 source/test/workflow는 보존하고 read-only로 검수했다. 이 리포트만 추가했다.
- 종합 판정: **통과 — 핵심 구현·Rust gate·workflow·README 값은 통과했으며, 테스트 assertion/Windows descendant 관찰 공백은 비차단 P2로 남는다.**

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| Configure/build deadline | 통과 | `src-tauri/src/runtime.rs:54,58`의 configure 30분 / build 3시간 상수와 `:4648-4669`의 실제 source-build 호출, `:5440-5457`의 phase별 선택·주입이 확인된다. |
| Timeout/cancellation/normal cleanup | 통과(정적) | `:5311-5356`이 cancel·deadline·child wait를 모두 처리하고 각 경로에서 reader를 bounded finish한다. 정상 종료도 `BUILD_READER_TIMEOUT`(30초), cancel/timeout/error는 `CANCEL_READER_TIMEOUT`(2초)을 사용한다. |
| Large-output/reader retention | 통과 | `:5364-5407`이 stdout/stderr를 각각 drain하면서 256 KiB tail을 보존한다. 대량 stdout과 abandoned reader 테스트가 통과했다. |
| Process-tree termination | 통과(Unix 직접 assertion은 정적) | `:2292-2313`의 Unix private process group과 `:2387-2405`의 Unix `SIGKILL`/Windows `taskkill /T /F`가 확인된다. Unix timeout grandchild 테스트가 marker 정지 비교를 수행하지만 현재 호스트가 Windows라 cfg(unix) 실행은 불가했다. |
| Active PID unregister | 통과(정적) | `:5471-5479`가 supervisor 반환 뒤 성공·실패·cancel·timeout 모두에서 PID를 unregister한다. `:2348-2383`의 shutdown race는 등록 중이면 추적하고 종료 요청 이후 등록이면 즉시 kill한다. 직접 관찰하는 테스트 seam은 없다(P2). |
| Timeout diagnostic phase/duration/tail test | 부분 통과(P2) | `:8318-8362`가 injected 200ms deadline, timeout label, stderr marker, 빠른 반환을 확인한다. 다만 stdout marker와 error 안의 configured/measured duration(`0.2s`)을 직접 assertion하지 않는다. `build_failure_detail`의 별도 테스트(`:7053-7065`)가 양쪽 stream 조합은 확인한다. |
| Fixture/process cleanup | 통과(정상 경로), P2 위험 | 정상 경로는 `:8424-8451`에서 PID kill 및 temp root 제거를 수행한다. 그러나 marker growth assertion 또는 PID/file `expect`가 panic하면 cleanup이 실행되지 않아 Unix process/temp fixture가 남을 수 있다. |
| README consistency | 통과 | `README.md:176`이 configure 30분, build 3시간, stuck child termination 및 phase/elapsed error를 명시하며 runtime 상수·메시지와 일치한다. |
| Workflow timeout/API/semantics | 통과 | `ci.yml` 20/40분, `release.yml` 60분, `pr-runtime.yml` build 60분·publish 15분 및 `Invoke-RestMethod -TimeoutSec 30`을 확인했다. 기존 trigger, permissions, action/step 순서·명령은 diff에서 유지된다. |

## 2. Runtime deadline 및 종료 경로

### 실제 phase 적용

source PR build는 configure와 build를 별도 호출한다.

- `runtime.rs:4648-4657` — `run_cmake_command(..., "configuring", ...)`
- `runtime.rs:4661-4669` — `run_cmake_command(..., "building", ...)`
- `runtime.rs:5440-5445` — `configuring`만 `CMAKE_CONFIGURE_TIMEOUT`, 그 외는 `CMAKE_BUILD_TIMEOUT`
- `runtime.rs:5457-5476` — 선택된 deadline이 실제 child supervisor에 전달됨

따라서 단순 상수 선언이 아니라 CMake configure와 build 양쪽에 각각 30분/3시간 예산이 적용된다. deadline branch(`:5317-5334`)는 tree를 종료하고 이미 읽은 stdout/stderr detail을 붙여 `label`, configured timeout, measured elapsed를 반환한다.

cancel은 loop 시작에서 deadline보다 우선 관찰되어 `runtime install cancelled`를 반환한다(`:5311-5314`). 정상 child exit는 `child.wait()` 후 두 reader를 join한다(`:5337-5361`). `BuildReaders`는 두 pipe를 child 생존 중 계속 drain하고, 정상 경로의 reader stall은 30초, 종료 경로의 reader stall은 2초 후 abort해 반환을 bounded하게 한다(`:5364-5407`).

Unix에서는 spawn 전 `setpgid(0, 0)`으로 CMake child와 descendants를 private group에 넣고, 종료 시 음수 PGID에 `SIGKILL`을 보낸다(`:2292-2313`, `:2387-2405`). Windows에서는 기존 `taskkill /PID ... /T /F` descendant termination을 유지한다. Windows taskkill 자체와 descendant 효과를 별도 deterministic assertion하는 테스트는 없어 정적 확인에 한정한다(P2).

`run_cmake_command`는 `supervise_build_child`가 성공·non-zero·cancel·timeout·wait error 중 무엇을 반환해도 `supervised?` 전에 `unregister_active_build(pid)`를 실행한다(`:5471-5480`). 앱 Exit hook은 `runtime::terminate_active_builds()`를 async future가 끝나기 전에 호출한다(`src-tauri/src/lib.rs:1708-1720`). 다만 active PID 목록을 테스트에서 조회하는 public/diagnostic seam은 없고, long reader cleanup 중 PID reuse 가능성까지 직접 관찰하지 못한다(P2).

## 3. 회귀 테스트 검수

| 테스트 | 확인 내용 | 결과 |
| --- | --- | --- |
| `a_build_that_outruns_the_log_cap_still_runs_to_completion` (`runtime.rs:6994-7018`) | 256 KiB를 넘는 stdout을 pipe deadlock 없이 drain하고 정상 완료 | 통과 |
| `an_abandoned_reader_still_hands_back_what_it_read` (`:7021-7036`) | reader가 끝나지 않아도 200ms 후 abort하고 이미 읽은 diagnostic 보존 | 통과 |
| `a_cancelled_build_kills_the_child_and_reports_the_cancel` (`:8272-8308`) | 긴 child에 이미-set cancel을 주고 즉시 종료·cancel error 반환 | 통과 |
| `a_build_that_outlives_its_deadline_is_killed_and_reported` (`:8318-8362`) | 60초 child에 injected 200ms deadline, timeout/label/stderr tail, `<10s` 반환 | 통과하나 stdout·error duration 문자열 assertion은 없음(P2) |
| `cancelling_a_build_kills_a_grandchild_in_the_process_group` (`:8457-8481`) | Unix grandchild marker가 cancel 뒤 더 이상 증가하지 않음 | 통과(정적; Windows host에서는 cfg 제외) |
| `a_build_timeout_kills_a_grandchild_in_the_process_group` (`:8488-8512`) | Unix timeout 경로에서 process-group grandchild marker가 더 이상 증가하지 않음 | 통과(정적; Windows host에서는 cfg 제외) |

Unix helper는 `(while :; do printf x >> marker; sleep 0.02; done) &`를 시작하고 PID/file을 기다린 뒤, 종료 후 120ms 간 marker 파일 크기가 같은지 비교한다(`:8378-8415`, `:8430-8451`). 이는 timeout 경로가 direct child만 죽이는 경우를 잡는 구조다. 다만 helper가 stop 전 marker가 실제로 증가했는지 별도 assertion하지 않고, `assert_eq!`가 panic하면 뒤의 직접 PID kill과 `remove_dir_all`에 도달하지 않는다. 따라서 정상 실행의 process/fixture 정리는 되지만 실패 경로 cleanup 보장은 P2다.

Timeout error 조합 함수는 stdout을 먼저 넣고 stderr를 뒤에 붙인 뒤 4096-character tail을 반환한다(`:5425-5435`). 별도 `build_failures_report_the_end_of_the_log`는 stdout+stderr 조합과 tail cap을 통과했지만, timeout fake child 자체는 stderr marker만 쓴다(`:8319-8333`). 또한 테스트는 error에 실제 `0.2s` configured timeout과 measured elapsed가 들어갔는지 확인하지 않고 wall-clock `<10s`만 확인한다. 구현의 error format은 `:5325-5328`에서 올바르게 생성되므로 기능 결함보다는 회귀 assertion 공백으로 분류한다(P2).

## 4. README 검수

`README.md:176`은 “Configure and build each have their own timeout — 30 minutes for configure, 3 hours for build”이라고 실제 값을 명시하고, stuck network probe/compiler 종료와 phase/elapsed error를 설명한다. 이는 `CMAKE_CONFIGURE_TIMEOUT = 30 * 60`, `CMAKE_BUILD_TIMEOUT = 3 * 60 * 60` 및 timeout message의 configured/measured duration과 일치한다.

## 5. Workflow 검수

현재 job-level timeout은 다음과 같다.

| Workflow/job | timeout-minutes | 확인 |
| --- | ---: | --- |
| `.github/workflows/ci.yml` `frontend` (`:12-17`) | 20 | npm install/rebuild/lint/audit/test/typecheck/build job 전체 backstop |
| `.github/workflows/ci.yml` `rust` (`:41-46`) | 40 | Windows Node/Rust checks 및 frontend metadata build 전체 backstop |
| `.github/workflows/release.yml` `build` (`:16-21`) | 60 | verify, NSIS/MSI packaging, optional signing, asset collection/publish 포함 |
| `.github/workflows/pr-runtime.yml` `build` (`:23-29`) | 60 | provenance, source checkout, CMake configure/build, package/smoke/upload 포함 |
| `.github/workflows/pr-runtime.yml` `publish` (`:212-218`) | 15 | artifact download 및 release publish만 수행 |

`pr-runtime.yml:59`의 GitHub API 호출은 `Invoke-RestMethod ... -TimeoutSec 30`이다. zero-context diff를 확인한 결과 추가된 것은 위 timeout/comment, API timeout 한 줄뿐이며 다음 semantics는 그대로다.

- `ci.yml`: `push` to `main`, 모든 `pull_request`, root `contents: read`, frontend/rust 기존 step 순서·명령
- `release.yml`: `v*` tag push 및 `workflow_dispatch`, root `contents: write`, 기존 verify/sign/package/publish 순서
- `pr-runtime.yml`: manual inputs(`pull_request`, CPU backend), root/build `contents: read` + `actions: write`, publish `contents: write` + `actions: read`, 기존 checkout/provenance/build/package/smoke/upload/release 순서

`actionlint`는 현재 환경에 설치되어 있지 않았다. 대신 repository의 `js-yaml`로 세 workflow를 parse했고, jobs(`ci: frontend,rust`; `release: build`; `pr-runtime: build,publish`), 다섯 timeout 값 및 `TimeoutSec 30` 정적 assertion이 모두 통과했다.

## 6. 직접 실행한 검증

| 명령 | 결과 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **통과**, exit 0 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **통과**, exit 0 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **통과**, exit 0 — lib 172 passed/1 ignored, CLI 8 passed, fake smoke 1 passed, live `runtime_install`/real smoke 각각 1 ignored |
| js-yaml workflow parse/value assertion | **통과** |
| `actionlint` | 실행 불가 — command 미설치 |

`cargo test` 중 Windows `taskkill`의 `SUCCESS`와 한 차례 `ERROR: The process ... was not found` 메시지가 출력됐지만 관련 테스트는 모두 `ok`이고 전체 exit code는 0이다. 이는 종료 race/noise로 기록하며 현재 gate를 실패시키는 문제는 아니다.

현재 호스트는 Windows(`x86_64-pc-windows-msvc`만 설치)라 Unix-only process-group tests는 compile/run되지 않았다. 해당 테스트의 process-group/marker 논리는 정적으로 확인했고, Windows timeout/cancel direct-child 테스트 및 전체 Rust gate는 실행했다.

## 7. 최종 결론 및 남은 P2

P1-4 핵심 요구사항은 **통과**다. 실제 configure/build deadline, cancel·normal·large-output·reader bounded cleanup, timeout diagnostic composition, Unix process-group timeout/cancel 종료, active PID unregister, README 값, CI/release/PR workflow backstop 및 API timeout이 구현·정적 검수와 required Rust gate에서 확인됐다.

비차단 P2는 다음과 같다.

1. timeout fake-child에 stdout marker를 추가하고 error에 configured timeout(`0.2s`) 및 measured elapsed가 포함되는지 직접 assertion한다. 가능하면 `run_cmake_command` 또는 관찰 가능한 registry seam으로 active PID unregister도 검증한다.
2. Unix marker helper에 stop 전 실제 증가 assertion을 추가하고, guard/`finally`로 panic·assertion 실패 시 PID kill과 temp root cleanup을 보장한다.
3. Windows `taskkill /T /F` descendant 종료를 deterministic child/marker fixture로 검증한다. 현재는 Windows 구현 정적 확인과 direct-child timeout 실행에 한정된다.
4. normal path에서 direct CMake child가 먼저 끝나고 descendant가 pipe를 계속 보유하는 경우, reader timeout 뒤 descendant가 남지 않는지 별도 정책/테스트를 정한다. 현재 reader task는 abort되지만 normal path가 tree를 다시 kill하지는 않는다.

검수 중 기존 source/test/workflow/npm 변경은 수정하지 않았으며, 이 사이클에서 추가한 artifact는 `docs/review-codex-20.md` 하나다.
