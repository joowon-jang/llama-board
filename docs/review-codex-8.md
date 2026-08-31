# P1-7 최종 검수 — Codex 8차

- 검수일: 2026-08-30
- 대상: Claude 7차 수정 및 `docs/review-codex-6.md`의 P1-7 잔여 결함
- 검수 방식: 현재 worktree 정적 확인, production-tree streaming 회귀 테스트 단독 실행, npm 게이트 직접 재실행
- 파일 수정: 이 리포트 1개만 추가함. 기존 uncommitted 변경은 보존했고 소스/테스트는 수정하지 않음.
- 종합 판정: **통과**

## 판정 요약

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| `Chat.tsx` `onCopy` callback identity | 통과 | `useCallback`으로 `copyMessage`를 안정화하고 `ChatMessageLog`에 `onCopy={copyMessage}`를 직접 전달함. streaming state 업데이트마다 새 wrapper를 만들지 않음. |
| clipboard 성공/실패 동작 | 통과 | 성공 시 `writeText` 후 copied 상태를 설정하고 1.8초 뒤 해제하며, 예외는 localized `requestFailed` 메시지와 함께 error state로 전달함. |
| 220+ production-tree streaming 격리 | 통과 | 실제 `ChatPanel → ChatMessageLog → MessageBubble` 경로에서 220개 seed 메시지를 렌더하고, throttled delta 중 seed bubble 재렌더 호출이 0건임을 확인함. |
| pre-fix 실패 재현 근거 | 통과 | 기존 리뷰와 committed pre-fix 코드의 매 렌더 inline wrapper를 확인했고, 회귀 테스트 주석이 해당 callback identity 결함과 synthetic-only 테스트의 한계를 명시함. |
| npm 회귀 게이트 | 통과 | typecheck, lint, 전체 test, build 모두 exit 0. |

## 1. `Chat.tsx` callback identity 및 clipboard/error 경로

현재 `src/panels/Chat.tsx`는 다음과 같이 callback을 안정화했다.

- `:1`에서 `useCallback`을 import한다.
- `:113-124`의 `copyMessage`는 `useCallback`으로 감싸져 있고 dependency는 `[locale, setError]`다. `setError`는 `useChatSend`가 반환하는 React state setter이므로 streaming state 변경으로 바뀌지 않는다. locale 변경 시 callback이 새로 만들어지는 것은 번역 오류 메시지를 최신 locale로 유지하기 위한 의도된 변경이다.
- `:175`에서 `onCopy={copyMessage}`를 직접 전달한다. 6차에서 지적된 `onCopy={(index, text) => void copyMessage(index, text)}` 형태의 render-time wrapper는 제거됐다.

clipboard 동작도 정적 확인했다.

- 성공 경로는 `await navigator.clipboard.writeText(text)` 후 `setCopied(index)`를 호출하고, 1,800ms 뒤 동일 index일 때만 copied 상태를 해제한다.
- 실패 경로는 `try/catch` 안에서 동작하며 `Error`와 비-`Error` 값을 모두 문자열화해 `getChatText(locale, "requestFailed")`와 결합한 뒤 `setError`로 노출한다. 따라서 clipboard 권한 거부나 API 미지원으로 인한 예외가 조용히 사라지지 않는다.

## 2. production-tree streaming 회귀 검증

`src/panels/ChatMessageLog.streaming.test.tsx`를 확인하고 단독 실행했다.

- 테스트는 실제 `ChatPanel`을 import(`:76`)하고 실제 `ChatMessageLog`를 거쳐 `MessageBubble`에 도달한다. mock은 API/storage와 render-count를 관찰하기 위한 `MessageBubble` 대체뿐이다.
- `SEED_MESSAGE_COUNT = 220`(`:18`)개의 메시지를 seed하고 마지막을 user message로 고정해 send flow가 seed assistant를 dangling bubble로 제거하지 않도록 한다. 새 turn 전송 후 새 assistant는 index 221이다.
- `respondWithThrottledDeltas`(`:137-146`)는 `Hello `, `there `, `friend.`를 60ms 간격으로 전달해 여러 streaming tick을 만든다.
- 첫 tick 전후의 phase 전환으로 인한 합법적인 전체 rerender는 측정에서 제외하고(`:166-172`), tick 구간의 seed index `< 220` render call이 `[]`인지 검사한다(`:176-178`). 새 assistant bubble은 최소 2회 렌더되는지도 확인한다(`:180-181`).
- `ChatMessageLog.tsx:75`는 streaming draft가 있을 때 마지막 assistant에만 새 message 객체를 만들고 이전 message reference는 유지한다. `MessageBubble.tsx`의 default export는 `memo`이므로 stable primitive/reference props와 함께 이전 bubble bailout이 가능하다.

단독 실행 결과:

```text
npx vitest run src/panels/ChatMessageLog.streaming.test.tsx
Test Files  1 passed (1)
Tests       1 passed (1)
```

### pre-fix 실패 근거

`docs/review-codex-6.md:54-68`은 당시 `Chat.tsx`의 `copyMessage`와 JSX inline wrapper가 매 render 새 reference를 만들고, 그 결과 이전 bubble의 `memo` bailout을 무효화한다고 지적했다. committed pre-fix `Chat.tsx`에도 실제로 `onCopy={(text) => void copyMessage(index, text)}`가 존재했으며, 현재 회귀 테스트의 상단 주석(`:6-16`)은 그 결함 때문에 기존 `MessageBubble.perf.test.tsx`만으로는 검출할 수 없었던 이유와 production-tree 검증 의도를 명시한다.

현재 worktree에서 소스를 임시로 되돌리지는 않았다(사용자 지시인 소스 불변 조건 준수). 따라서 pre-fix 구현을 실행해 실패시킨 별도 로그는 남기지 않았지만, committed pre-fix 코드의 실제 inline wrapper와 이를 검출하도록 설계된 production-tree assertion을 서로 대조해 실패 재현 근거를 확인했다.

## 3. 전체 npm 게이트

모든 명령을 직접 실행했다. sandbox PATH에는 npm이 노출되지 않아 host Node toolchain 실행 승인을 사용했으며 명령 자체와 worktree 소스는 변경하지 않았다.

| 명령 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과, exit 0 |
| `npm run lint` | 통과, exit 0 |
| `npm test` | 통과, Vitest 17 files / 81 tests |
| `npm run build` | 통과, Vite production build 120 modules transformed |

`npm test` 중 jsdom의 `HTMLCanvasElement.getContext()` 미구현 안내가 2건 출력됐지만 테스트 실패가 아니며 전체 명령은 exit 0으로 종료했다. `npm run build`는 Vite 7.3.6으로 완료됐다.

## 최종 결론 및 남은 이슈

6차에서 지적된 `onCopy` callback identity 결함은 `useCallback` 및 직접 prop 전달로 해결됐다. 220개 seed를 포함한 실제 ChatPanel production tree streaming 테스트가 여러 delta tick에서 이전 seed bubble 0회 재렌더를 검증하고 단독/전체 테스트 모두 통과했으므로 P1-7 최종 판정을 통과로 확정한다.

남은 blocking issue는 없다. 실제 브라우저의 clipboard 권한 prompt/거부 UI를 자동화하는 별도 e2e 테스트는 없지만, 호출 성공·예외 처리 코드는 확인됐고 이는 이번 P1-7 sign-off를 막지 않는다.
