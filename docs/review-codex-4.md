# P0-2/P1 잔여 검수 — Codex 4차 사이클

- 검수일: 2026-08-30
- 대상: 선행 Claude 4차 결과물 및 현재 작업 트리
- 검수 원칙: 소스·테스트는 수정하지 않고 이 리포트만 추가

## 최종 판정

**조건부 통과.** CustomSelect의 Space 커밋·axe assertion, lifecycle 경계값, 4000 ms flash hook과 fake-timer 테스트, Chat multi-delta 스트림 및 전체 npm/cargo 회귀는 확인됐다. 다만 Chat 경고 검증은 `role="status"`를 직접 조회하지만 `findByRole("status")`가 아니라 `getAllByRole("status")`를 사용하므로, 요청 문구를 함수명까지 엄격히 해석하면 P0-2에 잔여 1건이 있다.

| 항목 | 판정 | 근거 |
|---|---|---|
| P0-2 Chat DOM | ⚠️ 조건부 통과 | multi-delta 케이스는 추가·통과했으나, 경고 helper는 `getAllByRole("status")` 후 텍스트를 고른다. role 자체는 직접 검증하지만 literal `findByRole("status")` 호출은 없다. |
| P1-6 CustomSelect | ✅ 통과 | Space 키 커밋 테스트와 닫힘/열림 axe-core `violations=[]` assertion이 추가됐고 targeted 실행이 통과했다. |
| P1-5 lifecycle guard | ✅ 통과 | `isServerRunning`/`isServerBusy`의 running·starting·stopping 및 비활성 경계값을 직접 assertion하며, Models의 서버 실행 여부 판정은 helper로 일관된다. |
| P1-3 useFlashMessage | ✅ 통과 | Tuning을 포함한 패널이 기본 4000 ms를 사용하고, hook fake-timer 테스트가 기본 만료·custom 만료·재설정·dismiss/null·unmount를 검증한다. |
| 전체 회귀 게이트 | ✅ 통과 | 아래 npm/cargo 명령이 모두 exit 0이다. |

## 1. P0-2 Chat DOM 테스트

### 확인된 변경

- `src/panels/Chat.test.tsx:97-104`의 `respondWithDeltas(parts)`가 각 part를 순서대로 별도 `onDelta`로 전달하고, 합친 전체 응답을 반환한다.
- `src/panels/Chat.test.tsx:146-154`의 테스트가 `Here `, `is what `, `I found, `, `in full.` 네 개 delta를 받아 최종 응답 조립과 truncation warning을 함께 검증한다. `chatStream` 호출 횟수도 확인한다.
- `src/panels/Chat.test.tsx:118-124`의 `findTruncationWarning`은 `screen.getAllByRole("status")`로 status region들을 조회한 뒤 경고 텍스트가 있는 element를 선택하고 `waitFor`로 DOM 반영을 기다린다. 이전처럼 텍스트를 먼저 찾은 뒤 role attribute를 사후 확인하는 방식은 아니다.

### 엄격 조건 잔여

- 현재 파일에는 실행 코드로 `findByRole("status")`가 없고, 주석에만 해당 문자열이 있다(`src/panels/Chat.test.tsx:113`). 따라서 “status role을 직접 검증”을 의미하면 충족하지만, 요청을 **`findByRole` API의 직접 사용**으로 해석하면 미충족이다.
- 현재 Chat 화면에는 attachment status, response phase, metrics, context source 등 여러 `role="status"`가 공존한다(`src/panels/Chat.tsx:813-814,830,841-843`). 이 때문에 이름 없는 전역 `findByRole("status")`는 단일 대상을 보장하지 않으며, 현재 구현은 복수 role을 직접 읽어 truncation 문구를 판별하는 우회다.
- 권고: literal 조건을 닫아야 한다면 warning을 고유 accessible name으로 만들거나 해당 슬롯을 고유 scope로 좁힌 뒤 `findByRole("status")`를 사용한다. 이 검수에서는 소스·테스트 수정 권한 범위를 넘지 않기 위해 조정하지 않았다.

## 2. P1-6 ThemeSwitcher CustomSelect

