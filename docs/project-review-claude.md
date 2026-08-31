# llama-board 아키텍처 · CSS · 상태관리 · 접근성 · 보안 점검 보고서

- 대상: `C:/Users/joojoo/llama-board` (branch `main`, HEAD `1f893e9`, version 0.1.4)
- 작업 트리 상태: 10개 파일 수정, 4개 미추적 항목 (`docs/`, `저장` 포함) — 본 점검은 **읽기 전용**이며 어떤 소스도 수정하지 않았습니다.
- 이전 리뷰 연계: CSS 구조 리뷰(run_d98a9565b836, "토큰화 + 그룹 오버라이드 제거" 권고)와 PR 런타임 리뷰(run_3a18dc3a7ec8, NO-SHIP 4건)의 결론을 재검증하고, 그 이후 커밋(`1f893e9` 등)에서 상태가 어떻게 변했는지 갱신했습니다.

## 개요

가장 시급한 문제는 **CSS 방어적 오버라이드가 이전 리뷰 권고에도 불구하고 더 늘어났다는 점**입니다 (`App.css` 1636→1894줄, wildcard `!important` 88개). 두 번째 축은 **패널 컴포넌트 비대화와 상태 로직 중복**으로, `Tuning.tsx`(930줄) · `Chat.tsx`(848줄, `useState` 22개) · `Runtimes.tsx`(827줄)가 UI·네트워킹·검증 로직을 한 파일에 혼재시키고 있고, flash 배너·i18n 접근자·서버 상태 가드 같은 패턴이 파일마다 재구현되어 있습니다. 접근성 항목 중 `CustomSelect` 콤보박스의 ARIA 배선 누락과 진행률 바의 시각/시맨틱 불일치는 실제 사용자에게 영향을 주는 결함입니다. 보안 관련 두 항목(`%SystemDrive%`, `pdf_extract` 빈 패스워드)은 코드를 직접 대조한 결과 **의도된 설계**로 확인되어 정보성으로 하향했습니다.

우선순위는 P0(즉시 조치)·P1(다음 스프린트)·P2(여유 있을 때/정보성) 3단계로 분류했습니다.

---

## P0

### P0-1. CSS wildcard `!important` 오버라이드가 이전 권고 이후 오히려 증가

- **현황**: `src/App.css:1648-1779`에 `.app-shell [class*="bg-slate-950"] { ... !important; }` 형태의 속성-와일드카드 셀렉터가 **88개** 존재합니다 (`grep -c '\[class\*=.*!important' src/App.css` → 88, 파일 전체 `!important`는 110개). 이는 Tailwind 유틸리티 클래스(`bg-slate-900`, `text-slate-400` 등)가 JSX에 하드코딩된 것을 CSS 레이어에서 다시 색상 토큰으로 강제 치환하는 구조입니다. `src/index.css:1`은 `@import "tailwindcss";`만 있을 뿐 `@theme` 블록이 전혀 없어(`grep -rn "@theme" src/*.css` → 0건) Tailwind v4의 네이티브 토큰 확장 기능을 쓰지 않고, 대신 App.css의 사후 오버라이드로 팔레트를 교정하고 있습니다.
- **이전 리뷰와의 정합성**: run_d98a9565b836은 "토큰화 + 그룹 오버라이드 제거"를 권고했으나, 최신 커밋(`1f893e9`, "consolidate repeated controls") 이후에도 App.css는 1636→1894줄로 늘었고 이 wildcard 블록은 그대로 유지·확장되었습니다. 권고가 실행되지 않고 문제가 누적되는 추세입니다.
- **영향도**: 신규 컴포넌트가 Tailwind 클래스(`bg-slate-700` 등)를 추가할 때마다 App.css에 대응 오버라이드를 추가하지 않으면 라이트/다크 테마 색상이 깨집니다. `!important` 특이성 때문에 컴포넌트 로컬 스타일로 이 규칙을 못 이깁니다. CSS 파일이 계속 커지는 근본 원인입니다.
- **권장 수정**: `index.css`에 `@theme { --color-slate-900: var(--board-panel); ... }` 형태로 Tailwind v4 테마 토큰을 직접 재정의하여, JSX의 `bg-slate-900` 등이 이미 보드 팔레트를 가리키게 만들고 App.css의 1648-1779 블록 전체를 제거합니다. 신규 코드에서는 `bg-slate-*` 대신 `--board-*` CSS 변수를 참조하는 유틸리티를 사용하도록 컨벤션을 고정합니다.
- **검증 방법**: `@theme` 도입 후 `grep -c '\[class\*=' src/App.css`가 0이 되는지, 라이트/다크 테마 전환 시 스크린샷 diff로 색상 회귀가 없는지 확인.

