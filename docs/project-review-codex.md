# llama-board 빌드·타입·테스트·CI 읽기 전용 점검

- 대상: `main`, version `0.1.4`, 현재 작업 트리.
- 범위: 프런트엔드 빌드/타입/테스트 설정, Rust 빌드·테스트 구조, GitHub Actions의 중복·권한·캐시·타임아웃.
- 기존 미커밋 변경은 되돌리거나 수정하지 않았고, 이 리포트만 생성했다. 이전 CSS 리뷰와 PR 런타임 NO-SHIP 리뷰의 기능 결론은 전제로 두고, 이번 문서는 빌드 게이트와 개발자 피드백 루프에 집중한다.

## 개요

현재 로컬에서 즉시 재현되는 컴파일 실패는 없었다. 다만 기본 테스트가 실제 서버/런타임 설치를 실행하지 않아 성공으로 집계하는 문제, Node 스크립트의 정적 검사 사각지대, CMake와 CI의 무기한 대기 가능성, release/PR workflow의 권한 경계가 다음 배포 전 우선 해결 대상이다.

검증 명령 결과는 다음과 같다.

| 명령 | 결과 | 관찰 |
|---|---|---|
| `npm run typecheck` | 통과 | `src` 기준이며 scripts는 포함하지 않음 |
| `npm run lint` | 통과 | 실제 실행 범위가 `eslint src`뿐임 |
| `npm test` | 통과 | 23개 Node 스크립트를 순차 실행한 뒤 Vitest 12 files/61 tests 실행 |
| 임시 출력 경로의 `vite build` | 통과 | 88 modules, CSS 86.08 kB, JS index 259.27 kB; 현재 lazy panel 청크는 생성됨 |
| `cargo fmt --check` | 통과 |  |
| `cargo clippy --locked ... --all-targets --all-features -- -D warnings` | 통과 | 현재 경고 없음; strict gate 자체는 CI에 남아 있음 |
| `cargo test --locked` | 통과 | lib 171 passed/1 ignored, CLI 8 passed, gated integration 2개가 환경 변수 없이 즉시 반환되어 passed로 집계됨 |

## P0

### P0-1. 현재 재현된 즉시 차단 수준의 빌드·타입·테스트 실패는 없음

- **현황(파일:라인)**: 위 명령들이 현재 작업 트리에서 통과했다. 단, 실제 서버/런타임 경로는 `src-tauri/tests/smoke.rs:24-30`, `src-tauri/tests/runtime_install.rs:32-37`의 조기 반환 때문에 기본 `cargo test`에서 실행되지 않는다.
- **영향도**: 컴파일 게이트는 녹색이지만 P1 항목을 해결하지 않으면 녹색 결과만으로 release 안전성을 보증할 수 없다.
- **권장 수정**: P1-1(실제 통합 테스트), P1-4(타임아웃), P1-5(권한)를 안정 release 전에 우선 처리한다.
- **검증 방법**: 정리된 checkout에서 아래 P1 검증을 수행하고, gated 테스트가 실제로 실행되었다는 로그와 coverage/아티팩트를 확인한다.

## P1

### P1-1. Rust 통합 테스트가 환경 변수 없이 성공으로 집계되는 false green

- **현황(파일:라인)**: `smoke_real_server_and_chat`는 `LLAMA_BOARD_SMOKE`가 없으면 `return`한다(`src-tauri/tests/smoke.rs:24-30`). 실제 runtime 다운로드·설치 테스트도 `LLAMA_BOARD_RUNTIME_INSTALL`이 없으면 `return`한다(`src-tauri/tests/runtime_install.rs:32-37`). CI는 이를 일반 `cargo test`로 호출한다(`.github/workflows/ci.yml:68-69`), release도 같은 명령을 실행하며 환경 변수가 없으면 경고만 남긴다(`.github/workflows/release.yml:46-50`). 이번 실행에서도 두 integration test가 각각 `1 passed`로 끝났지만 실제 서버/다운로드는 수행되지 않았다.
- **영향도**: API health/streaming, GitHub release 다운로드·checksum·preflight·activation을 release마다 검증하지 못한다. 테스트가 “skip”이 아니라 “pass”로 보이므로 CI 신뢰도가 과대평가된다.
- **권장 수정**: 기본 단위 게이트에서는 `#[ignore]`로 명시하고, 작은 fake `llama-server` fixture를 사용하는 결정적 통합 테스트를 항상 실행한다. 다중 GB 모델과 live GitHub 설치는 전용 self-hosted/nightly/manual job에서 `--ignored`로 실행하며, 필요한 fixture가 없으면 성공 대신 명시적 skipped 상태가 되도록 job을 분리한다.
- **검증 방법**: 일반 `cargo test`에서 gated 테스트가 실행되지 않음을 `ignored`로 확인하고, 전용 job에서 `cargo test --test smoke -- --ignored --nocapture` 및 `cargo test --test runtime_install -- --nocapture`를 실행해 서버 health/SSE, 다운로드/압축 해제/파일 검증/activation 로그를 필수 artifact로 남긴다.

