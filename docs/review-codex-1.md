# P0/P1 개선 검수 — Codex 담당 1차

검수 대상은 `docs/project-review-codex.md`와 `docs/project-review-claude.md`의 P0 항목, Claude 1차 작업 트리, 그리고 현재 Windows 환경의 전체 회귀 게이트다. 검수 중 소스·테스트 파일은 수정하지 않았고 이 리포트만 추가했다.

## 결론

**최종 판정: 재작업 필요.** P0-3의 기본 게이트 false green은 해소됐고 P0-2의 경고 코드 경로도 들어갔지만, P0-1은 요구한 “App.css wildcard 제거”가 완료되지 않았다. P0-2는 단위 수준의 200 KB 입력 검사는 통과했으나, 실제 Chat DOM에서 경고가 보이는 렌더 검증은 브라우저 도구 부재로 수행하지 못했다.

| 항목 | 판정 | 근거 |
|---|---|---|
| P0-1 `@theme` + App.css wildcard 제거 | ❌ 반려 | `@theme`는 추가됐지만 `src/App.css`에 `[class*=` 선택자가 35개 라인(37회) 남아 있음 |
| P0-2 64청크 절단 경고 | ⚠️ 코드 통과 / UI 증거 보류 | 64개 상한 감지·`role="status"` 출력·200 KB helper 테스트는 존재하고 통과 |
| P0-3 gated 테스트 | ✅ 기본 게이트 통과 | live 테스트는 `ignored`, 결정적 fake 서버 smoke는 기본 `cargo test`에서 1개 통과 |

## P0-1 — CSS 토큰화는 부분 완료, wildcard 제거는 미완료

### 확인 결과

- `src/index.css:13-63`에 Tailwind v4 `@theme` 블록이 추가됐다.
- `src/App.css:78-101`에는 light theme용 `--color-*` 보정값이 추가됐고, 빌드 산출물에도 dark/light root 토큰이 모두 포함됐다.
- 그러나 `src/App.css:1672,1677-1741`에 잔여 `[class*=` 선택자가 남아 있다. `rg -n '\[class\*=' src/App.css` 결과는 35개 라인이며, 소스 내 토큰 발생 횟수는 37회다. 빌드된 `dist/assets/index-*.css`에도 wildcard 발생이 36회 남는다.
- 잔여 규칙은 `bg-slate-800/700/600`, 여러 `border-*`, `bg-indigo-500`, `bg-emerald-700`, `bg-red-800`, `bg-amber-700/600`, `font-mono`, 버튼 선택자 등을 `!important`로 덮는다. “같은 숫자 shade가 background/border 역할을 겸한다”는 주석은 있지만, 이번 P0 acceptance 조건인 App.css wildcard 0건을 만족하지 않는다.

### 재현

```powershell
rg -n '\[class\*=' src/App.css
```

기대 결과는 출력 없음(또는 `grep -c '\[class\*=' src/App.css`가 `0`)이며, 실제 결과는 위 잔여 규칙 목록이다.

### 수정 지시

`src/App.css:1672-1741`의 `[class*=` 기반 규칙과 해당 설명의 wildcard 문자열을 모두 제거한다. shade 하나로 역할을 구분할 수 없는 JSX는 `src/**/*.tsx`에서 의미가 드러나는 board 토큰/전용 클래스(예: 배경용·테두리용 semantic class)로 이름을 바꾼 뒤, `src/index.css:13-63`의 `@theme`가 직접 최종 색을 공급하도록 한다.

다음 검수에서 아래를 모두 확인한다.

1. `rg -n '\[class\*=' src/App.css`가 0건이다.
2. `vite build` 후 `dist/assets/index-*.css`에도 wildcard가 없다.
3. `html[data-theme="dark"]`와 `html[data-theme="light"]`에서 대표적인 panel/input/ink/accent/success/danger/warning 요소의 computed color가 각 `--board-*` 토큰과 일치한다.
4. 두 테마의 전환 전후 스크린샷 diff에서 입력·버튼·경고 배너의 대비와 배경이 기존 보드 팔레트에서 regress하지 않는다.

현재 `@theme`의 light 보정 선언과 Vite 컴파일은 정적으로 확인했지만, Browser plugin과 Playwright 패키지가 모두 없어서 실제 스크린샷/브라우저 computed-style 검증은 하지 못했다. `npx --no-install playwright --version`도 패키지 부재로 실패했다.