### P0-2. Chat 문서 인덱싱이 64청크를 초과하면 사용자 통지 없이 조용히 잘림

- **현황**: `src/panels/Chat.tsx:384` `const chunks = splitDocumentChunks(pendingDocuments).slice(0, 64);` — 벡터 검색에 사용할 청크를 앞 64개로 강제 제한합니다. `chunkDocument`의 기본 청크 크기는 1800자(`src/chatUtils.ts:28`)이므로, 약 115,000자(≈57,500 토큰) 이상의 첨부 문서는 뒷부분이 검색 컨텍스트에서 완전히 배제됩니다. 이 제한은 `contextWarning`/`contextSources` state(`Chat.tsx:106-107`)에 반영되지 않아 UI 어디에도 "일부만 검색됨" 경고가 나타나지 않습니다.
- **영향도**: 사용자가 큰 문서를 첨부하고 "문서 뒷부분 내용을 아냐"고 물으면 모델은 실제로 그 부분을 본 적이 없는데도 아무 경고 없이 답변합니다 — RAG 정합성 문제이자 조용한 데이터 손실입니다.
- **권장 수정**: 64 상한에 걸릴 경우 `setContextWarning(...)`으로 "문서 일부만 검색 대상에 포함됨" 메시지를 세팅하거나, 최소한 잘린 청크 수를 `retrievalSources`에 노출합니다.
- **검증 방법**: 200KB 이상 텍스트 문서를 첨부해 전송 후 UI에 절단 경고가 표시되는지 확인하는 테스트 추가.

---

## P1

### P1-1. `App.css` 1894줄 + BEM/Tailwind 혼재 + 단일 번들로 즉시 로드

- **현황**: `App.css`는 1894줄(측정: `wc -l src/App.css`)이며 BEM 스타일 클래스(`__` 8종, `--` modifier 27종, 예: `.app-button--primary`)와 JSX 내 Tailwind 유틸리티 클래스가 동일 프로젝트에서 병용됩니다. 프로젝트 전체에서 CSS import는 `src/App.tsx:3` (`App.css`)와 `src/main.tsx:7` (`index.css`) 단 두 곳뿐이며, 패널은 `React.lazy`로 지연 로드되는데(`App.tsx:19-29`) 스타일시트는 분할되지 않아 최초 진입 시 1894줄 전체가 즉시 파싱됩니다.
- **영향도**: 초기 로드 비용이 실제 사용하는 패널 수와 무관하게 고정되어 있고, 두 스타일링 체계가 공존해 신규 기여자가 "어디에 스타일을 추가해야 하는가"를 매번 판단해야 합니다.
- **권장 수정**: P0-1의 토큰화가 끝나면 App.css 크기 자체가 크게 줄어듭니다. 그 이후 남은 컴포넌트별 규칙은 CSS Modules 또는 패널별 `*.css` + 동적 import로 분리하는 것을 검토합니다. 신규 스타일은 BEM 대신 Tailwind 유틸리티로 통일합니다.
- **검증 방법**: 빌드 후 `dist` 내 CSS 청크 개수 확인, Chat 전용 진입 시 네트워크 탭에서 로드되는 CSS 바이트 수 비교.

### P1-2. 패널 비대화 — 상태·검증·네트워킹이 컴포넌트에 응집