### P1-2. Node-side scripts가 타입·린트·Vitest 검사 범위에서 빠지고 실험적 런타임에 의존

- **현황(파일:라인)**: 실제 테스트 스크립트 23개가 모두 `node --experimental-strip-types`로 실행된다(`package.json:11-32,39`). `npm run typecheck`는 `tsconfig.json`만 지정한다(`package.json:34`); root include는 `src`뿐이다(`tsconfig.json:23`), project reference가 있어도 `tsconfig.node.json`의 include는 `vite.config.ts` 하나뿐이다(`tsconfig.json:24`, `tsconfig.node.json:9`). 따라서 `scripts/**/*.ts`는 TypeScript 검사 대상이 아니다. ESLint도 `scripts/**`를 무시한다(`eslint.config.js:7-10`)고 CLI 자체도 `eslint src`만 호출한다(`package.json:9`). Vitest include 역시 `src/**/*.test.{ts,tsx}`뿐이다(`vitest.config.ts:9-14`).
- **영향도**: 테스트 harness와 빌드 보조 코드가 타입 오류·Node API 오용을 런타임에서야 발견할 수 있다. `--experimental-strip-types`는 현재 Node 22.23.2에서는 통과했지만 저장소에 `engines`/Node 고정이 없어 다른 Node 버전에서 문법·지원 범위가 달라질 수 있다.
- **권장 수정**: `tsconfig.scripts.json`을 별도로 두고 `scripts/**/*.ts`, `vite.config.ts`에 맞는 Node 타입을 검사하며, `scripts/build-cli.mjs`는 `checkJs`/ESLint Node override로 별도 검사한다. `typecheck:all`에서 root/node/scripts 프로젝트를 모두 호출하고, ESLint에 Node용 override를 추가해 `eslint . --max-warnings=0`을 사용한다. 장기적으로 direct Node assertions를 Vitest(또는 명시적으로 고정한 `tsx`) 프로젝트로 통합하고, `package.json.engines`, `.node-version`/Volta와 CI의 exact Node minor를 선언한다.
- **검증 방법**: `tsc -p tsconfig.scripts.json --noEmit`, `eslint scripts vite.config.ts --max-warnings=0`, 지원 범위의 최소/목표 Node 버전에서 `npm ci && npm test`를 실행한다. typecheck 출력에 scripts 파일이 포함되는지 확인한다.

### P1-3. 테스트 harness가 23단계 직렬 Node 실행과 별도 Vitest로 이원화되고 coverage가 없음

- **현황(파일:라인)**: `npm test`는 `test:tuning`부터 `test:i18n`까지 23개 Node 스크립트를 긴 `&&` 체인으로 직렬 실행한 후 `test:ui`를 호출한다(`package.json:33-40`). UI 테스트는 별도 `vitest run`이며 include도 `src`로 한정된다(`package.json:40`, `vitest.config.ts:9-14`). Vitest coverage provider/threshold 스크립트가 없고, 의존성에도 coverage provider가 선언되어 있지 않다(`package.json:47-65`).
- **영향도**: 한 단계 실패 시 뒤의 테스트 결과를 얻지 못하고, 동일 유틸리티의 테스트 스타일·리포터·실행 병렬성이 달라진다. 현재 61개 Vitest test와 direct assertions가 모두 통과해도 어떤 경로가 실행되지 않았는지, 변경이 coverage를 낮췄는지 알 수 없다.
- **권장 수정**: direct assertions를 Vitest test files/project로 옮겨 단일 `test:unit`/`test:ci` 진입점과 표준 reporter를 만든다. 불가피한 외부/실제 fixture 테스트는 `test:integration`으로 분리한다. `@vitest/coverage-v8` 또는 동등 provider와 초기 baseline threshold를 추가한 뒤 점진적으로 올리고, CI에는 text+JUnit/coverage artifact를 남긴다.
- **검증 방법**: `npm run test:ci` 한 번으로 모든 unit test가 실행되고, coverage summary와 threshold 실패가 생성되는지 확인한다. 한 테스트를 의도적으로 실패시켜 나머지 결과와 JUnit artifact가 보존되는지도 검증한다.

