# P1-2/P1-7/P1-4 잔여 검수 — Codex 5차

- 검수일: 2026-08-30
- 대상: Claude 5차 반영 후 현재 worktree
- 변경 범위: 검수 리포트만 추가했으며 소스/테스트 파일은 수정하지 않음
- 종합 판정: **조건부 통과 — P1-2는 기준 미달, P1-7과 P1-4는 증거/게이트 보완 필요**

## 판정 요약

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| Chat warning 직접 검증 | 통과 | `src/panels/Chat.test.tsx:112`가 `screen.findByRole("status", { name: "Context warning" })`를 직접 호출하고, `src/panels/Chat.tsx:633`이 `role="status"`와 `aria-label={ct("contextWarningLabel")}`를 제공함. Chat DOM에서 해당 accessible name은 고유함. |
| P1-2 책임 분리/300줄 | 미달(부분 분해) | 추출된 훅/컴포넌트는 300줄 미만이지만 주 패널과 `ExecutionProfiles`가 여전히 300줄을 초과함. |
| P1-7 streaming 비용 | 부분 통과 | rAF hot path에서 `msgs` 복제는 제거됐으나 200+ 메시지 Profiler 측정 증거가 없고, `streamingDraft` 변경마다 전체 `msgs.map`이 실행됨. |
| P1-4 i18n 완전성/통합 | 조건부 | UI/panel/chat 런타임 완전성 검사는 존재하지만 extra에는 대응 assert가 없고, 패널/Chat이 아직 `ut`/`pt`/`xt`/`getChatText`로 분리되어 있음. npm 게이트를 현재 환경에서 실행하지 못함. |

## 1. Chat warning 검증

`Chat.test.tsx:112`의 보조 함수는 다음처럼 역할과 accessible name으로 비동기 경고를 직접 찾는다.

```ts
await screen.findByRole("status", { name: "Context warning" });
```

경고 DOM은 `Chat.tsx:633`에서 `role="status"` 및 `aria-label={ct("contextWarningLabel")}`를 함께 사용한다. 다른 status 영역은 이름이 없거나 “Response metrics” 등 다른 이름을 사용하므로 “Context warning” 조회는 고유하다. 현재 테스트는 `I18nProvider initialLocale="en"` 기준이며, 다른 locale에서 번역된 accessible name을 검증하는 테스트는 없다.

**판정: 통과.** 향후 패널 외부까지 포함하는 통합 렌더가 추가되면 `within`으로 Chat root를 한정하는 것이 더 안전하지만, 현재 테스트 범위에서는 고유 accessible name으로 충분하다.

## 2. P1-2 책임 분리와 300줄 기준

`rg -c .` 기준 비공백 라인 수는 다음과 같다.

| 파일 | 비공백 라인 |
| --- | ---: |
| `src/panels/Chat.tsx` | 686 |
| `src/panels/Tuning.tsx` | 792 |
| `src/panels/Runtimes.tsx` | 823 |
| `src/panels/ExecutionProfiles.tsx` | 410 |
| `src/panels/useChatThreads.ts` | 124 |
| `src/panels/useChatAttachments.ts` | 64 |
| `src/panels/useChatMcpTools.ts` | 56 |
| `src/panels/TuningSpeculativeSection.tsx` | 139 |
| `src/panels/RuntimeLoadingProfiles.tsx` | 53 |
| `src/panels/RuntimePortableBundle.tsx` | 58 |

Chat의 threads/attachments/MCP 책임과 Tuning/Runtimes 일부 UI는 추출됐고 추출 단위는 기준 이내다. 그러나 주 패널 세 파일과 `ExecutionProfiles`는 여전히 300줄을 초과하므로 “각 책임 파일 300줄 이하”라는 선행 리뷰의 엄격한 완료 조건은 충족하지 않는다. `Models.layout.test.tsx`와 `modelProfiles.test.ts`는 소스 구조상 관련 경로가 유지되지만, 아래 npm 부재로 이번 검수에서 실행 결과를 확인하지 못했다.

**판정: 미달(부분 분해).** 남은 패널의 검증/렌더링/상태 책임을 추가로 분리하고 targeted test를 실행해야 한다.

## 3. P1-7 Chat streaming 프레임 비용

현재 `Chat.tsx`는 `streamingDraft`(`:101`)와 `streamRef`를 별도로 두고, rAF callback(`:201-204`)에서 assistant/reasoning 문자열만 draft로 flush한다. hot path에는 전체 `msgs` 배열의 `slice()` 복제가 없으며, `slice()` 사용은 문서 검색 상한 및 terminal/tool/error 처리 등 비프레임 경로에만 남아 있다. 이는 기존 프레임별 `current.slice()` 문제를 제거한 정적 근거다.