- **현황**:
  - `src/panels/Tuning.tsx` 930줄
  - `src/panels/Chat.tsx` 848줄, `useState` 22개(`Chat.tsx:95-116`: workspace, msgs, input, threadQuery, threadPanelOpen, attachments, documents, attachmentStatus, phase, error, contextWarning, contextSources, aborting, copied, mcpCatalog, selectedMcpTools, activeProjectName, loadingMcpTools, pendingToolCall, metrics, pendingDelete 등)
  - `src/panels/Runtimes.tsx` 827줄
  - `src/components/ExecutionProfiles.tsx` 435줄 — `src/components/`(재사용 프리미티브 전용, 나머지 파일은 평균 100줄 내외: `AppIcons` 75, `TabNav` 101, `ThemeSwitcher` 247)에 위치하지만 실제로는 `Models.tsx:15,360`에서만 단일 소비되는 모델/서버 프로필 편집 기능이며, `modelProfiles.ts`에 직접 의존하는 도메인 로직을 담고 있어 다른 `components/` 파일들과 성격이 다릅니다.
- **영향도**: 파일당 책임이 너무 많아 리뷰·테스트·재사용이 어렵고, `ExecutionProfiles.tsx`는 위치상 "범용 컴포넌트"로 오인되기 쉽습니다.
- **권장 수정**:
  - `Chat.tsx`: 스레드 목록/검색(threadQuery, threadPanelOpen), 첨부파일(attachments, documents, attachmentStatus), MCP 도구 상태(mcpCatalog, selectedMcpTools, loadingMcpTools, pendingToolCall)를 각각 `useChatThreads`, `useChatAttachments`, `useChatMcpTools` 커스텀 훅으로 추출.
  - `Tuning.tsx` / `Runtimes.tsx`: 폼 검증(`tuningValidation.ts`로 이미 일부 분리됨)과 렌더링을 완전히 분리하고, 하위 섹션을 프레젠테이셔널 컴포넌트로 쪼갭니다.
  - `ExecutionProfiles.tsx`는 `src/components/`에서 `src/panels/models/ExecutionProfiles.tsx` 또는 `Models.tsx`와 같은 계층으로 이동해, "패널 전용 기능 모듈"과 "범용 UI 프리미티브"를 디렉터리로 구분합니다.
- **검증 방법**: 분리 후 각 파일 300줄 미만 유지, 기존 `src/panels/Models.layout.test.tsx` / `src/modelProfiles.test.ts` 통과 확인.

### P1-3. flash 배너 상태·타이머 패턴이 3개 파일에 동일하게 재구현됨

- **현황**: `Models.tsx:33,42-52`, `Runtimes.tsx:193,220,297-299`, `Tuning.tsx:94,108,175-177`가 각각 `const [flash, setFlash] = useState<string|null>(null)` + `flashTimer = useRef<number|null>(null)` + `setTimeout(() => setFlash(null), 3500~4000)` + `clearTimeout` 조합을 독립적으로 구현하고, 최종적으로 공용 `<FeedbackBanner>`(`components/FeedbackBanner.tsx`)에 전달합니다. 렌더링은 이미 공유되지만 상태 관리 로직만 3중 복제되어 있습니다.
- **영향도**: 타임아웃 값이 3500ms/4000ms로 파일마다 미세하게 다르고, 버그 수정 시 3곳을 동시에 고쳐야 합니다.
- **권장 수정**: `useFlashMessage(timeoutMs = 4000)` 훅을 만들어 `[flash, showFlash, dismissFlash]`를 반환하고 세 파일에서 이를 사용하도록 교체합니다.
- **검증 방법**: 훅 도입 후 각 패널에서 flash 메시지 표시/자동 소멸/수동 dismiss 동작이 기존과 동일한지 수동 QA.

### P1-4. i18n 접근자(`ut`/`xt`/`pt`)가 6개 파일에 분산, 명명 규칙 비직관적