### P1-4. CMake 소스 빌드와 CI job에 전체 시간 제한이 없다

- **현황(파일:라인)**: `supervise_build_child`는 child가 종료되거나 취소될 때까지 loop를 돌고(`src-tauri/src/runtime.rs:5287-5325`), CMake 호출도 이 supervisor에만 위임한다(`src-tauri/src/runtime.rs:5400-5427`). build 단계에 전체 deadline은 없으며, PR workflow의 CMake configure/build도 무제한이다(`.github/workflows/pr-runtime.yml:117-127`). 세 workflow의 job 정의(`.github/workflows/ci.yml:12-14,38-40`, `.github/workflows/release.yml:15-18`, `.github/workflows/pr-runtime.yml:22-25,208-212`) 어디에도 `timeout-minutes`가 없다. PR provenance API 호출도 별도 `-TimeoutSec` 없이 실행된다(`.github/workflows/pr-runtime.yml:43-55`).
- **영향도**: 멈춘 compiler/CMake, 네트워크, antivirus 또는 child/grandchild가 앱과 GitHub runner를 무기한 점유할 수 있다. GitHub 기본 runner 상한까지 비용이 발생하고, 취소되지 않은 process tree가 남을 위험이 있다.
- **권장 수정**: 앱에 configure/build별 `BUILD_TIMEOUT`을 두고 timeout 시 현재 process group/tree를 terminate한 뒤 tail log와 원인을 반환한다. CI는 job timeout을 backstop으로 두고, API 호출에는 명시적 timeout을 둔다. timeout 값은 CPU/GPU build 차이를 반영하되 상한은 반드시 둔다.
- **검증 방법**: sleep/무한 출력 fake CMake child를 주입한 Rust test에서 deadline 내 종료, descendant kill, 진단 tail 반환을 확인한다. 각 workflow의 정상/timeout/cancel 실행이 지정된 `timeout-minutes` 안에 종료되는지 확인한다.

### P1-5. release와 PR runtime build의 권한 경계가 빌드 단계까지 넓다

- **현황(파일:라인)**: Windows release workflow 전체에 `contents: write`가 설정되어 있고(`.github/workflows/release.yml:9-10`), 같은 job에서 dependency 설치·테스트·CMake/Rust build와 publish를 모두 수행한다(`.github/workflows/release.yml:15-52,96-101`). PR runtime은 workflow 및 build job에 `actions: write`를 부여한다(`.github/workflows/pr-runtime.yml:18-28`); 그 build job은 외부 PR source를 CMake로 실행한다(`.github/workflows/pr-runtime.yml:93-127`). publish job의 `contents: write`는 별도로 존재하지만(`.github/workflows/pr-runtime.yml:208-238`), build와 publish의 신뢰 경계가 충분히 분리되어 있지 않다. 모든 action ref도 tag 기반이다(`.github/workflows/*.yml`의 `uses: ...@v4/@v2`).
- **영향도**: release build dependency 또는 PR CMake/build hook이 의도치 않게 write-capable workflow context와 같은 job에서 실행된다. PR runtime은 특히 검토 대상 코드를 compile하는 경로이므로 artifact/release 권한을 최소화하지 않으면 공급망·artifact 오염의 blast radius가 커진다.
- **권장 수정**: release는 read-only build job → artifact → protected environment의 write-only publish job으로 나눈다. PR runtime은 untrusted source build를 `contents: read`/필요 최소 artifact 권한의 job에서 수행하고, trusted packaging/upload/publish를 후속 job으로 분리한다. action은 immutable commit SHA로 pin하고 Dependabot으로 갱신한다. secret은 build job에 절대 주입하지 않는다.
- **검증 방법**: `actionlint`와 permissions review로 각 job의 effective token scope를 확인하고, 악의적인 CMake fixture가 token/release API에 접근하지 못하는지 검증한다. build 실패·재실행·동시 실행 시 publish job이 보호 환경과 artifact provenance를 요구하는지도 확인한다.

