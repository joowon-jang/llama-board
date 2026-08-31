# P1-3 테스트 harness/coverage 최종 검수 — Codex 24차

- 검수일: 2026-08-31
- 대상: Claude 23차의 `package.json` test entrypoint, direct runner/harness, Vitest coverage 설정, README/.gitignore/package-lock 변경
- 검수 원칙: 기존 uncommitted 변경과 소스를 보존하고 read-only 검증을 수행했다. 이 파일만 새 검수 산출물로 작성했다.
- 실행 환경: Windows, Node `v22.23.2`, npm `12.0.2`, Vitest `4.1.11`
- 종합 판정: **조건부 통과** — canonical gate, 24개 direct script 실행, fail-fast/status 처리, V8 coverage와 실제 threshold gate는 통과했다. 다만 README의 typecheck 예시/역사 설명, Vitest의 로드된 `src` 범위 한계, runner의 cwd 결합과 harness drift 검출 공백은 P2 후속으로 남긴다. P1-9 toolchain pinning은 이번 범위에서 해결되지 않았다.

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| `test:unit` / `test:direct` / `test:coverage` 구성 | 통과 | `package.json:34-38`에서 harness → direct runner → coverage 순서로 직렬 실행하고 `npm test`가 `test:unit`을 alias한다. |
| 24개 direct script 순서·출력 | 통과 | `scripts/run-direct-tests.ts:39-64`의 24개 목록. `npm run test:direct`에서 출력 순서가 목록과 일치했고 전부 통과했다. 기존 HEAD의 23개 Node script prefix도 그대로 유지되고 `test-models-css`가 추가됐다. |
| fail-fast·exit code·신호 status | 통과(제한 명시) | `runDirectTests`가 `status ?? 1`을 기록하고 `code !== 0`에서 즉시 반환한다(`scripts/run-direct-tests.ts:24-34`). 실제 status `7` 수동 probe도 `exitCode: 7`을 보존했다. `null`(signal/spawn failure)은 안전한 실패 코드 `1`로 정규화되어 signal 종류 자체는 보존하지 않는다. |
| Windows/Node 22 명령 호출 안전성 | 통과(직접 실행 경로) | `spawnSync(process.execPath, args, { stdio: "inherit" })`로 shell을 사용하지 않고 고정된 script 목록을 argv로 전달한다(`scripts/run-direct-tests.ts:66-67`). Node 22 Windows에서 전체 runner가 exit 0으로 완료했다. 상대 script path는 npm의 repo-root cwd에 의존한다(P2). |
| harness self-test | 통과 | `scripts/test-run-direct-tests.ts:4-5,8-42`가 24개/중복 없음, 전체 성공 순서, 중간 실패 시 후속 미실행, `null` status 실패를 검증한다. package.json과의 자동 대조 및 임의 non-1 status assertion은 없다(P2). |
| V8 coverage/reports/threshold | 통과(범위 제한) | `vitest.config.ts:14-31`의 `provider: "v8"`, text/json-summary/html reporter, `coverage/` 출력과 0이 아닌 40/35/35/45 threshold가 실제로 적용됐다. 18 files/84 tests와 summary 파일이 생성됐고 100% lines override는 exit 1로 거부됐다. |
| README/.gitignore/package-lock | 조건부 통과 | coverage ignore 및 lockfile dependency/peer resolution은 일치한다. README의 raw typecheck 명령은 새 scripts project를 검사하지 않으며, runner 주석의 “historical ... test-models-css” 표현은 HEAD 사실과 다르다(P2). |

## 2. Canonical package scripts와 direct sequence

현재 entrypoint는 다음과 같다(`package.json:34-38`).

```text
test:run-direct-tests -> test:direct -> test:coverage
test:unit            = 위 체인
test                 = test:unit
test:coverage        = vitest run --coverage
```

`git show HEAD:package.json`의 기존 `npm test` 체인에서 Node assertion script 23개의 순서를 추출해 현재 목록의 앞 23개와 비교한 결과, prefix가 정확히 일치했다. 기존 마지막 Vitest 단계는 `test:coverage`로 바뀌었고, 현재 목록의 24번째 `scripts/test-models-css.ts`는 기존 chain에는 없던 새 direct regression check다. 따라서 “기존 23개 direct의 순서/출력/fail-fast 보존 + 새 24번째 check 추가”로 해석하는 것이 정확하다.