- **현황**: 번역 텍스트가 `uiI18n.ts`(1049줄, `ut()` 정의 `uiI18n.ts:1035`, 사용 378회), `panelI18n.ts`(18줄, `pt()` 정의 `panelI18n.ts:16`, 사용 43회), `chatI18n.ts`(29줄, `getChatText()` 정의 `chatI18n.ts:17`), `extraI18n.ts`(39줄, `xt()` 정의 `extraI18n.ts:39`, 사용 79회), `i18nCatalog.ts`(35줄, 로케일 감지/저장), `i18n.ts`(15줄, React Context `useI18n`/`t()`) 등 총 6개 파일·4가지 함수명(`ut`, `xt`, `pt`, `t`, `getChatText`)으로 나뉘어 있습니다. 같은 패널 안에서 `ut(locale, ...)`, `xt(locale, ...)`, `t(...)`, `pt(locale, ...)`가 혼용되는 경우가 흔합니다(예: `Tuning.tsx`는 4개 접근자를 모두 사용).
- **영향도**: 새 문자열을 추가할 때 어느 카탈로그에 넣어야 하는지 판단 기준이 코드에 드러나지 않고, 리뷰어가 `ut`/`xt`/`pt`의 의미 차이를 매번 추론해야 합니다.
- **권장 수정**: 단기적으로는 각 파일 상단에 "이 카탈로그는 무엇을 위한 것인가"를 문서화하고, 중기적으로는 `uiI18n`/`panelI18n`/`extraI18n`/`chatI18n`을 단일 네임스페이스(`i18n/catalog.ts` + 도메인별 하위 export)로 통합해 접근자를 하나(`t(locale, key)`)로 축소하는 것을 권장합니다. `uiI18n.ts` 1049줄은 도메인별(모델/런타임/설정 등) 서브파일로 재분할합니다.
- **검증 방법**: `assertUiCatalogComplete()` / `assertPanelCatalogComplete()` / `assertChatCatalogComplete()` 등 기존 완전성 검사 테스트가 통합 후에도 통과하는지 확인.

### P1-5. 서버 상태 가드가 `projectorChangeAllowed`와 달리 5개 파일에 임시방편으로 중복

- **현황**: `src/panels/visionState.ts:3`의 `projectorChangeAllowed(state)`는 `Models.tsx:187,462`와 `Tuning.tsx:162`에서 재사용되는 **모범 사례**입니다. 반면 "서버 실행 중" 여부를 나타내는 유사 가드는 공유 함수 없이 파일마다 인라인으로 재작성되어 있습니다: `Bench.tsx:66` `state === "running"`, `Models.tsx:113` `state === "running"`, `Runtimes.tsx:228` `state === "running"`, `Chat.tsx:199` `serverOn = state === "running"`, `Projects.tsx:63` `state === "running" || state === "starting" || state === "stopping"`. 마지막 `Projects.tsx`만 "starting/stopping"까지 포함해 의미가 미묘하게 다릅니다.
- **영향도**: "서버 실행 중" 판정 기준이 파일마다 달라 UI 간 일관성이 깨질 수 있습니다(예: 다른 패널은 "starting" 상태를 실행 중으로 보지 않는데 Projects만 봄).
- **권장 수정**: `visionState.ts`와 같은 패턴으로 `lifecycleUtils.ts`에 `isServerRunning(state)` / `isServerBusy(state)`를 추가하고 5개 파일에서 교체합니다. 의미 차이가 의도된 것이라면(Projects의 "starting/stopping" 포함) 주석으로 근거를 남깁니다.
- **검증 방법**: 교체 후 각 패널에서 서버 시작/정지/실패 전이 시 버튼 활성화 상태가 기존과 동일한지 수동 확인.

### P1-6. `CustomSelect` 콤보박스의 ARIA 배선 누락

- **현황**: `src/components/ThemeSwitcher.tsx:34-247`의 `CustomSelect`는 트리거 버튼에 `role="combobox"` `aria-expanded` `aria-haspopup="listbox"`(167-174)를 달지만 **`aria-controls`가 없어** 버튼이 어떤 리스트박스를 제어하는지 보조기술에 알리지 않습니다. 리스트박스(`<ul role="listbox">`, 198-202)는 `aria-labelledby={id}`로 라벨링되는데 `id`는 화면에서 숨긴 네이티브 `<select>`(150-166)의 id이지, 사람이 읽을 수 있는 라벨 요소가 아닙니다. 방향키 처리(`handleKeyDown`, 109-140)는 포커스를 리스트박스로 옮기지 않고 버튼에 포커스를 둔 채 `ArrowDown`/`ArrowUp`에서 곧바로 `onChange`를 호출해 값을 확정합니다(122-133) — `aria-activedescendant`로 하이라이트만 이동시키는 표준 콤보박스 패턴이 아니라, 매 키 입력마다 실제 선택값이 바뀝니다. 타이핑으로 옵션을 찾는 typeahead도 없습니다.
- **영향도**: 스크린리더 사용자가 옵션 탐색 중(엔터로 확정하기 전)에 이미 값이 계속 바뀌어 버려 미리보기/취소가 불가능하고, `aria-controls` 부재로 NVDA/JAWS가 "목록 상자 X개 항목 접힘/펼침" 같은 관계를 안내하지 못할 수 있습니다.
- **권장 수정**: 리스트박스에 고유 id(`${id}-listbox`)를 부여하고 버튼에 `aria-controls`로 연결, 버튼에 `aria-activedescendant`를 두어 현재 하이라이트된 옵션 id를 추적, 방향키는 하이라이트만 이동시키고 `Enter`/`Space`에서만 `onChange`를 커밋하도록 변경합니다.
- **검증 방법**: NVDA 또는 axe-core(`@axe-core/react`)로 `CustomSelect` 렌더 결과 자동 검사, 키보드만으로 옵션 탐색 후 Escape로 취소 시 원래 값이 유지되는지 확인.

