# P1-2 scripts 정적 검사 최종 검수 — Codex 22차

- 검수일: 2026-08-31
- 대상: Claude 21차의 `tsconfig.scripts.json`, `@types/node`/typecheck script, scripts·Vite ESLint 범위, 관련 Node 테스트 보강
- 검수 방식: 기존 uncommitted 변경과 소스는 보존하고 read-only로 검수했다. 이 리포트만 새로 작성했다.
- 종합 판정: **통과 — P1-2의 정적 검사 공백은 해소됐다.** `tsc`/ESLint/npm 회귀 게이트는 모두 통과했으며, project-reference build graph와 Node/toolchain 고정은 후속 P2/P1-9 범위로 남는다.

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| scripts TypeScript 포함 범위 | 통과 | `tsconfig.scripts.json:3-19`가 `scripts/**/*.ts`, `vite.config.ts`를 include하고 `strict`, `noUnused*`, `noFallthroughCasesInSwitch`, `noEmit`을 사용한다. `--showConfig`에서 24개 script와 Vite config가 모두 resolved files로 나타났다. |
| Node builtin/global 및 imported DOM 타입 | 통과 | `types: ["node"]`와 `lib: ["ES2022", "DOM", "DOM.Iterable"]`가 함께 적용된다. `tsc --listFilesOnly`에 `@types/node`, `undici-types`, `lib.dom.d.ts` 및 import된 `src` 모듈이 실제 출력됐다. |
| references/build semantics | 통과(주의) | root `tsconfig.json:23-24`의 기존 `tsconfig.node.json` reference는 유지되고, `tsconfig.node.json:9`의 Vite 포함도 유지된다. `tsconfig.scripts.json`은 독립 no-emit 프로젝트이며 `npm run typecheck`가 두 프로젝트를 명시적으로 순서대로 검사한다. `tsc --build tsconfig.json --dry` 자체는 root/node만 보여 주므로, project-reference build graph에도 scripts를 넣어야 한다는 요구가 생기면 별도 aggregator/reference를 후속 도입해야 한다(P2). |
| Vite `process` suppression 제거 | 통과 | `vite.config.ts:5`는 `process.env.TAURI_DEV_HOST`를 직접 사용하고 기존 `@ts-expect-error`가 제거됐다. Node 타입 해석과 `npm run typecheck`, `npm run build`가 모두 통과했다. |
| package/lockfile 재현성 | 통과 | `package.json:35,54`의 scripts와 `@types/node` 추가가 lockfile root entry(`package-lock.json:21`) 및 고정 package/integrity(`:2393`, `:7024`)와 일치한다. `npm ci --ignore-scripts --dry-run`이 exit 0이다. |
| ESLint 범위와 규칙 | 통과 | `eslint.config.js:9`에서 기존 `scripts/**` 전체 ignore가 제거되고 `scripts/build-cli.mjs`만 명시적으로 제외됐다. `:43-51`의 Node override는 `process`, `console`, `globalThis`를 readonly로 허용하며 src의 React/hooks/a11y 규칙(`:14-39`)은 바뀌지 않았다. |
| 네 개 script 변경의 동작 영향 | 통과(테스트 전용 보강 주의) | `test-sse.ts`와 `test-model-selection-paths.ts`의 최신 수정은 erased type import/annotation/cast다. `test-project-store.ts`는 현재 `AppConfig`의 새 필드 네 개를 fixture에 채우고, `test-i18n.ts`는 type import/key cast 외에 unified accessor 회귀 assertion을 포함한다. 모두 production source 동작은 바꾸지 않지만 후자의 두 파일은 문자 그대로 “type-only”는 아니며 test harness의 fixture/검증 범위를 보강한다. |

## 2. TypeScript 정적 증거

`tsconfig.scripts.json`의 resolved 옵션은 다음과 같았다.

- `target: es2022`, `module: esnext`, `moduleResolution: bundler`
- `lib: es2022, dom, dom.iterable`
- `types: node`, `strict: true`, `noEmit: true`
- `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` 활성화
- `include: scripts/**/*.ts`, `vite.config.ts`

`tsc --showConfig -p tsconfig.scripts.json`은 다음 25개 source file을 열거했다: `scripts` 24개와 `vite.config.ts` 1개. `tsc --listFilesOnly`에는 `lib.dom.d.ts`, Node의 `process.d.ts`/builtin declaration, `undici-types`, 그리고 scripts가 import하는 `src/sse.ts`, `src/api.ts`, `src/projectStore.ts` 등 DOM 의존 source가 포함됐다. 따라서 단순 config 선언만이 아니라 현재 파일 graph와 Node/DOM declaration resolution을 실제 확인했다.

기존 root project는 `src`만 include하고 `tsconfig.node.json`을 reference한다(`tsconfig.json:23-24`). 일반 `tsc -p tsconfig.json` 또는 `tsc --build tsconfig.json`은 새 scripts project를 자동으로 끌어오지 않지만, canonical command가 `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.scripts.json`이므로 `npm run typecheck`에서는 누락되지 않는다. 이 분리를 project references에 억지로 연결하지 않은 것은 현재 no-emit 검사 목적에는 안전하다.

## 3. package, ESLint, Vite 검수