## P0-2 — 절단 경고 코드 경로는 추가됐으나 렌더 검증이 부족함

### 확인 결과

- `src/chatUtils.ts:55-58`에 `MAX_SEARCHABLE_DOCUMENT_CHUNKS = 64`와 `documentChunksExceedSearchLimit()`가 추가됐다.
- `src/panels/Chat.tsx:382-387`은 전체 청크 수를 계산한 뒤 64개 초과 여부를 기록하고 앞 64개만 검색한다.
- `src/panels/Chat.tsx:428-431`은 절단 시 “Only the first 64 document chunks…” 경고를 `contextWarning`에 넣고, `src/panels/Chat.tsx:802`에서 `role="status"`로 렌더한다.
- `scripts/test-document-context.ts:22-28`은 200,000자 문서가 64청크 제한을 초과하는지 helper 수준에서 검증한다. 이 테스트는 `npm test`에서 통과했다.

### 판정과 잔여 위험

일반 텍스트 전송 경로의 코드상 절단 무통지는 해소된 것으로 판단한다. 다만 현재 자동 테스트는 helper와 chunk 수만 검사하고 `ChatPanel`의 DOM 노출을 검사하지 않는다. 또한 MCP 승인 후 `approvePendingTool()`이 `send(false, followupHistory)`를 호출하면 `src/panels/Chat.tsx:379-431`에서 `pendingDocuments`가 빈 배열로 다시 계산되어 기존 절단 경고가 사라질 수 있으므로, 대화 전체에 경고를 유지할 정책이라면 별도 상태로 보존해야 한다.

### 재현/보강 지시

`src/panels/Chat.test.tsx`에 native API를 mock한 렌더 테스트를 추가한다.

1. 문서 선택 API가 200 KB 텍스트를 반환하도록 mock한다.
2. ChatPanel에서 문서를 첨부하고 메시지를 전송한다.
3. 임베딩 endpoint와 chat stream을 결정적으로 resolve한다.
4. `await screen.findByRole('status', { name: /first 64 document chunks/i })` 또는 동일한 텍스트 assertion으로 경고가 실제 DOM에 보이는지 확인한다.
5. 64청크 이하 입력에는 절단 경고가 없고, MCP follow-up 정책을 유지해야 한다면 follow-up 완료 후에도 경고가 남는지 확인한다.

이 테스트와 200 KB 첨부 수동 검증이 통과하면 P0-2를 완전 통과로 승격한다.

## P0-3 — gated 테스트 false green 개선

### 확인 결과

- `src-tauri/tests/smoke.rs:24-29`의 real-server smoke에 `#[ignore]`가 추가됐고, `src-tauri/tests/runtime_install.rs:32-37`의 live runtime 설치 테스트에도 다운로드 사유가 있는 `#[ignore]`가 추가됐다.
- `src-tauri/tests/smoke_fake.rs`와 `src-tauri/src/bin/fake-llama-server.rs`가 추가됐다. fake fixture는 `server::spawn`으로 프로세스를 시작하고 `/health`, `/v1/models`, SSE chat completion, 종료까지 기본 게이트에서 실제로 실행한다.
- `cargo test --locked` 결과:
  - lib: `171 passed; 0 failed; 1 ignored`
  - CLI: `8 passed; 0 failed`
  - `runtime_install`: `0 passed; 1 ignored`
  - `smoke`: `0 passed; 1 ignored`
  - `smoke_fake`: `1 passed; 0 failed`

따라서 기본 `cargo test`가 live 테스트의 조기 `return`을 “passed”로 세던 문제는 `ignored`로 바뀌었고, 항상 실행되는 결정적 smoke가 보완한다. 실제 GitHub runtime 다운로드와 다중 GB 모델 smoke는 의도적으로 실행하지 않았다.

### 커밋 전 주의

fake fixture 두 파일은 현재 **untracked**다. `src-tauri/src/bin/fake-llama-server.rs`와 `src-tauri/tests/smoke_fake.rs`를 커밋에서 빠뜨리면 기본 게이트에는 다시 fake smoke가 없고 live 테스트만 ignored로 남으므로, P0-3 변경 세트와 함께 stage해야 한다. 전용 live job은 `LLAMA_BOARD_RUNTIME_INSTALL=1`/`LLAMA_BOARD_SMOKE=1` 및 필요한 모델을 명시하고 `--ignored --nocapture`로 실행해야 한다.