### P1-6. npm audit가 중복 실행되지만 dev dependency를 제외하고, release에는 audit가 없다; 서명도 선택 사항이다

- **현황(파일:라인)**: `ci.yml`의 Ubuntu와 Windows job이 같은 `npm audit --omit=dev --audit-level=high`를 각각 실행한다(`.github/workflows/ci.yml:29-30,55-56`). `vite`, Tauri CLI, esbuild, Vitest 등 build/release에 실행되는 dev dependency는 이 gate에서 제외된다(`package.json:47-65`). release verify 단계에는 npm audit가 없다(`.github/workflows/release.yml:38-50`). Windows signing은 certificate secret이 없으면 warning 후 return하고(`.github/workflows/release.yml:53-80`), unsigned `.exe`/`.msi`도 그대로 publish한다(`.github/workflows/release.yml:96-101`).
- **영향도**: 개발 도구의 high 취약점이나 악성 dependency를 release job이 놓칠 수 있고, 소비자는 서명되지 않은 설치 파일을 정식 release로 받을 수 있다. 동일 audit의 중복 네트워크 호출은 CI 시간을 늘린다.
- **권장 수정**: lockfile 기준 dependency audit/SCA를 전용 job에서 한 번 수행하고 release가 그 결과를 요구하게 한다. dev dependency를 의도적으로 제외할 경우 근거와 별도 dev audit를 둔다. 안정 tag는 signing secret과 signature verification을 필수화하고, unsigned 산출물은 명시적 prerelease 채널로만 분리한다.
- **검증 방법**: 취약 dev fixture를 넣었을 때 release gate가 실패하는지, signing secret이 없을 때 stable publish가 차단되는지 확인한다. 서명된 파일에 대해 `Get-AuthenticodeSignature`가 Valid이고 checksum/asset manifest와 일치하는지 확인한다.

### P1-7. Rust 핵심 로직과 Tauri command가 대형 파일에 집중되어 변경·검증 위험이 크다

- **현황(파일:라인)**: 현재 물리 줄 수는 `src-tauri/src/runtime.rs` 8,525줄(요청 컨텍스트의 8,041줄 지적보다 큼)이며, network/cache/archive/process/CMake/install 로직이 한 모듈에 있다(`src-tauri/src/runtime.rs:237-6245`). 테스트도 같은 파일의 `mod tests`에서 6,247-8,525줄을 차지한다. `src-tauri/src/lib.rs`는 현재 1,988줄(컨텍스트의 1,888줄 지적보다 큼)이고 42개 `#[tauri::command]`가 72-1,632줄에 혼재하며, handler 등록은 1,653-1,698줄, 테스트는 1,742-1,988줄이다. `backends.rs:53`의 production `unwrap_or(0)`는 비패닉 fallback이고, `backends.rs:184,229`의 `expect/unwrap`은 `#[cfg(test)]` 영역(`backends.rs:150-151`)이다. 실제 production panic-capable 지점은 HTTP client builder(`runtime.rs:3532-3549`, `gateway.rs:20-25`), backend invariant `unreachable!`(`runtime.rs:5135-5142`), config invariant(`config.rs:441-448`), Tauri app build(`lib.rs:1697-1698`) 등이다.
- **영향도**: 런타임 변경이 다운로드·압축·프로세스·보안 경계 전체에 영향을 주기 쉽고, command 등록/상태 lock과 domain logic을 독립적으로 검증하기 어렵다. 네트워크 client 초기화나 미래 backend 추가가 예상 밖 상황에서 process panic으로 이어질 수 있다. 다만 현재 `cargo clippy ... -D warnings` 자체는 통과하므로 이를 현재 실패로 오판할 필요는 없다.
- **권장 수정**: `runtime`을 catalog/provenance, HTTP/cache, archive/manifest, process supervision, source build, install/activation 모듈로 단계적으로 분리하고 각 모듈 옆으로 테스트를 이동한다. `lib.rs`는 command adapter와 state wiring만 남기고 domain별 command 모듈로 나눈다. 실패 가능한 client builder는 `Result`/초기화 error로 전환하고 `unreachable!`는 입력 검증과 함께 안전한 error path를 갖게 한다. `-D warnings`는 유지한다.
- **검증 방법**: 분리 전후 `cargo fmt --check`, `cargo clippy --locked --all-targets --all-features -- -D warnings`, `cargo test --locked` 결과와 command API snapshot을 비교한다. HTTP 초기화 실패, unknown backend, Tauri startup failure가 사용자 표시 error로 끝나는지 테스트한다.

