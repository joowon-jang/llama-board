# P0-2 DOM 테스트 + P1 검수 — Codex 3차 사이클

- 검수일: 2026-08-30
- 대상: 선행 Claude 작업 결과 및 현재 작업 트리
- 검수 원칙: 소스·테스트는 수정하지 않고 이 리포트만 추가

## 최종 판정

**조건부 통과.** 전체 npm/cargo 회귀 게이트와 주요 DOM 동작은 통과했지만, 요청한 엄격한 검수 조건 중 `findByRole("status")` 직접 사용, Space 키 테스트, axe-core 실행 증거, lifecycle helper 직접 테스트, flash 타임아웃 통일이 남아 있다.

| 항목 | 판정 | 근거 |
|---|---|---|
| P0-2 Chat DOM | ⚠️ 부분 통과 | 200 KB 첨부·64청크 초과 경고·64 이하 무경고·MCP follow-up 경고 유지 테스트는 있으나, 경고 조회가 `findByRole("status")`가 아니라 `findByText` 후 `role`을 확인한다. |
| P1-6 CustomSelect | ⚠️ 부분 통과 | ARIA 배선·방향키 하이라이트·Enter/Escape·typeahead는 코드와 테스트에 있으나 Space 테스트와 axe-core 실행 검증이 없다. |
| P1-5 lifecycle guard | ⚠️ 조건부 통과 | 주요 5개 패널의 guard는 helper로 교체되고 starting/stopping 의도 주석도 있으나, helper 자체 테스트가 없고 일부 별도 상태 판정은 직접 비교로 남아 있다. |
| P1-3 useFlashMessage | ⚠️ 부분 통과 | 3개 패널의 타이머 중복은 hook으로 제거됐지만 Tuning만 3500 ms를 지정해 기본 4000 ms와 다르다. |
| 전체 회귀 게이트 | ✅ 통과 | 아래 npm/cargo 명령 모두 exit 0. |

## 1. P0-2 Chat DOM 테스트

### 확인된 범위

- `src/panels/Chat.test.tsx:12-22`에서 Chat API 경계를 mock하고, `vitest.setup.ts:26-33`에서 Tauri native `invoke`/event listener mock을 전역으로 제공한다.
- `OVERSIZED_DOCUMENT = "x".repeat(200_000)`(`Chat.test.tsx:79`)가 1800자 청크 기준 64개를 넘는 첨부를 재현한다.
- `respondWithText`(`Chat.test.tsx:90-96`)는 고정된 한 번의 delta와 반환값을 사용해 deterministic stream을 만든다.
- 세 테스트가 각각 초과 경고, 64개 이하 무경고, 승인된 MCP tool follow-up 이후 경고 유지를 검증한다(`Chat.test.tsx:122-168`). 실제 MCP 경로에서 `mcpCallTool` 호출 횟수도 확인한다.
- 실제 화면은 `Chat.tsx:813`의 `role="status"`로 경고를 렌더한다.

### 잔여 사항

`findTruncationWarning`(`Chat.test.tsx:103-110`)는 `screen.findByText(/first 64 document chunks/i)`로 찾은 뒤 `toHaveAttribute("role", "status")`를 확인한다. 테스트 주석처럼 status의 텍스트 accessible name 동작 때문에 이름을 지정한 `findByRole`이 맞지 않을 수 있지만, 요청 조건인 **`role=status` + `findByRole` 직접 검증**은 충족하지 않는다. 또한 deterministic mock은 단일 delta이므로 여러 delta가 연속 도착하는 렌더 경로 자체를 검증하지는 않는다.

## 2. P1-6 ThemeSwitcher CustomSelect

### 확인된 범위

- 트리거와 listbox 연결은 `ThemeSwitcher.tsx:225-226,254-255`의 `aria-controls`와 `aria-activedescendant`로 구성되어 있다.
- 열린 상태에서 ArrowUp/ArrowDown은 `setHighlightedIndex`만 호출하고, Enter/Space는 `commitHighlighted`로 커밋하도록 구현되어 있다(`ThemeSwitcher.tsx:167-186`). Escape는 닫기만 수행한다(`:151-154`).
- typeahead는 열린 상태에서는 highlight만 이동하고, 닫힌 상태에서는 일치 옵션을 즉시 커밋한다(`ThemeSwitcher.tsx:134-149`).
- `src/components/CustomSelect.test.tsx`의 6개 테스트가 ARIA 연결, 방향키 무커밋, Enter 커밋, Escape 취소, 열린/닫힌 typeahead를 검증하며 targeted 실행에서 6/6 통과했다.

### 잔여 사항