### P1-7. Chat 스트리밍 렌더가 매 프레임 메시지 배열 전체를 복제

- **현황**: `Chat.tsx:343-355`의 `scheduleAssistantRender`는 `requestAnimationFrame`으로 스로틀링은 되어 있으나(좋은 패턴), 콜백 내부에서 `const next = current.slice();`(350줄)로 **전체 메시지 배열을 매 프레임 복제**한 뒤 마지막 원소만 교체합니다. 동일 패턴이 `Chat.tsx:502,535`에도 반복됩니다.
- **영향도**: 짧은 대화에서는 무해하지만, 스레드가 길어질수록(수백 메시지) 토큰 스트리밍 중 매 rAF마다 O(n) 배열 복사가 발생해 저사양 기기에서 스트리밍 프레임 드랍 가능성이 있습니다.
- **권장 수정**: 마지막 메시지를 별도 `streamingMessage` state로 분리해 렌더링하거나, `msgs`를 불변 배열 대신 마지막 원소만 교체하는 구조(예: `[...current.slice(0, -1), updated]`는 동일하게 O(n)이므로) 근본적으로는 스트리밍 중인 assistant 메시지를 msgs 배열 밖에 두고 별도로 렌더링하는 것을 권장합니다.
- **검증 방법**: 200+ 메시지 스레드에서 스트리밍 시 React DevTools Profiler로 프레임당 렌더 비용 측정.

---

## P2 (정보성 / 여유 있을 때)

### P2-1. Bench 히스토리 목록이 비-시맨틱 div로 표 데이터를 표현

- **현황**: `Bench.tsx:195-215`의 메인 벤치마크 결과는 `<table>`/`<caption className="sr-only">`/`scope="col"`을 갖춘 정상적인 시맨틱 표입니다. 반면 `Bench.tsx:227-230`의 "히스토리" 섹션은 날짜·모델·결과값을 열거하는 동일 성격의 표 데이터를 `<div className="flex ... justify-between">`로만 표현해 표 시맨틱스가 없습니다.
- **영향도**: 스크린리더 사용자가 히스토리 항목 간 열 관계(날짜/모델/tps)를 인지하기 어렵습니다. 메인 표보다 우선순위는 낮습니다.
- **권장 수정**: 히스토리도 `<table>` 또는 `role="table"/"row"/"cell"` 구조로 전환하거나, 최소한 각 레코드를 `<dl>`(설명 목록)로 바꿔 레이블-값 관계를 명시합니다.
- **검증 방법**: axe-core 규칙 `table-fake-caption`/구조 검사, 스크린리더로 히스토리 항목 3개 이상 순회 테스트.

### P2-2. 진행률 바의 `aria-valuenow`와 시각적 너비가 총량 미확정 상태에서 서로 모순