### P1-8. CI가 Ubuntu/Windows에서 같은 frontend install·audit·lint를 중복 수행하고 Rust cache가 없다

- **현황(파일:라인)**: `ci.yml`의 `frontend` job은 Ubuntu에서 npm install/rebuild/lint/audit/test/typecheck/build를 수행한다(`.github/workflows/ci.yml:12-36`). `rust` job은 Windows에서 npm install/rebuild/lint/audit를 다시 수행한 뒤 Rust checks를 하고(`.github/workflows/ci.yml:38-69`), 마지막에 frontend build도 다시 한다(`.github/workflows/ci.yml:70-71`). release는 verify 단계에서 전체 npm/Rust checks를 다시 수행한다(`.github/workflows/release.yml:38-52`). cache 설정은 `setup-node`의 npm cache뿐이다(`.github/workflows/ci.yml:18-22,44-48`, `.github/workflows/release.yml:22-26`); Cargo registry/git/target cache가 없고 PR runtime에도 cache 설정이 없다(`.github/workflows/pr-runtime.yml:84-127`).
- **영향도**: 동일 lockfile에 대한 audit/network/install 시간이 job 수만큼 늘고, Windows Rust job의 feedback이 frontend 중복 작업에 막힌다. Cargo와 PR CMake build가 매번 cold build라 runner 비용과 timeout 가능성이 커진다.
- **권장 수정**: frontend gate를 한 job으로 표준화하고, Windows Rust job은 필요한 `dist` artifact를 받아 Rust만 검사한다(플랫폼 의존 build가 필요하면 그 이유를 명시). Cargo cache는 lockfile+toolchain key로 추가하되, untrusted PR source build cache는 commit/backend 격리 또는 비활성화한다. release는 검증된 CI artifact를 재사용하거나 release 전용 검증 범위를 명시한다.
- **검증 방법**: clean runner에서 중복 npm 단계가 제거되었는지 확인하고, cache hit/miss 양쪽에서 `npm ci`, Cargo fmt/clippy/test 결과가 동일한지 비교한다. PR commit/backend가 다른 cache를 절대 재사용하지 않는지 key와 로그를 확인한다.

### P1-9. Node/Rust/action 도구체인이 floating 상태라 release 재현성이 약하다

- **현황(파일:라인)**: package에 `engines`/`packageManager`가 없다(`package.json:1-5`); CI Node는 `22` major만 지정한다(`.github/workflows/ci.yml:18-22,44-48`, `.github/workflows/release.yml:22-26`). Cargo manifest에는 `rust-version`이 없고 edition만 `2021`이다(`src-tauri/Cargo.toml:1-7`); CI Rust는 `stable` floating이다(`.github/workflows/ci.yml:57-61`, `.github/workflows/release.yml:31-35`). 의존성 lockfile은 존재하고 `--locked`는 사용하지만, action ref는 SHA pin이 아니다.
- **영향도**: Node의 experimental strip-types, Rust lint 변화, action의 tag 이동에 따라 동일 tag release의 결과가 달라질 수 있다. 특히 `-D warnings`가 새 Rust lint를 곧바로 build failure로 만들 수 있다.
- **권장 수정**: 검증한 Node exact minor와 Rust toolchain/MSRV를 `.node-version`/`rust-toolchain.toml`, `engines`, `rust-version`으로 선언하고 Actions에서도 고정한다. third-party action은 SHA pin 후 주기적으로 갱신한다.
- **검증 방법**: 새 checkout에서 선언 파일만으로 Node/Rust를 설정한 뒤 `npm ci`, `npm test`, `cargo ... --locked`를 반복해 동일 결과와 version banner를 확인한다.

## P2