실제 `npm run test:direct` 출력 순서는 다음과 같았다.

```text
1  test-tuning-validation.ts
2  test-advanced-settings.ts
3  test-sse.ts
4  test-chat-stream.ts
5  test-endpoint-adapters.ts
6  test-chat-history.ts
7  test-document-context.ts
8  test-document-index.ts
9  test-discover-utils.ts
10 test-developer-utils.ts
11 test-mcp-utils.ts
12 test-runtime-utils.ts
13 test-config-schema.ts
14 test-config-save-queue.ts
15 test-scan-generation.ts
16 test-vision-state.ts
17 test-tuning-async.ts
18 test-model-row-events.ts
19 test-model-selection-paths.ts
20 test-project-store.ts
21 test-lifecycle-utils.ts
22 test-storage.ts
23 test-i18n.ts
24 test-models-css.ts
```

`runDirectTests`는 동기 `for...of`로 한 번에 하나의 child만 실행하고, `status`가 0이 아니면 결과를 남긴 뒤 즉시 반환한다(`scripts/run-direct-tests.ts:24-34`). `spawnWithNode`는 `process.execPath`를 executable로 사용하고 별도의 `shell` 옵션을 켜지 않으므로 script 이름이 shell metacharacter로 해석되지 않는다. 목록도 상수이며 사용자 입력을 명령 문자열에 이어 붙이지 않는다. `stdio: "inherit"`와 동기 wait는 기존 child output의 순서와 fail-fast 동작을 보존한다.

Windows/Node 22에서 forward-slash 상대 path가 정상 해석되고 24개 결과가 그대로 출력됐다. 다만 child path는 `cwd`를 명시하지 않아 상속된 cwd 기준으로 해석된다(`scripts/run-direct-tests.ts:66-67`). `npm run test:direct`/`npm test`에서는 npm이 package root를 cwd로 잡으므로 안전하지만, 다른 디렉터리에서 `node <absolute-path-to-runner>`로 직접 실행하는 API 계약까지 보장하지는 않는다. 또한 `spawnSync`의 `status: null`은 실제 signal 번호나 spawn error를 구분하지 않고 1로 변환한다(`scripts/run-direct-tests.ts:27-31`); 실패를 누락하지 않는 정책으로는 안전하지만 원인 진단 정보는 잃는다.

## 3. Harness self-test 검수

`scripts/test-run-direct-tests.ts`는 다음을 검증하고 `npm run test:run-direct-tests`에서 exit 0으로 통과했다.

- `DIRECT_TEST_SCRIPTS.length === 24` 및 중복 없음(`:4-5`)
- 모든 callback이 status 0이면 입력 순서대로 모두 호출되고 summary가 exit 0(`:8-23`)
- 중간 callback이 status 1이면 그 script까지만 호출되고 후속 script는 호출되지 않음(`:27-36`)
- callback이 `status: null`을 반환하면 stoppedAt과 exitCode 1로 실패(`:38-43`)

이는 harness의 핵심 failure propagation을 검증한다. 별도의 수동 probe에서 status 7도 `results`와 `exitCode`에 7로 보존됐다.

남은 검증 공백은 P2다. self-test는 package.json의 script 이름/명령과 `DIRECT_TEST_SCRIPTS`를 기계적으로 비교하지 않고, 목록 길이만 24로 고정한다(`:4-5`). 따라서 같은 길이로 script가 교체되거나 package script가 rename되어도 self-test는 잡지 못한다. 또한 status 1 외의 non-zero 값과 실제 `spawnSync` error/Windows child termination은 helper callback으로만 추상화되어 있다.

## 4. Coverage provider, report, threshold

`vitest.config.ts:14-21`은 `@vitest/coverage-v8`가 제공하는 V8 provider와 `text`, `json-summary`, `html` reporter를 사용하고 `coverage/`에 보고서를 기록한다. package/lockfile도 일치한다.

