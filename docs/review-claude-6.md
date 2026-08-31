# P1-2/P1-7/P1-4 엄격 보강 — Claude 6차 사이클

- 작업일: 2026-08-30
- 대상: `docs/review-codex-5.md` 최종 조치 제안 1-4, `docs/project-review-claude.md` P1-2/P1-7/P1-4
- 커밋: 없음 (uncommitted, 검수 대기)

## 1. P1-2 — 300줄 엄격 기준

주 패널 4개를 추가 분해하여 각 파일을 300줄(비공백 기준) 이하로 낮췄습니다. `rg -c .` 기준:

| 파일 | 이전 | 이후 |
| --- | ---: | ---: |
| `src/panels/Chat.tsx` | 686 | 211 |
| `src/panels/Tuning.tsx` | 792 | 131 |
| `src/panels/Runtimes.tsx` | 823 | 131 |
| `src/panels/ExecutionProfiles.tsx` | 410 | 221 |

추출된 모든 신규 파일도 300줄 이하입니다(최댓값: `src/panels/useChatSend.ts` 282, `src/panels/useRuntimesController.ts` 277, `src/panels/useTuningController.ts` 273).

### Chat.tsx
- `useChatSend.ts` — send/streaming/tool-approval 상태 및 로직 전체 추출.
- `chatSendHelpers.ts` — 문서 검색(`retrieveDocumentContext`), 스트림 델타 핸들러 생성, MCP 도구 호출 검증(`resolveDetectedToolCall`) 등 순수 헬퍼.
- `chatSendTypes.ts` — `ChatMetrics`/`PendingToolCall`/`FailedRequest` 타입.
- `ChatThreadSidebar.tsx`, `ChatConversationHeader.tsx`, `ChatMessageLog.tsx`, `ChatComposer.tsx` — 프레젠테이셔널 컴포넌트 분리.

### Tuning.tsx
- `useTuningController.ts` — 드래프트/더티 상태, 커밋 핸들러, apply-restart 라이프사이클.
- `tuningControllerHelpers.ts` — 라벨 맵, `serverConfigSnapshot`, `commitNumericField`/`commitChatOptionField`(순수 함수), `performApplyRestart`.
- `TuningPresetBar.tsx`, `TuningServerSection.tsx`, `TuningReasoningSection.tsx`, `TuningSamplingSection.tsx`, `TuningEscapeSection.tsx`, `TuningChatOptionField.tsx` — 섹션별 프레젠테이셔널 컴포넌트.

### Runtimes.tsx
- `useRuntimesController.ts` — 백엔드 카탈로그, 디바이스 감지, PR 빌드 2단계 플로우, 포터블 번들, 로딩 프로필 상태.
- `runtimesActions.ts` — install/select/export/import/PR review·install의 순수 async 액션 함수.
- `runtimesHelpers.ts` — 캐시/상수/`BackendRow` 타입/`prSourceTitle`.
- `runtimeRowPresentation.ts` — fit/상태 뱃지 계산 순수 함수.
- `RuntimeDeviceCard.tsx`, `RuntimeCapabilitiesCard.tsx`, `RuntimePullRequestCard.tsx`, `RuntimeBackendList.tsx`, `RuntimePullRequestProvenance.tsx` — 프레젠테이셔널 컴포넌트.

### ExecutionProfiles.tsx
- `executionProfileFields.ts` — 필드 정의/상수.
- `ExecutionProfileCards.tsx` — 서버/모델 프로필 카드 프레젠테이셔널 컴포넌트.

**검증**: `npx vitest run src/panels/Models.layout.test.tsx src/modelProfiles.test.ts` 통과(3/3), 전체 `npx vitest run` 80/80 통과, `npm run typecheck`·`npm run lint` 클린.

## 2. P1-7 — Chat 스트리밍 렌더 격리