- **현황**: `Discover.tsx:128,161`, `Runtimes.tsx:754,811`의 진행률 바는 `total`이 아직 0(다운로드 시작 전)일 때 `aria-valuenow`를 `undefined`로 두어 ARIA상 "불확정(indeterminate)" 상태를 올바르게 표현합니다. 그런데 같은 상황에서 시각적 `width`는 `Runtimes.tsx:754,811`에서 `"100%"`로 렌더링됩니다(`style={{ width: ... : "100%" }}`). 즉 화면에는 막대가 꽉 찬 것처럼 보이지만 보조기술에는 "값 없음(진행 안 됨)"으로 전달되는 시각/시맨틱 불일치가 있습니다.
- **영향도**: 시각적으로는 "다운로드 완료"처럼 보이는데 실제로는 막 시작한 상태라 사용자가 오해할 수 있습니다.
- **권장 수정**: 총량 미확정 구간에서는 CSS 애니메이션(스트라이프/펄스)으로 "진행 중, 진척도 불명"을 표현하고 `width: 100%` 대신 불확정 상태 전용 스타일 클래스를 사용합니다.
- **검증 방법**: 대형 런타임 다운로드 시작 직후 1~2초 구간을 스크린샷/녹화하여 막대 상태 확인.

### P2-3. `PageShell`이 재사용 가능한 제네릭 컴포넌트임에도 `App.tsx` 내부 비공개 함수로 존재

- **현황**: `App.tsx:51-93`의 `PageShell<T extends string>`은 `TabNav`, `EmptyState`, `FeedbackBanner`처럼 제네릭·재사용 지향으로 설계되었지만(사이드 네비 + 탭패널 aria 배선 포함) `src/components/`로 승격되지 않고 `App.tsx`(319줄) 내부 로컬 함수로 남아 현재 `models`/`developer` 스코프(286,304줄)에서만 쓰입니다.
- **영향도**: 코드 자체 문제는 아니지만, 다른 모든 재사용 컴포넌트가 `components/`에 있는 프로젝트 컨벤션과 어긋나 향후 세 번째 스코프가 필요할 때 위치를 찾기 어렵습니다.
- **권장 수정**: `src/components/PageShell.tsx`로 이동. 기능 변경 없음.
- **검증 방법**: 이동 후 `App.tsx` 렌더 스냅샷/기존 테스트 통과 확인.

### P2-4. Windows 프로세스 환경변수 allowlist(`%SystemDrive%` 등) — 확인 결과 의도된 설계

- **현황**: `src-tauri/src/runtime.rs:823-846`에 `PLATFORM_ENVIRONMENT`로 `SystemDrive`, `SystemRoot`, `WINDIR` 등이 나열되어 있고, 바로 위 주석(818-822줄)에 "Windows는 PATH만으로는 CRT/로더/SDK가 정상 동작하지 않아 이 목록이 필요하다"는 근거가 명확히 문서화되어 있습니다. 자식 프로세스(`llama-server.exe` 등) 실행 시 화이트리스트 기반으로 환경을 구성하는 것은 임의 환경변수 전체를 상속하는 것보다 안전한 방향입니다.
- **영향도**: 없음 — 코드 검토 결과 "아티팩트(불필요한 잔재)"가 아니라 크로스 플랫폼 프로세스 스폰 안정성을 위한 의도된 화이트리스트입니다.
- **권장 수정**: 조치 불필요. 다만 목록이 실제로 필요한 최소 집합인지 6개월 주기로 재검토할 것을 권장(신규 SDK 도입 시 항목 추가 필요 가능).
- **검증 방법**: 해당 없음(정보성).

### P2-5. `pdf_extract` 빈 패스워드 복호화 — 확인 결과 표준 동작, 오류 메시지만 재확인 권장

- **현황**: `src-tauri/src/lib.rs:520-539`의 `extract_pdf_text`는 `document.is_encrypted()`일 때 `document.decrypt("")`를 시도합니다(524-527줄). 이는 "소유자 암호만 걸려 있고 사용자 암호는 빈 문자열"인 PDF(뷰어에서 열람은 되지만 편집만 제한된 흔한 배포 방식)를 지원하기 위한 `pdf_extract` 크레이트의 표준 패턴이며, 실제 사용자 암호가 걸린 PDF는 `decrypt("")`가 실패해 `"cannot decrypt PDF without a password"` 오류로 적절히 처리됩니다(526줄). 추출 결과에는 `MAX_EXTRACTED_DOCUMENT_BYTES` 상한(`LimitedWriter`, 528,533-534줄)도 걸려 있어 DoS 우려도 낮습니다.
- **영향도**: 보안 결함 아님. 다만 오류 메시지가 "빈 패스워드로 복호화 실패"와 "실제 패스워드 필요"를 구분하지 않아 사용자가 원인을 오해할 수 있습니다.
- **권장 수정**: 조치 불필요(기능 변경 없음). 선택적으로 오류 메시지를 "이 PDF는 패스워드로 보호되어 있어 자동 추출할 수 없습니다"로 더 명확히 다듬는 정도만 고려.
- **검증 방법**: 해당 없음(정보성).

