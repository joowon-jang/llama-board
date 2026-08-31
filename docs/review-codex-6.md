# P1-2/P1-7/P1-4 검수 — Codex 6차

- 검수일: 2026-08-30
- 대상: `docs/review-codex-5.md`의 잔여 1-4 및 `docs/project-review-claude.md` P1-2/P1-7/P1-4
- 검수 방식: 현재 worktree 정적 확인 및 npm/cargo 게이트 재실행
- 파일 수정: 본 리포트 1개만 추가함 (소스/테스트는 수정하지 않음)
- 종합 판정: **조건부 통과 — P1-2와 P1-4 및 회귀 게이트는 통과했으나, P1-7은 production callback identity 문제로 미달**

## 판정 요약

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| P1-2 패널 분리/300줄/targeted tests | 통과 | `rg -c .` 기준 주 패널 4개가 모두 300줄 이하이고, 관련 targeted Vitest 5개 파일 30개 테스트가 통과함. |
| P1-7 memoized streaming 격리 | **미달** | `MessageBubble` 자체는 `memo`화됐고 rAF 취소도 적용됐지만, `Chat.tsx`가 매 렌더 새 `onCopy` 함수를 전달해 memo bailout을 무효화함. |
| P1-7 200+ 근거/rAF 취소 | 부분 통과 | 220개 메시지용 회귀 테스트와 terminal 전환별 `cancelScheduledRender()`는 확인했으나, 테스트는 production의 불안정한 callback을 재현하지 않음. |
| P1-4 i18n | 통과(대안 경로) | 단일 accessor 통합은 하지 않았지만 `assertExtraCatalogComplete()` + `test:i18n` + 전체 npm 게이트가 통과함. |
| 전체 npm/cargo 회귀 | 통과 | `npm test`, typecheck/lint/build 및 cargo fmt/clippy/test를 이번 검수에서 재실행해 모두 exit 0. |

## 1. P1-2 — 300줄 기준과 targeted tests

현재 `rg -c . src/panels` 결과 주요 파일은 다음과 같습니다(비공백 코드 라인 기준으로 사용한 기존 리뷰 측정 방식과 동일).

| 파일 | 라인 수 |
| --- | ---: |
| `src/panels/Chat.tsx` | 211 |
| `src/panels/Tuning.tsx` | 131 |
| `src/panels/Runtimes.tsx` | 131 |
| `src/panels/ExecutionProfiles.tsx` | 221 |
| 추출 파일 최댓값 (`useChatSend.ts`) | 282 |

추출된 나머지 책임 파일도 모두 300줄 이하(`useRuntimesController.ts` 277, `useTuningController.ts` 273, `ExecutionProfileCards.tsx` 210 이하)로 확인했다.

다음 targeted 명령을 직접 실행했다.

```text
npx vitest run src/panels/Chat.test.tsx src/panels/Runtimes.test.tsx src/panels/MessageBubble.perf.test.tsx src/panels/Models.layout.test.tsx src/modelProfiles.test.ts
Test Files 5 passed (5)
Tests      30 passed (30)
```

**판정: 통과.** Chat/Runtimes 회귀, MessageBubble 성능 회귀, ExecutionProfiles를 포함하는 Models 레이아웃 및 model profile targeted 경로가 실행됐다.

## 2. P1-7 — streaming `MessageBubble` 격리 및 rAF

### 확인된 적용 사항

- `src/panels/MessageBubble.tsx:49`의 default export가 `memo(MessageBubble)`이다.
- `src/panels/ChatMessageLog.tsx:75`는 streaming 중 마지막 assistant에만 draft 객체를 만들고, 이전 bubble에는 기존 `message` reference를 유지한다.
- `src/panels/useChatSend.ts:72-83`에 예약 프레임 취소 및 draft flush가 있고, tool-call/성공/error/abort 경로(`:178`, `:193`, `:223`)에서 `cancelScheduledRender()`를 호출한다.
- `src/panels/MessageBubble.perf.test.tsx`는 220개 메시지를 렌더하고 마지막 bubble만 변경했을 때 memoized render 호출이 1회인지 검사한다. 해당 테스트는 위 targeted 및 전체 UI 게이트에 포함되어 통과했다.

### 차단 결함: production `onCopy` callback이 매 렌더 변경됨

`MessageBubble`의 주석은 `onCopy`가 안정적인 reference여야 한다고 명시하고, 성능 테스트도 `const onCopy = () => undefined`를 한 번만 만들어 이를 전제로 한다. 그러나 실제 경로는 다음과 같다.