다만 렌더링(`Chat.tsx:614`)에서는 draft가 바뀔 때마다 `msgs.map`이 다시 실행되고 마지막 메시지 객체를 새로 만든다. `MessageBubble`이 memoized list item으로 분리되어 있지 않으며, 200개 이상 메시지에 대한 React DevTools Profiler 결과나 성능 회귀 테스트도 저장소에서 확인되지 않았다. 따라서 “Profiler 상 프레임 비용 개선”까지는 입증할 수 없고, 긴 대화에서 나머지 bubble 렌더 비용이 남아 있을 가능성이 있다.

**판정: 부분 통과.** streaming bubble을 별도 memoized 컴포넌트/가상화 경로로 격리하고, 200+ 메시지 시나리오의 Profiler 캡처 또는 자동화된 측정 결과를 추가해야 최종 통과로 올릴 수 있다. terminal/error/tool 전환 시 대기 중인 rAF도 취소하면 불필요한 최종 draft flush를 줄일 수 있다.

## 4. P1-4 i18n 카탈로그 완전성 및 통합

- `uiI18n.ts:1043`의 `assertUiCatalogComplete()`와 module-load 호출(`:1051`)은 en/ko/ja/zh의 UI key 누락/빈 문자열을 검사한다.
- `panelI18n.ts:23-24` 및 `chatI18n.ts:28-36`도 각 locale의 완전성 검사와 호출을 제공한다.
- `extraI18n.ts`는 `Record<ExtraTextKey, string>` 타입과 `scripts/test-i18n.ts`의 수동 key 검사를 사용하지만 `assertExtraCatalogComplete()` 런타임 함수는 없다.
- `i18n.ts`의 base `messages`는 `useI18n().t`로 제공되지만, 패널/Chat은 여전히 `ut`, `pt`, `xt`, `getChatText` 등 별도 accessor를 사용한다. 따라서 “단일 카탈로그 namespace/accessor” 통합은 아직 초안/부분 상태다.
- `scripts/test-i18n.ts`와 `package.json`의 `test:i18n` 경로는 모든 카탈로그와 locale 옵션을 점검하도록 연결되어 있다.

정적 검토상 locale 객체의 required key 구조와 UI/panel/chat assert 연결은 타당하다. 그러나 현재 환경에서는 npm을 실행할 수 없어 assert 및 전체 npm 회귀를 실제로 통과했는지 확인하지 못했으므로, 이번 검수에서 P1-4를 무조건 통과로 확정하지 않는다.

**판정: 조건부 통과.** 단일 accessor가 완료 조건이면 카탈로그를 하나로 합치고, 현 구조를 유지할 경우 extra 런타임 assert를 추가한 뒤 `npm run test:i18n`과 전체 npm 게이트를 실행해야 한다.

## 회귀 게이트

| 게이트 | 결과 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri\\Cargo.toml --check` | 통과 |
| `cargo clippy --manifest-path src-tauri\\Cargo.toml --locked --all-targets --all-features -- -D warnings` | 통과 |
| `cargo test --manifest-path src-tauri\\Cargo.toml --locked` | 통과 — lib 171 passed/1 ignored, CLI 8 passed, fake smoke 1 passed |
| `npm run typecheck` 및 전체 npm/Vitest 게이트 | 실행 불가 — 현재 worker 환경에서 `npm` command not found |
| `Models.layout.test.tsx`, `modelProfiles.test.ts` | 실행 불가 — npm 부재로 이번 검수에서 결과 미확인 |

이전 `review-codex-4.md`의 npm 통과 기록은 이번 Claude 5차 변경 전 결과이고, 현재 최종 소스에 대한 재실행 결과로 간주하지 않았다.

## 최종 조치 제안

1. `Chat.tsx`, `Tuning.tsx`, `Runtimes.tsx`, `ExecutionProfiles.tsx`를 추가 분리해 300줄 기준을 충족하고 targeted tests를 실행한다.
2. streaming 메시지 렌더를 memoized/격리하고 200+ 메시지 Profiler 근거를 남긴다.
3. i18n 단일 accessor 통합 여부를 확정하고, 현행 다중 catalog를 유지하면 extra assert를 추가한다.
4. Node/npm이 제공되는 환경에서 `test:i18n`, targeted tests, 전체 npm 게이트를 실행해 최종 sign-off한다.