- 구현에는 Space 처리가 있지만(`ThemeSwitcher.tsx:183`), 테스트에는 Space 커밋 케이스가 없다.
- `axe-core`는 `package-lock.json:3105`에 있으나 `eslint-plugin-jsx-a11y`의 전이 의존성으로 보이며, `CustomSelect.test.tsx` 또는 다른 UI 테스트에서 `axe.run`/axe assertion을 호출하지 않는다. 따라서 ARIA 구조가 정적으로 타당해 보인다는 판단과 **axe-core 통과를 실행으로 입증했다는 판정**을 구분해야 한다.

## 3. P1-5 lifecycleUtils 교체

### 확인된 범위

- `lifecycleUtils.ts:59-60`의 `isServerRunning`은 running만 true로 판단한다.
- `lifecycleUtils.ts:63-66`의 `isServerBusy`는 running/starting/stopping을 모두 true로 판단하고, 전환 중 잠금이 필요한 호출자를 위한 주석이 있다.
- 주요 guard 사용처는 다음과 같다.
  - `Bench.tsx:66`
  - `Models.tsx:102`
  - `Runtimes.tsx:228`
  - `Chat.tsx:203`
  - `Projects.tsx:64-66` (`isServerBusy`)
- Projects에는 starting/stopping 중 설정 적용이 서버 재작성과 충돌하므로 완전 정지까지 기다려야 한다는 의도 주석이 명시되어 있다.

### 잔여 사항

- `scripts/test-lifecycle-utils.ts`는 새 helper를 import하거나 running/starting/stopping 경계값을 assertion하지 않는다. 따라서 `npm test`의 lifecycle utility 통과만으로 새 helper의 직접 동작이 보장되지는 않는다.
- `Models.tsx:108,140`에는 각각 서버 adapter 조회 조건과 저장 메시지 선택에 `store.status.state === "running"` 직접 비교가 남아 있다. Chat의 failed/crashed/starting 표시 조건처럼 의미가 다른 상태 UI도 직접 비교를 유지한다. 원래 P1-5의 5개 주 guard만 의미한다면 교체는 완료됐지만, “모든 실행 여부 판정의 일관된 helper화”를 의미한다면 추가 정리가 필요하다.

## 4. P1-3 useFlashMessage

### 확인된 범위

- `src/useFlashMessage.ts:10-29`에 timer 정리·재설정·dismiss·unmount cleanup이 공통 구현되어 있다.
- `Models.tsx:34`, `Runtimes.tsx:194`, `Tuning.tsx:95`가 모두 hook을 사용하며, 이전의 `flashTimer`/flash 상태 중복은 남아 있지 않다. Models와 Tuning은 dismiss도 FeedbackBanner에 연결한다.

### 잔여 사항

- hook 기본값은 4000 ms(`useFlashMessage.ts:10`)인데 Tuning은 `useFlashMessage(3500)`(`Tuning.tsx:95`)를 사용한다. 따라서 세 패널의 자동 소멸 시간이 일관되지 않다.
- hook 자체의 fake-timer 테스트가 없고, Runtimes는 `[flash, flashT]`만 사용해 수동 dismiss를 노출하지 않는다. 후자는 preflight 진단을 별도 상태로 유지하려는 설계와 함께 검토할 사항이다.

## 회귀 게이트

| 명령 | 결과 | 세부 |
|---|---|---|
| `npm test` | ✅ | utility scripts 통과, Vitest 14 files / 70 tests 통과 |
| `npm run test:ui -- src/panels/Chat.test.tsx src/components/CustomSelect.test.tsx` | ✅ | 2 files / 9 tests 통과 |
| `npm run typecheck` | ✅ | `tsc --noEmit` exit 0 |
| `npm run lint` | ✅ | `eslint src` exit 0 |
| `npm run build` | ✅ | Vite 7.3.6, 89 modules transformed |
| `cargo fmt --manifest-path src-tauri\Cargo.toml --check` | ✅ | exit 0 |
| `cargo clippy --manifest-path src-tauri\Cargo.toml --locked --all-targets --all-features -- -D warnings` | ✅ | exit 0 |
| `cargo test --manifest-path src-tauri\Cargo.toml --locked` | ✅ | lib 171 passed/1 ignored, CLI 8 passed, fake smoke 1 passed; live runtime install/real smoke는 기본 ignored |

Rust test 출력의 linker stdout 및 Windows child-process 정리 메시지는 있었지만 실패가 아니며, 테스트 결과는 모두 exit 0이다.

## 남은 조치

1. Chat 경고 assertion을 `findAllByRole("status")` 등 실제 role query 기반으로 보강하고, 필요하면 multi-delta deterministic stream 케이스를 추가한다.
2. CustomSelect Space 커밋 테스트와 axe-core 실행 assertion을 추가한다.
3. lifecycle helper 경계값 테스트를 추가하고, 의미가 같은 Models의 잔여 running 직접 비교를 helper로 통일할지 결정한다.
4. Tuning의 flash timeout을 4000 ms로 맞추고 hook fake-timer 테스트를 추가한다.

검수 중 소스·테스트 파일은 수정하지 않았으며, 요청된 산출물은 이 리포트 하나다.