- `src/components/CustomSelect.test.tsx:48-56`에서 메뉴를 열고 ArrowDown 후 `{ key: " " }`를 보내 `onChange("dark")`, 닫힘을 검증한다.
- `src/components/CustomSelect.test.tsx:81-89`에서 `axe.run`을 닫힌 상태와 열린 상태 각각 실행하고 `violations`가 빈 배열인지 assertion한다. `axe-core`도 `package.json:56` devDependency로 직접 선언되어 있다.
- targeted 실행 결과 `Chat.test.tsx`, `CustomSelect.test.tsx`, `useFlashMessage.test.ts` 3 files / 18 tests가 모두 통과했다.
- 참고: 메뉴가 `createPortal`로 `document.body`에 렌더되는데 axe 대상은 `trigger.closest("div")`다(`CustomSelect.test.tsx:83,87`). 따라서 assertion 실행 자체는 확인됐지만, 열린 상태 assertion의 스캔 범위는 portal listbox 전체가 아니라 trigger container로 제한된다.

## 3. P1-5 lifecycleUtils 및 Models 일관성

- `scripts/test-lifecycle-utils.ts:4-12`가 `isServerRunning("running") === true`, starting/stopping/stopped/failed/crashed/빈 문자열은 false를 직접 assertion한다.
- 같은 파일이 `isServerBusy`에 대해 running/starting/stopping은 true, stopped/failed/crashed/빈 문자열은 false를 assertion한다. `npm run test:lifecycle-utils`는 전체 `npm test` 안에서 통과했다.
- `src/lifecycleUtils.ts:59-66`의 helper 의미는 위 경계값과 일치한다.
- `src/panels/Models.tsx:102`의 `serverRunning`과 `:108,140`의 adapter/저장 알림 판정, `:425-453`의 row action·삭제·선택 비활성화는 `isServerRunning` 결과를 사용한다. `:369-373`의 failed/crashed 직접 비교는 실행 여부가 아닌 오류 진단 UI 분기이고, projector 변경은 별도 `projectorChangeAllowed` 정책 helper이므로 running helper와 충돌하지 않는다.
- 따라서 Models의 “서버 실행 여부” 직접 비교 정리는 일관적이다. 다른 화면의 failed/crashed 또는 Tuning의 running label/apply gate 같은 상태 표현용 직접 비교까지 전역적으로 없앤 것은 아니며, 이는 이번 Models 검수 범위와 별개다.

## 4. P1-3 Tuning flash timeout 및 hook 테스트

- `src/useFlashMessage.ts:10`의 기본 timeout은 4000 ms다. `src/panels/Models.tsx:34`, `src/panels/Runtimes.tsx:194`, `src/panels/Tuning.tsx:95`가 모두 custom override 없이 기본값을 사용하며, `src` 내 3500 ms 사용처는 없다.
- `src/useFlashMessage.test.ts:14-72`가 fake timer로 기본 4000 ms 경계(3999/4000), custom timeout, 새 메시지에 의한 timer 재시작, dismiss, null, unmount cleanup을 검증한다.
- 해당 hook 테스트를 포함한 targeted UI 실행과 전체 `npm test`가 모두 통과했다.

## 회귀 게이트

| 명령 | 결과 | 세부 |
|---|---|---|
| `npm run test:ui -- src/panels/Chat.test.tsx src/components/CustomSelect.test.tsx src/useFlashMessage.test.ts` | ✅ | 3 files / 18 tests passed |
| `npm test` | ✅ | utility tests 통과, Vitest 15 files / 79 tests passed |
| `npm run typecheck` | ✅ | `tsc --noEmit` exit 0 |
| `npm run lint` | ✅ | `eslint src` exit 0 |
| `npm run build` | ✅ | Vite 7.3.6, 89 modules transformed |
| `cargo fmt --manifest-path src-tauri\\Cargo.toml --check` | ✅ | exit 0 |
| `cargo clippy --manifest-path src-tauri\\Cargo.toml --locked --all-targets --all-features -- -D warnings` | ✅ | exit 0 |
| `cargo test --manifest-path src-tauri\\Cargo.toml --locked` | ✅ | lib 171 passed/1 ignored, CLI 8 passed, fake smoke 1 passed; live runtime-install/real smoke는 의도적으로 ignored |

Vitest의 jsdom canvas `getContext()` 미구현 notice와 Rust linker/Windows child-process 정리 출력은 있었지만 실패가 아니며, 위 명령의 exit code 및 테스트 결과는 모두 성공이다. 이번 검수에서 소스·테스트 파일은 수정하지 않았고 `docs/review-codex-4.md`만 추가했다.