### P2-1. Vite build 정책에 manualChunks와 cssCodeSplit가 명시되지 않았다

- **현황(파일:라인)**: `vite.config.ts`에는 plugin/server 설정만 있고 `build` 블록이 없다(`vite.config.ts:8-20`). 따라서 `manualChunks`와 `cssCodeSplit` 정책이 Vite 기본값에 맡겨져 있다. 현재는 `App.tsx:19-29`의 10개 `React.lazy` dynamic import 덕분에 panel JS 청크가 생성되며, 임시 build 결과도 여러 panel chunk를 확인했으므로 즉시 번들 실패는 아니다.
- **영향도**: Vite/Rolldown 업그레이드나 shared dependency 증가 시 chunk 경계와 CSS 로딩 정책이 조용히 변할 수 있고, bundle budget을 CI에서 설명하기 어렵다. `cssCodeSplit` 부재 자체가 “CSS split disabled”라는 뜻은 아니며, 현재 문제는 명시적인 성능 정책과 회귀 감시가 없다는 점이다.
- **권장 수정**: bundle 분석 후 필요한 경우 `build.rollupOptions.output.manualChunks`를 domain 단위로 선언하고, `cssCodeSplit: true`를 의도한 정책으로 명시한다. JS/CSS gzip budget과 경고/실패 기준을 CI에 둔다.
- **검증 방법**: `vite build --report` 또는 bundle analyzer 결과를 baseline과 비교하고, 최초 Chat 진입 및 lazy panel 진입의 네트워크 요청·gzip byte를 측정한다.

### P2-2. TypeScript paths alias가 없어 대규모 모듈 경로가 상대 경로에 고정되어 있다

- **현황(파일:라인)**: `tsconfig.json:2-24`에 `baseUrl`/`paths`가 없고, 현재 imports도 `./`/`../` 상대 경로를 사용한다. Vite에는 `resolve.alias`도 없다(`vite.config.ts:8-20`).
- **영향도**: 지금은 동작하지만 깊은 panel/component 이동 시 import 경로 변경이 누적되고, domain 경계가 코드에 드러나지 않는다. alias를 일부만 추가하면 TypeScript·Vite·Vitest·Node direct script 사이 resolution drift가 생길 수 있다.
- **권장 수정**: 필요성이 확인될 때 `@/* -> src/*` 같은 단일 규칙을 `tsconfig`, Vite, Vitest에 함께 선언한다. direct Node scripts를 유지하는 동안에는 alias를 추가하기보다 P1-2의 단일 runner/검사 범위를 먼저 확정한다.
- **검증 방법**: alias import를 사용하는 대표 panel/component와 Vitest를 모두 build/typecheck하고, Node test runner에서도 동일 module resolution이 되는지 확인한다.

### P2-3. Tauri config가 복제되어 frontend build가 중복되고 metadata drift 위험이 있다

- **현황(파일:라인)**: `tauri.conf.json`과 `tauri-cli-build.conf.json`이 product/version/build 설정을 각각 복제한다(`src-tauri/tauri.conf.json:3-10`, `src-tauri/tauri-cli-build.conf.json:3-10`). `package.json:36`도 `build:cli && build` 후 `tauri build`를 호출하며, Tauri 자체 `beforeBuildCommand`가 다시 `npm run build`를 호출한다(`src-tauri/tauri.conf.json:6-10`). release도 CLI resource와 verify build 후 Tauri packaging을 한다(`.github/workflows/release.yml:36-52`).
- **영향도**: CSP, version, frontendDist, resource 설정이 두 파일에서 어긋나거나 동일 frontend build가 반복되어 packaging 시간이 늘 수 있다.
- **권장 수정**: 공통 Tauri 설정의 단일 source를 만들고 CLI build용 차이만 override한다. `beforeBuildCommand`와 package script 중 하나만 frontend build를 소유하도록 canonical command를 정한다.
- **검증 방법**: `npm run build`, `npm run build:cli`, `npm run tauri build -- --bundles nsis,msi`를 clean target에서 실행해 두 config의 version/CSP/resource/asset manifest가 의도대로 동일한지 비교한다.

### P2-4. Clippy `-D warnings` strict gate는 남아 있지만 현재는 통과한다