1. **`MessageBubble` memo화**: `src/panels/MessageBubble.tsx`에서 `React.memo`로 감싸고, 매 렌더 새 클로저였던 `text` prop을 제거해 `locale`(원시값)을 직접 받도록 변경. `onCopy`도 `(index, text) => void`로 시그니처를 바꿔 Chat.tsx에서 `.map` 내부 인라인 클로저 대신 안정적인 콜백 참조 하나를 전달하도록 함(`ChatMessageLog.tsx`). 이 두 변경이 없으면 memo는 매 렌더 새 함수 참조 때문에 무력화됨.
2. **rAF 취소**: `useChatSend.ts`에 `cancelScheduledRender()`를 추가해 스트림 종료(성공/도구 호출 감지/에러/중단) 등 모든 terminal 전환 지점에서 대기 중인 rAF를 명시적으로 취소하도록 함 — 대기 프레임이 뒤늦게 발화해 이미 커밋된 최종 상태를 다시 flush하는 낭비를 제거.
3. **자동화된 측정 근거**: `src/panels/MessageBubble.perf.test.tsx` 신규 — 220개 메시지를 렌더한 뒤 마지막 메시지만 스트리밍 draft로 갱신했을 때, `React.memo`로 감싼 렌더 함수가 정확히 **1회**만 호출되고 나머지 219개는 호출되지 않음을 `vi.fn()` 스파이로 직접 검증합니다. (`<Profiler>`만으로는 memo bail-out을 감지하지 못함을 직접 확인 후, 실제 프로덕션과 동일한 `memo(Component)` 래핑을 재현해 렌더 함수 호출 횟수를 스파이하는 방식으로 전환했습니다 — React DevTools Profiler 캡처의 실질적 대체 증거입니다.)

## 3. P1-4 — i18n 카탈로그

`uiI18n`/`panelI18n`/`chatI18n`은 이미 `assert*CatalogComplete()`가 있었으나 `extraI18n.ts`에는 없었습니다. `assertExtraCatalogComplete()`를 추가하고 모듈 로드 시 호출하도록 해 나머지 3개 카탈로그와 동일한 안전망을 갖췄습니다. 단일 accessor로의 완전 통합은 이번 사이클에서 수행하지 않았습니다 — `ut`/`xt`/`pt`/`getChatText`/`t` 호출부가 수백 곳(517+97+68+38 키)에 걸쳐 있어, 낮은 리스크로 이미 승인된 대안(현행 다중 카탈로그 유지 + extra assert 추가)을 택했습니다. 각 카탈로그 파일 상단에는 이미 "이 카탈로그가 무엇을 위한 것인가" 문서화가 되어 있습니다(`chatI18n.ts:3-8`, `extraI18n.ts:3-8`).

**검증**: `npm run test:i18n` 통과 (109 app keys, 68 chat keys, 97 panel keys, 38 extra keys, 517 ui keys, 4 locales).

## 4. 전체 회귀 게이트

| 게이트 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npx vitest run` (전체) | 통과 — 16 files / 80 tests |
| `npm run test:i18n` | 통과 |
| `npm run build` | 통과 |
| `cargo fmt --manifest-path src-tauri\Cargo.toml --check` | 통과 |
| `cargo clippy --manifest-path src-tauri\Cargo.toml --locked --all-targets --all-features -- -D warnings` | 통과 |
| `cargo test --manifest-path src-tauri\Cargo.toml --locked` | 통과 — lib 171 passed/1 ignored, CLI 8 passed, fake smoke 1 passed |

Rust 소스는 이번 사이클에서 변경하지 않았습니다(게이트는 기존 상태 재확인).

## 5. 다음 사이클 제안

- **P1-1** (`App.css` 1894줄, wildcard `!important` 88개): 이번 사이클에서 다루지 않음. `index.css`에 Tailwind v4 `@theme` 토큰을 도입해 `App.css:1648-1779`의 wildcard 오버라이드 블록을 제거하는 작업이 선행 리뷰(`P0-1`)와 겹치므로 별도 사이클 권장.
- P1-4를 "단일 accessor"까지 완전히 밀어붙이려면 `uiI18n.ts`(1049줄)를 도메인별로 먼저 쪼갠 뒤 진행하는 것이 안전합니다 — 현재 상태로 전체 통합을 시도하면 500개 이상의 호출부를 동시에 바꿔야 해 회귀 위험이 큽니다.
- `useChatSend.ts`(282줄)·`useRuntimesController.ts`(277줄)·`useTuningController.ts`(273줄)는 300줄 기준은 만족하지만 여유가 크지 않으므로, 이후 기능 추가 시 다시 초과하지 않도록 유의할 것.