`package.json:9-10`의 `lint`와 `lint:fix`는 동일하게 `src scripts vite.config.ts`를 대상으로 하고, `lint:fix`만 `--fix`를 추가한다. 이번 검수는 read-only 조건 때문에 `lint:fix`를 실행하지 않았지만, 명령 정의상 검사 대상은 동일하며 source mutation을 피했다. `eslint --debug scripts vite.config.ts`는 `25 file(s) found`를 기록했고, 24개 `scripts/**/*.ts`와 `vite.config.ts` 각각에 대해 parsing/scope analysis를 수행했다. `scripts/build-cli.mjs`는 config 계산 대상이지만 global ignore로 lint 대상에서 제외되어 요청된 예외와 일치한다.

Node override의 `process`, `console`, `globalThis`는 `eslint --print-config`에서도 readonly로 확인됐다. src block의 `react/jsx-no-target-blank`, hooks, `jsx-a11y/alt-text`, console/debugger 등 기존 규칙은 diff에서 건드리지 않았고, script lint 전용 override는 경고 수준의 `no-explicit-any`/`no-unused-vars`만 재선언한다.

`vite.config.ts`는 `process`를 `@types/node`로 해결하고, Vite plugin/server 설정은 변경하지 않는다. 실제 production build에서도 동일 config가 로드되어 성공했다.

## 4. script-test 변경의 동작 영향

| 파일 | 현재 변경 | 검수 결과 |
| --- | --- | --- |
| `scripts/test-sse.ts` | `StreamDelta` type import와 `const deltas: StreamDelta[]` annotation | type erasure 후 runtime 동일; SSE assertion 결과 동일 |
| `scripts/test-model-selection-paths.ts` | `AppConfig` type import와 `normalizeConfigPatch(...) as Partial<AppConfig>` | import/cast 모두 runtime에 남지 않음; path assertion 동일 |
| `scripts/test-project-store.ts` | `parallel`, `request_timeout_seconds`, `sleep_idle_seconds`, `lora_adapters`를 AppConfig fixture에 추가 | fixture runtime 값은 늘지만 `normalizeConfig`가 현재 AppConfig 계약을 충족하도록 만든 test-only 보강이며 production code 변경 없음 |
| `scripts/test-i18n.ts` | catalog key type import/cast; 기존 unified routing, placeholder, unknown-key, locale fallback assertion 포함 | assertion은 test harness 동작을 확장하지만 app runtime은 변경하지 않음. `finally`로 임시 catalog mutation을 복구하고 전체 test에서 통과 |

즉 네 파일에 production behavior change는 없지만, “모든 수정이 타입 오류만 해결”이라고 기술하는 것은 정확하지 않다. `test-i18n.ts`의 unified/fallback 검증과 `test-project-store.ts`의 fixture field 추가는 의도적인 테스트 보강으로 분류하는 것이 맞다.

## 5. 실행 결과

실행 환경은 Node `v22.23.2`, npm `12.0.2`, TypeScript `5.8.3`, ESLint `9.39.5`, Vitest `4.1.11`이었다.

| 명령 | 결과 |
| --- | --- |
| `npm ci --ignore-scripts --dry-run` | 통과, exit 0 — lockfile 재현성 확인 |
| `npm run typecheck` | 통과, exit 0 — root `src`와 scripts/Vite project 모두 검사 |
| `npm run lint` | 통과, exit 0 — src + scripts + `vite.config.ts` |
| `npm test` | 통과, exit 0 — 24개 direct Node script와 Vitest 18 files / 84 tests |
| `npm run build` | 통과, exit 0 — root `tsc` 및 Vite production build(121 modules) |
| `git diff --check` | 통과 — 기존 LF→CRLF 경고만 있었고 whitespace error 없음 |

Vitest 실행 중 jsdom의 `HTMLCanvasElement.getContext()` 미구현 경고가 두 번 출력됐지만 test failure는 아니며 84/84 assertion이 통과했다. 기존 uncommitted source에는 손대지 않았고 `git status` 확인 결과 검수 리포트 외에 이번 작업으로 추가된 source 변경은 없다.

## 6. 남은 P1-3 / P1-9 범위

### P1-3 — 부분 개선됐지만 미해결

현재 `npm test`(`package.json:34`)는 24개 direct Node script를 `&&`로 직렬 실행한 뒤 별도 `vitest run`(`:41`)을 호출한다. 이번 `test:models-css` 추가와 UI 18 files/84 tests는 회귀 범위를 넓혔지만, `vitest.config.ts`는 여전히 `src/**/*.test.{ts,tsx}`만 include하고 coverage provider/threshold/report artifact가 없다. direct assertion을 한 runner/`test:unit`·`test:ci` 진입점으로 통합하고 coverage baseline을 도입하는 작업은 남아 있다.

### P1-9 — 미해결

`package.json:2-5`에는 `engines`/`packageManager`가 없고, CI/release는 Node major `22`와 Rust `stable`, action tag(`@v4`, `@v2`)를 사용한다. lockfile은 npm dependency version/integrity만 고정하므로 Node `--experimental-strip-types`, Rust MSRV/toolchain, third-party action revision은 고정하지 않는다. 이번 `@types/node` 추가와 scripts 정적 검사는 P1-9의 Node/Rust/action pinning을 해결하지 않으므로 exact Node minor, `rust-toolchain.toml`/`rust-version`, immutable action SHA를 별도 범위로 남긴다.

## 결론

P1-2 acceptance 기준인 scripts/Vite의 strict no-emit TypeScript 검사, Node/DOM 타입 해석, lockfile 재현성, src+scripts ESLint 범위, 네 개 test script의 production 동작 보존, `typecheck`/`lint`/`test`/`build` 회귀 게이트를 모두 통과했다. 승인 가능한 상태이며, 후속 우선순위는 P1-3의 단일 test harness/coverage와 P1-9의 toolchain pinning이다.