- `package.json:62` — `@vitest/coverage-v8: ^4.1.11`
- `package-lock.json:25,2750-2775` — root dependency, resolved `4.1.11`, integrity, Vitest peer `4.1.11`
- `npm ls @vitest/coverage-v8 vitest --depth=0` — 두 package 모두 `4.1.11`
- `package.json:63`의 `axe-core`도 `src/components/CustomSelect.test.tsx`에서 실제 import된다.

실행 결과는 다음과 같았다.

```text
Test Files  18 passed (18)
Tests       84 passed (84)
Statements  46.57% (1664/3573)
Branches    39.9%  (1285/3220)
Functions   43.73% (433/990)
Lines       51.09% (1452/2842)
```

설정 threshold는 statements 40, branches 35, functions 35, lines 45(`vitest.config.ts:26-31`)로 모두 0이 아니다. 정상 `npm run test:coverage`는 exit 0이었다. 추가로 `npx --no-install vitest run --coverage --coverage.thresholds.lines=100`을 실행했을 때 모든 18/84 테스트는 통과했지만 `Lines 51.09% does not meet global threshold (100%)`로 exit 1을 반환했다. 따라서 report만 생성하고 gate를 통과시키는 형식적 설정이 아니며 threshold 평가가 실제로 process status에 반영된다.

coverage 범위는 의도적으로 제한되어 있다. `vitest.config.ts:13`의 test include는 `src/**/*.test.{ts,tsx}`이고, `coverage.include` 또는 `coverage.all`은 설정하지 않았다. 따라서 V8은 Vitest process에서 import된 `src` module graph를 측정하며, 테스트가 전혀 import하지 않는 source module은 global denominator에 들어오지 않는다. 실제 summary에는 `src/App.tsx` 같은 미로드 entrypoint가 없고, 로드된 `src/endpointAdapters.ts`도 0%로 포함되는 식이다. 이는 direct Node script를 억지로 Vitest instrumentation 아래에 넣지 않은 이유와 맞는다.

24개 direct script는 `npm run test:direct`에서 별도 Node child process로 실행되므로 현재 V8 report에 포함되지 않는다(`vitest.config.ts:15-18`, `README.md:122-129`). 이 분리는 direct assertion output/실행 semantics를 보존하는 장점이 있지만, direct script 자체의 line/branch coverage와 Vitest가 로드하지 않는 frontend module의 coverage를 품질 gate가 감시하지 못한다. scope는 README와 config 주석에 문서화되어 있으므로 현재 P1-3 gate 실패는 아니지만, 전체 `src` 계측(`coverage.all`/explicit include) 또는 direct test migration은 P2 후속이다.

`.gitignore:38-39`의 `coverage/`는 생성된 HTML/JSON/text artifact를 source 변경으로 남기지 않는 데 적절하다. 현재 CI는 report artifact를 upload하지 않으므로 CI run 종료 후 HTML/JSON 추세를 보존하지 않는 운영상 한계가 있다(P2); threshold 자체는 CI stdout과 exit code로 적용된다.

## 5. README/comment 및 기타 findings

### P2-1 — README의 canonical typecheck 명령이 scripts project를 빠뜨림

- 위치: `README.md:113-119`, `package.json:39`, `tsconfig.scripts.json:1-19`
- README validation block은 `npx tsc --noEmit -p tsconfig.json`만 안내한다(`:117`). 현재 canonical `npm run typecheck`는 root project와 `tsconfig.scripts.json`을 모두 검사한다(`package.json:39`). 따라서 README만 따라가면 `scripts/run-direct-tests.ts`와 harness의 정적 검사를 누락하고 build는 green일 수 있다.
- 권장: README 예시를 `npm run typecheck`로 바꾸거나 두 `tsc` 명령을 모두 명시한다.

### P2-2 — runner 주석의 historical claim이 실제 HEAD와 다름

- 위치: `scripts/run-direct-tests.ts:37-38`
- 주석은 “historical `npm test` `&&` chain (test:tuning through test:models-css)”라고 설명하지만 HEAD의 chain은 `test:tuning`부터 `test:i18n`까지 23개 direct script 뒤에 `test:ui`를 호출한다. `test-models-css`는 이번 목록에 추가된 24번째 check다.
- 실제 실행 순서는 의도대로 동작하고 기존 23개 prefix도 보존되므로 기능 blocker는 아니다. 주석을 “legacy chain + test-models-css”처럼 고치면 유지보수 시 provenance 오해를 막을 수 있다.