- **현황(파일:라인)**: CI는 `cargo clippy ... --all-targets --all-features -- -D warnings`를 유지한다(`.github/workflows/ci.yml:64-67`); release도 같은 strict command를 실행한다(`.github/workflows/release.yml:44-46`). 이번 동일 명령은 exit 0이었다. 반면 `cargo test`에서는 Windows linker stdout warning이 출력되었지만 test gate는 경고를 error로 승격하지 않는다.
- **영향도**: 현재 결함은 아니며 strict lint는 유지할 가치가 있다. 다만 floating Rust toolchain이나 dependency update가 경고를 추가하면 release가 갑자기 차단될 수 있고, linker noise가 실제 warning을 가릴 수 있다.
- **권장 수정**: `-D warnings`를 제거하거나 완화하지 말고 P1-9의 toolchain pin과 함께 유지한다. linker 메시지는 원인을 확인해 suppress/분리하고, CI 출력은 `--message-format=short` 등으로 actionable하게 만든다.
- **검증 방법**: pinned toolchain에서 clippy가 0 warning인지 확인하고, 의도적 lint fixture가 CI를 실패시키는지와 linker noise가 별도 annotation으로 분리되는지를 확인한다.

### P2-5. README의 canonical validation 명령이 실제 `npm test` gate보다 약하다

- **현황(파일:라인)**: README validation 예시는 `npm run test:tuning`만 실행한다(`README.md:113-120`); lint와 UI test는 별도 예시로 분리되어 있다(`README.md:122-127`). 실제 CI와 package canonical gate는 23개 direct test + Vitest다(`package.json:33-40`, `.github/workflows/ci.yml:27-36`).
- **영향도**: 개발자가 문서만 따라가면 대부분의 frontend test와 두 harness 간 연결을 검증하지 않은 채 build를 통과시킬 수 있다.
- **권장 수정**: `npm run verify` 같은 단일 명령을 정의하고 README/CI/release가 동일한 `verify` 단계와 gated integration 예외를 문서화한다.
- **검증 방법**: README의 clean-checkout 절차를 처음부터 실행해 package script, typecheck, lint, Vitest, Rust checks가 실제 CI와 동일한지 대조한다.

## 종합 우선순위

| 순위 | ID | 항목 | 근거 위치 | 우선 이유 |
|---:|---|---|---|---|
| 1 | P1-1 | gated Rust integration false green | `tests/smoke.rs:24-30`, `tests/runtime_install.rs:32-37`, `release.yml:46-50` | release가 핵심 런타임 경로를 검증하지 않음 |
| 2 | P1-4 | 앱/CI build timeout 부재 | `runtime.rs:5287-5427`, 각 workflow job 정의 | 무기한 process/runner 점유 및 비용 |
| 3 | P1-5 | build 단계 권한 과다·신뢰 경계 혼재 | `release.yml:9-10,15-52`, `pr-runtime.yml:18-28,93-127` | 공급망/PR build의 blast radius |
| 4 | P1-2 | scripts 정적 검사 사각지대와 experimental Node | `package.json:11-34`, `tsconfig*.json`, `eslint.config.js:7-15` | 테스트 자체의 오류를 runtime까지 지연 |
| 5 | P1-3 | 이원화 harness·coverage 부재 | `package.json:33-40`, `vitest.config.ts:9-14` | 회귀 범위와 품질 추세를 계측할 수 없음 |
| 6 | P1-6 | dev audit 누락·unsigned stable release | `ci.yml:29-30,55-56`, `release.yml:53-101` | dependency와 배포 artifact 신뢰성 |
| 7 | P1-8 | Ubuntu/Windows/release 중복과 Rust cache 부재 | `ci.yml:12-71`, `release.yml:38-52` | 피드백 시간·runner 비용 증가 |
| 8 | P1-7 | runtime/lib.rs 모놀리스와 panic-capable invariant | `runtime.rs:1-6245`, `lib.rs:72-1698`, `gateway.rs:20-25` | 변경 영향 범위와 유지보수 위험 |
| 9 | P1-9 | Node/Rust/action toolchain floating | `package.json:1-5`, `Cargo.toml:1-7`, workflows | 동일 release 재현성 저하 |
| 10 | P2-1~P2-5 | 명시적 Vite/alias 정책, config 중복, Clippy 문서화 | 각 P2 항목 | P1 안정화 후 성능·DX·운영 효율 개선 |