```tsx
// src/panels/Chat.tsx:113
const copyMessage = async (index: number, text: string) => { ... };

// src/panels/Chat.tsx:171
onCopy={(index, text) => void copyMessage(index, text)}
```

`copyMessage`와 JSX wrapper 모두 `ChatPanel` 렌더마다 새 함수다. 따라서 `streamingDraft`가 rAF마다 갱신되어 `ChatPanel`이 다시 렌더될 때, 이전 219개 `MessageBubble`도 `onCopy` prop 변경으로 memo 비교를 통과하지 못하고 다시 렌더된다. 즉 `MessageBubble`의 memo 선언과 synthetic 220-message 테스트는 존재하지만, 실제 production hot path에서의 렌더 격리는 입증되지 않는다.

**판정: 미달.** `ChatPanel`에서 stable `useCallback`을 사용해 `onCopy` reference를 고정하거나, 동일한 안정성 보장을 하는 별도 callback 경로를 도입한 뒤 production `ChatMessageLog`를 대상으로 200+ 메시지 테스트를 다시 실행해야 한다. 현재 성능 테스트의 `const onCopy` 안정화만으로는 이 결함을 검출하지 못한다.

추가로 현재 테스트는 React DevTools `<Profiler>` 캡처가 아니라 `memo()` + render spy 기반 자동 대체 근거다. 이 방식 자체는 bailout을 검증할 수 있으나, 위 callback identity를 실제 부모 경로에서 검증하도록 보강해야 한다.

## 3. P1-4 — i18n 완전성/통합

단일 accessor(`t(locale, key)`)로의 완전 통합은 이번 사이클에 수행되지 않았으며 `ut`/`pt`/`xt`/`getChatText`/`useI18n().t`가 여전히 공존한다. 다만 선행 리뷰가 허용한 대안 경로인 “현행 다중 catalog 유지 + extra 런타임 assert”는 적용됐다.

- `src/extraI18n.ts:47-55`의 `assertExtraCatalogComplete()`가 en key 전체에 대해 ko/en/ja/zh의 누락·빈 문자열을 검사하고 모듈 로드 시 호출한다.
- `scripts/test-i18n.ts:47`이 extra catalog를 포함한 모든 locale/key를 검사한다.
- `npm run test:i18n` 직접 실행 결과:

```text
i18n catalog and preference validation passed (109 app keys, 68 chat keys, 97 panel keys, 38 extra keys, 517 ui keys, 4 locales)
```

**판정: 통과(대안 경로).** 단일 accessor 요구를 별도로 강제하는 조건이라면 미완료지만, “extra assert + test:i18n + 전체 npm 게이트” 조건은 충족한다. 참고로 `ja`/`zh` extra catalog 일부는 `en` spread fallback을 사용하므로, 현재 assert는 번역 누락이 아니라 key 누락/빈 문자열만 보장한다.

## 4. 전체 회귀 게이트

### npm

직접 실행 결과:

| 명령 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과(exit 0) |
| `npm run lint` | 통과(exit 0) |
| `npm run test:i18n` | 통과 — 109/68/97/38/517 keys, 4 locales |
| `npx vitest run` | 통과 — 16 files / 80 tests |
| `npm run build` | 통과 — Vite production build 완료 |
| `npm test` | 통과 — utility scripts, i18n, UI 16 files / 80 tests 포함 |

Vitest 실행 중 jsdom의 `HTMLCanvasElement.getContext()` 미구현 안내 2건은 있었지만 테스트 exit code는 0이며 실패로 집계되지 않았다.

### cargo

직접 실행 결과:

| 명령 | 결과 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri\\Cargo.toml --check` | 통과(exit 0) |
| `cargo clippy --manifest-path src-tauri\\Cargo.toml --locked --all-targets --all-features -- -D warnings` | 통과(exit 0) |
| `cargo test --manifest-path src-tauri\\Cargo.toml --locked` | 통과 — lib 171 passed/1 ignored, CLI 8 passed, fake smoke 1 passed |

Cargo 명령에는 Windows 경로 canonicalize/linker 관련 warning이 일부 출력됐지만, formatter/clippy/test 모두 실패 없이 종료했다.

## 최종 결론 및 조치

P1-2는 구조 분리와 targeted tests까지 완료되어 통과다. P1-4는 단일 accessor 대신 extra assert 대안으로 통과했고, 전체 npm/cargo 회귀 게이트도 통과했다. 다만 P1-7은 `Chat.tsx:171`의 매 렌더 새 `onCopy` callback 때문에 streaming 중 이전 bubble까지 재렌더될 수 있으므로, 해당 callback 안정화와 production 경로 성능 테스트 보강 전에는 최종 sign-off할 수 없다.