### P2-3 — harness의 package drift 및 direct invocation cwd 검출 공백

- 위치: `scripts/test-run-direct-tests.ts:4-5`, `scripts/run-direct-tests.ts:66-67`
- 길이/중복 assertion만으로는 package.json의 script rename, runner 누락/교체, package entrypoint와 runner 순서 drift를 검출하지 못한다. runner의 상대 path는 npm root 밖에서 직접 호출할 때 깨질 수 있다.
- 권장: package script metadata와의 set/order assertion 또는 단일 metadata source를 두고, 필요하다면 runner에서 `process.cwd()`/repo root를 명시적으로 고정한다. signal은 null→1 정책을 유지하되 stderr에 signal/spawn error 원인을 구분하면 진단성이 좋아진다.

이 세 항목은 현재 requested npm entrypoint와 실제 Windows run을 실패시키지 않는 P2 보강 사항이다. shell injection 경로, child non-zero fail-fast, coverage threshold false-green은 확인되지 않았다.

## 6. 실행 결과

| 명령 | 결과 | 관찰 |
| --- | --- | --- |
| `npm ci --ignore-scripts --dry-run` | **통과**, exit 0 | lockfile과 package root dependency 일치, `up to date` |
| `npm run typecheck` | **통과**, exit 0 | root `tsc`와 scripts/Vite `tsc` 모두 실행 |
| `npm run lint` | **통과**, exit 0 | `eslint src scripts vite.config.ts` |
| `npm test` | **통과**, exit 0 | harness → 24 direct scripts → Vitest coverage; 18 files/84 tests; coverage summary 위 수치 |
| `npm run test:coverage` | **통과**, exit 0 | V8 provider banner, text/json-summary/html report 생성, threshold 통과 |
| threshold probe (`npx --no-install vitest run --coverage --coverage.thresholds.lines=100`) | **의도된 실패**, exit 1 | 51.09% < 100%로 `ERROR: Coverage for lines ...` 확인 |
| `npm run build` | **통과**, exit 0 | TypeScript + Vite production build, 121 modules transformed |
| `git diff --check` | **통과** | 기존 LF→CRLF 경고만 있고 whitespace error 없음 |

Vitest 실행에서 jsdom의 `HTMLCanvasElement.getContext()` 미구현 경고가 2회 출력됐으나 84/84 test와 coverage gate에는 영향을 주지 않았다. 검수 중 coverage/dist 같은 생성물은 ignore 상태이며, 기존 dirty worktree의 source/설정 변경은 건드리지 않았다.

## 7. 남은 P1-9

P1-9 toolchain pinning은 여전히 미해결이다.

- `package.json:1-5`에 `engines`/`packageManager`가 없다.
- direct runner가 Node 22의 `--experimental-strip-types`에 의존한다(`package.json:11-45`, `scripts/run-direct-tests.ts:66-67`). CI/release는 Node major `22`만 지정한다(`.github/workflows/ci.yml:22-24,51-54`, `.github/workflows/release.yml:26-29`).
- Rust CI는 `stable` floating이고 manifest에 MSRV/rust-version을 선언하지 않으며, workflow action ref도 tag 기반이다. 이 범위의 npm harness/coverage 변경은 이를 고정하지 않는다.

후속으로 검증한 Node exact minor와 `engines`/`packageManager`, `rust-toolchain.toml` 또는 `rust-version`, immutable action SHA를 선언하고 clean checkout에서 동일 gate를 재실행해야 한다.

## 결론

P1-3의 핵심 acceptance는 충족한다. canonical `npm test`가 harness self-test, 24개 direct assertion script, 실제 V8 coverage threshold를 순서대로 실행하고, Windows/Node 22에서 출력·fail-fast·non-zero status 전달이 정상 동작했다. 위 P2 문서/maintainability/scope 한계와 P1-9 toolchain pinning을 후속으로 남긴 **조건부 통과**다.