## 회귀 게이트

| 명령 | 결과 | 관찰 |
|---|---|---|
| `npm run typecheck` | ✅ 통과 | TypeScript 오류 없음 |
| `npm run lint` | ✅ 통과 | `eslint src` 오류 없음 |
| `npm test` | ✅ 통과 | Node direct test 23개 모두 통과, Vitest 12 files / 61 tests 통과 |
| `npx --no-install vite build` | ✅ 통과 | Vite 7.3.6, 88 modules, CSS 80.69 kB, index JS 259.27 kB |
| `cargo fmt --check` | ✅ 통과 | 포맷 차이 없음 |
| `cargo clippy -- -D warnings` | ✅ 통과 | 추가로 `--locked --all-targets --all-features`도 통과 |
| `cargo test` / `cargo test --locked` | ✅ 통과 | 위 P0-3 집계; linker가 Windows import library 생성 메시지를 warning으로 출력했으나 실패 아님 |
| `git diff --check` | ✅ 통과 | CRLF 변환 안내 외 whitespace 오류 없음 |

`npm test`의 `test:document-context`는 200 KB helper assertion을 포함해 통과했다. Chat 실제 UI 경고와 light/dark 테마 스크린샷은 Browser plugin/Playwright 부재로 실행하지 못했으므로 다음 사이클의 명시적 잔여 검증으로 남긴다.

## 작업 트리 일관성

검수 시작 전부터 다음 변경이 존재했고, 검수 중 소스 파일에는 손대지 않았다.

- tracked modified 17개: `scripts/test-document-context.ts`, `src-tauri/Cargo.toml`, `src-tauri/src/bin/llama-board-cli.rs`, `src-tauri/tests/runtime_install.rs`, `src-tauri/tests/smoke.rs`, `src/App.css`, `src/App.tsx`, `src/chatUtils.ts`, `src/components/ExecutionProfiles.tsx`, `src/index.css`, `src/modelProfiles.test.ts`, `src/modelProfiles.ts`, `src/panels/Chat.tsx`, `src/panels/Mcp.tsx`, `src/panels/Models.layout.test.tsx`, `src/panels/Tuning.tsx`, `src/uiI18n.ts`.
- pre-existing untracked: `docs/project-review-claude.md`, `docs/project-review-codex.md`, `docs/기능명세서.md`, `docs/기능점검보고서.md`, root의 `저장` 파일.
- P0-3 관련 untracked: `src-tauri/src/bin/fake-llama-server.rs`, `src-tauri/tests/smoke_fake.rs`.
- `dist/`와 `src-tauri/target/`은 `.gitignore` 대상이며 검수 명령으로 tracked 변경은 추가되지 않았다.

이번 산출물은 `docs/review-codex-1.md` 하나다. `git diff --check`는 통과했으며 기존 변경을 되돌리거나 섞지 않았다.

## 다음 사이클 우선순위

P0-1을 먼저 완전히 닫고 P0-2 DOM 테스트를 보강한 뒤, Claude 리포트의 P1은 다음 순서를 권장한다.

1. P1-6 `CustomSelect` ARIA 관계·키보드 커밋 동작 — 실제 접근성/사용자 조작 결함.
2. P1-5 서버 lifecycle guard 공통화 — 패널 간 `starting/stopping` 의미 불일치 해소.
3. P1-3 `useFlashMessage` 공통 훅 — 세 패널 타이머 중복 제거.
4. P1-2 Chat/Tuning/Runtimes 책임 분리 — 파일 크기와 테스트 가능성 개선.
5. P1-7 Chat streaming state 분리 — 장문 스레드의 매 프레임 배열 복사 제거.
6. P1-4 i18n catalog/accessor 통합.
7. P1-1 App.css 분할 — P0 토큰화·wildcard 제거가 안정화된 후 진행.

Codex 리포트의 별도 운영 backlog에서는 앱/CI timeout(P1-4), release/PR 권한 경계(P1-5), scripts 정적 검사 범위(P1-2) 순으로 후속 처리한다.
