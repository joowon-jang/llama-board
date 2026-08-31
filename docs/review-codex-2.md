# P0-1 재작업 검수 — Codex 2차 사이클

- 검수일: 2026-08-30
- 대상: 현재 작업 트리의 P0-1 재작업 결과
- 검수 원칙: 기존 소스·테스트 변경은 수정하지 않고 검수 리포트만 추가

## 최종 판정

**P0-1: 통과.** App.css와 Vite 산출물에서 wildcard 선택자가 제거됐고, light/dark computed-style 점검 및 전체 회귀 게이트가 통과했다. 다만 P0-2는 helper·코드 경로까지만 확인됐으며 `ChatPanel` 실제 DOM 렌더 테스트가 아직 없어 P0 backlog 전체가 닫힌 것은 아니다.

| 항목 | 판정 | 근거 |
|---|---|---|
| P0-1 wildcard 제거 | ✅ 통과 | `rg -n "\\[class\\*=" src/App.css`와 `dist`가 모두 exit 1, 출력 0건 |
| P0-1 theme computed style | ✅ 통과 | light/dark 각 20개 대표 probe가 실제 값과 `--board-*`/`--tone-*` 해석값 모두 일치 |
| P0-1 screenshot 회귀 | ✅ 대체 검증 통과 | 동일 상태 light→dark→light 왕복 후 light PNG SHA-256가 동일; 버전 관리된 baseline은 없음 |
| P0-2 DOM 테스트 잔여 | ⚠️ 잔여 | `Chat.test.tsx`, `render`, `findByRole` 기반 ChatPanel 테스트가 없음 |

## P0-1 확인 결과

### Wildcard 및 빌드 산출물

- `src/index.css:12`에 Tailwind v4 `@theme` 토큰 매핑이 존재한다.
- `src/App.css:1700` 부근은 `app-*` semantic class와 CSS 변수만 사용하며, wildcard 오버라이드 블록은 제거됐다.
- `rg -n "\\[class\\*=" src/App.css`: exit 1, 출력 없음.
- `npm run build`: exit 0, Vite 7.3.6 / 88 modules, CSS 산출물 `dist/assets/index-B1mWqvaZ.css` 생성.
- 빌드 직후 `rg -n "\\[class\\*=" dist`: exit 1, 출력 없음.

### Light/dark computed style

Browser plugin이 제공되지 않아 사전 설치된 Playwright의 Chrome fallback으로 `http://127.0.0.1:1420/`를 점검했다. 페이지 identity는 title `llama-board`, 의미 있는 본문, framework overlay 없음으로 확인됐고, page error·console warning은 없었다(콘솔에는 원인이 특정되지 않은 단일 404 resource 메시지가 관찰됨).

- `html[data-theme="light"]`: shell 배경/ink, topbar/loadbar surface, model input·border·ink, status muted, success fill, primary accent, warning tone 배경·border·ink, danger/success tone probe가 모두 각 token과 정확히 일치했다(20/20).
- `html[data-theme="dark"]`: 동일 20개 probe가 모두 정확히 일치했다(20/20). 네이티브 model selector도 안정화 대기 후 `--board-input`, `--board-border-strong`, `--board-ink`와 일치했다.
- 검증 중 임시로 삽입한 warning/success/danger probe는 실제 소스 파일에 남기지 않았다.

### Screenshot 및 상호작용

저장된 검수 캡처는 다음과 같다(모두 작업 트리 밖의 `%TEMP%`에 저장).

- theme: `llama-board-qa-light.png`, `llama-board-qa-dark.png`
- Models 상단/하단: `llama-board-qa-models-wide-top.png`, `llama-board-qa-models-wide-bottom.png`
- Settings Appearance: `llama-board-qa-settings-light.png`
- responsive: `llama-board-qa-responsive-wide.png`, `llama-board-qa-responsive-narrow.png`
- 왕복 diff: `llama-board-qa-transition-light-before.png`, `llama-board-qa-transition-dark.png`, `llama-board-qa-transition-light-after.png`

저장소에는 비교 가능한 버전 관리 baseline 이미지가 없고, 기존 `%TEMP%`의 8월 28~29일 캡처는 현재 palette/layout과 달라 acceptance baseline으로 사용하지 않았다. 대신 동일 1280×800 상태에서 light→dark→light 전환을 수행했고 before/after light PNG SHA-256가 모두 `b44646bf9e86aac41ba89e64406352c67bf2a14589d3584c02f7b59432fc76ba`로 동일해 왕복 시 pixel drift가 없음을 확인했다.

- 1440×900: document/body/shell scroll width가 모두 viewport와 같고 horizontal overflow 없음.
- 390×844: document/body/shell scroll width가 모두 viewport와 같고 horizontal overflow 없음.
- Models list 48개 mock row에서 상단 `scrollTop=0`, 하단 `scrollTop=4257`, `scrollHeight=4971`, `clientHeight=714`, `scrollWidth=clientWidth=1074`.
- Settings Appearance의 custom combobox가 `aria-expanded=false → true → false`로 열림/Escape 닫힘 동작을 통과했다.

## 회귀 게이트

| 명령 | 결과 | 관찰 |
|---|---|---|
| `npm run typecheck` | ✅ | exit 0 |
| `npm run lint` | ✅ | exit 0 |
| `npm test` | ✅ | direct utility tests 통과, Vitest 12 files / 61 tests 통과 |
| `npm run build` | ✅ | Vite 7.3.6, 88 modules |
| `cargo fmt --check` | ✅ | exit 0 |
| `cargo clippy --locked --all-targets --all-features -- -D warnings` | ✅ | exit 0 |
| `cargo test --locked` | ✅ | lib 171 passed/1 ignored, CLI 8 passed, fake smoke 1 passed; live runtime/smoke 2건은 의도적으로 ignored |
| `git diff --check` | ✅ | exit 0; CRLF 변환 안내만 출력 |

## P0-2 잔여 여부

- `src/chatUtils.ts:55-58`의 `MAX_SEARCHABLE_DOCUMENT_CHUNKS = 64`와 초과 판별 helper가 존재한다.
- `src/panels/Chat.tsx:382-428`에서 전체 청크 수를 판별하고 앞 64개만 검색한 뒤 절단 경고 문구를 만든다.
- `src/panels/Chat.tsx:802`에서 경고를 `role="status"`로 렌더한다.
- `scripts/test-document-context.ts`의 200,000자 입력 helper 검사는 `npm test`에서 통과했다.
- 그러나 `rg --files src` 결과 `src/panels/Chat.test.tsx`가 없고, ChatPanel을 렌더해 `findByRole('status')` 또는 동일 DOM assertion을 수행하는 테스트도 없다. 이번 브라우저 검수는 theme/layout/interaction mock에 집중했으므로 실제 200 KB 첨부→전송 경로에서 경고가 DOM에 나타나는지는 미검증 상태다.

## 작업 트리 일관성

검수자는 기존 tracked/untracked 변경을 되돌리거나 수정하지 않았다. 검수 세션에서 작업 트리에 새로 추가한 파일은 이 리포트 하나이며, Playwright 스크립트와 PNG는 작업 트리 밖의 `%TEMP%`에만 생성했다. 기존 P0-3 fake smoke fixture와 기존 문서/소스 변경은 그대로 보존됐고 `git diff --check`도 통과했다.

## 남은 조치

P0-1은 통과로 종료할 수 있다. P0-2를 완전 통과로 승격하려면 `Chat.test.tsx`에 native API mock, 200 KB 첨부, deterministic embedding/chat stream, `role="status"` 경고 assertion을 추가하고 실제 follow-up 정책까지 결정해야 한다.