---

## 종합 우선순위 표

| 순위 | ID | 항목 | 근거 위치 | 영향 영역 |
|---|---|---|---|---|
| P0 | P0-1 | CSS wildcard `!important` 88개, 이전 권고 이후 오히려 증가 | `App.css:1648-1779`, `index.css:1` | 유지보수성, 테마 정합성 |
| P0 | P0-2 | 문서 64청크 초과 시 무통지 절단 | `Chat.tsx:384` | RAG 정확성, UX |
| P1 | P1-1 | App.css 1894줄 + BEM/Tailwind 혼재, 단일 번들 즉시 로드 | `App.css`, `App.tsx:3,19-29`, `main.tsx:7` | 성능, 일관성 |
| P1 | P1-2 | 패널 비대화(Tuning 930/Chat 848·useState 22/Runtimes 827) + ExecutionProfiles 위치 부적절 | `Tuning.tsx`, `Chat.tsx:95-116`, `Runtimes.tsx`, `components/ExecutionProfiles.tsx` | 아키텍처, 테스트 용이성 |
| P1 | P1-3 | flash 배너 상태·타이머 3중복 | `Models.tsx:33-52`, `Runtimes.tsx:193-299`, `Tuning.tsx:94-177` | 중복 제거 |
| P1 | P1-4 | i18n 접근자 6파일·4함수명 분산 (`ut`/`xt`/`pt`/`t`/`getChatText`) | `uiI18n.ts`, `panelI18n.ts`, `chatI18n.ts`, `extraI18n.ts`, `i18nCatalog.ts`, `i18n.ts` | 개발자 경험, 유지보수성 |
| P1 | P1-5 | 서버 상태 가드 5파일 임시 중복 (`projectorChangeAllowed`는 모범사례) | `Bench.tsx:66`, `Models.tsx:113`, `Runtimes.tsx:228`, `Chat.tsx:199`, `Projects.tsx:63` vs `visionState.ts:3` | 일관성, 버그 예방 |
| P1 | P1-6 | `CustomSelect` 콤보박스 ARIA 배선 누락 | `ThemeSwitcher.tsx:34-247` | 접근성(키보드/스크린리더) |
| P1 | P1-7 | Chat 스트림 렌더 시 전체 메시지 배열 복제 | `Chat.tsx:343-355,502,535` | 성능(장문 스레드) |
| P2 | P2-1 | Bench 히스토리 div 표 비-시맨틱 | `Bench.tsx:227-230` (메인 표 195-215는 정상) | 접근성 |
| P2 | P2-2 | 진행률 바 `aria-valuenow` vs 시각 너비 불일치 | `Discover.tsx:128,161`, `Runtimes.tsx:754,811` | 접근성, UX 일관성 |
| P2 | P2-3 | `PageShell` App.tsx 내부 위치 | `App.tsx:51-93` | 컨벤션 일관성 |
| P2 | P2-4 | `%SystemDrive%` 등 Windows env allowlist — 의도된 설계, 조치 불필요 | `runtime.rs:814-846` | 정보성(보안 우려 없음) |
| P2 | P2-5 | `pdf_extract` 빈 패스워드 — 표준 동작, 조치 불필요 | `lib.rs:520-539` | 정보성(보안 우려 없음) |

---

*본 리포트는 읽기 전용 점검 결과이며, 소스 코드는 일절 수정하지 않았습니다. 작업 트리의 기존 미커밋 변경(`src-tauri/Cargo.toml`, `App.tsx`, `ExecutionProfiles.tsx`, `modelProfiles.*`, `Mcp.tsx`, `Models.layout.test.tsx`, `Tuning.tsx`, `uiI18n.ts`)은 되돌리지 않았습니다.*
