# P1-1 CSS 분할 검수 보고서 (Codex 10차)

## 판정

`src/App.css`를 ordered entrypoint로 유지하고 8개 파일로 분리한 구조 자체는 통과한다. 원본(분할 전 `App.css`)과 현재 분할 결과를 정적 비교했을 때, P0-1 wildcard 제거 및 토큰화로 명시된 차이를 제외하면 selector 순서와 선언 본문이 보존되며, 요청된 npm 게이트도 모두 통과했다.

다만 P0-1 클래스 치환과 관련된 cascade 잔여 이슈 2건이 확인되어 최종 판정은 **조건부 통과(수정 권고)** 이다. 검수 조건에 따라 소스는 수정하지 않았고, 이 문서만 추가했다.

## 검수 대상과 방법

- 대상 entrypoint: `src/App.css`
- 분할 파일: `src/styles/app-*.css` 8개
- 비교 기준: 분할 전 원본 `App.css`(HEAD 기준)
- 비교 방법: 주석과 whitespace를 정규화한 뒤 CSS rule의 selector 순서와 선언 본문을 비교했다. P0-1에서 의도한 `[class*=` 기반 규칙 제거, 테마 토큰 추가, mono 색상 토큰화, 새 `app-*` 치환 selector는 별도 expected change로 분리했다.
- import 소비자: `src/App.tsx:3`, `src/panels/Models.layout.test.tsx:7`
- 이번 보고서에서는 P1-4 i18n 단일 accessor 통합을 평가하지 않았다.

## 구조 및 순서 검수

`src/App.css:1-8`은 다음 순서의 8개 unique import만 포함한다.

1. `./styles/app-tokens.css`
2. `./styles/app-base.css`
3. `./styles/app-components.css`
4. `./styles/app-shell.css`
5. `./styles/app-settings.css`
6. `./styles/app-layout.css`
7. `./styles/app-panels.css`
8. `./styles/app-responsive.css`

이 순서는 원본 `App.css`의 cascade 그룹 순서(tokens → base → components → shell → settings → layout → panels → responsive)와 일치한다. 8개 분할 파일 내부에는 추가 CSS `@import`가 없고, entrypoint를 포함한 import graph에 중복 또는 순환 import가 없다.

정규화한 정적 비교 결과:

| 항목 | 원본 | 분할 결과 | 판정 |
| --- | ---: | ---: | --- |
| raw CSS rules | 408 | 330 | 기존 분리/병합 및 expected token 변경으로 감소 |
| 비교 가능한 normalized rules | 320 | 320 | 통과 |
| 비교 가능한 selector 순서 | - | exact match | 통과 |
| 비교 가능한 선언 본문 차이 | - | 3개 rule | expected change만 존재 |
| breakpoint/media 순서 | 7개 | 동일 순서 | 통과 |

3개 선언 본문 차이는 dark/light token block의 새 dedicated 변수 추가와 `.app-shell pre, .app-shell code`의 mono 색상 토큰화뿐이다. 기존 selector의 실질적인 순서/본문 변경은 발견되지 않았다.

## wildcard 및 중복 검수

`src/App.css`와 `src/styles` 전체에서 literal `[class*=`를 재검색한 결과는 **0건**이다. 비교 기준 원본에는 P0-1 제거 대상 wildcard literal 113건이 있었으며, 현재 결과에는 남아 있지 않다.

현재/원본의 selector 중복 통계는 다음과 같아 분할 과정에서 중복 rule이 새로 유입되지 않았다.

| 항목 | 원본 | 분할 결과 |
| --- | ---: | ---: |
| unique selector key | 359 | 281 |
| 중복 selector key | 35 | 35 |
| 중복 selector instance | 49 | 49 |

남은 중복은 responsive override와 base/상태 조합에 이미 존재하던 cascade 패턴이다. breakpoint 순서는 다음과 같이 원본과 분할 결과가 exact match한다.

`forced-colors: active` → `prefers-contrast: more` → `max-width: 1200px` → `max-width: 1023px` → `max-width: 900px` → `max-width: 900px and min-width: 641px` → `max-width: 640px`

## import 소비자 검수

- `src/App.tsx:3`의 `import "./App.css"`는 유지된다.
- `src/panels/Models.layout.test.tsx:7`의 `import "../App.css"`는 유지된다.
- 관련 test/build/typecheck가 모두 성공하여 두 경로 모두 현재 프로젝트 구성에서 동작함을 확인했다.

## 발견된 잔여 이슈

### P1: `app-bg-danger-strong`가 `bg-red-900`에 의해 무효화됨

`src/panels/Models.tsx:411`에는 `bg-red-900 app-bg-danger-strong`가 같은 element에 함께 적용된다. `src/styles/app-panels.css`의 `.app-bg-danger-strong`는 한 class selector이고, Vite가 생성한 CSS에서 해당 custom rule은 offset 33865에, Tailwind `.bg-red-900` utility는 offset 59702에 위치한다.

두 selector의 specificity가 동일하므로 뒤에 생성된 `.bg-red-900`이 background를 덮어쓴다. 따라서 `--board-bg-danger-strong` 토큰을 사용하려는 `app-bg-danger-strong`가 실제 화면에서 유효하지 않을 수 있다. 이번 검수는 소스 수정을 금지하므로 수정하지 않았으며, custom utility specificity 또는 utility 생성/사용 방식을 조정해야 한다.

### P1: `hover:app-bg-accent-solid`에 대응하는 CSS rule이 생성되지 않음

`src/panels/Models.tsx:388` 및 `:454`에는 `hover:app-bg-accent-solid`가 사용되지만, 현재 CSS에는 base `.app-bg-accent-solid`와 light theme variant만 있고 hover variant rule은 없다. 빌드 산출물에서 `.hover\\:app-bg-accent-solid` rule을 검색해도 생성되지 않는다.

그 결과 해당 두 버튼은 원본의 `hover:bg-indigo-500` 동작을 그대로 대체하지 못하고, hover 시 기본 `bg-indigo-600` 색이 유지될 가능성이 있다. `app-bg-accent-solid`를 hover 가능한 utility로 등록하거나 명시적인 `:hover` selector를 추가하는 후속 수정이 필요하다.

위 2건은 CSS 파일 분할의 import 순서 오류라기보다 P0-1 wildcard/class 치환과 utility cascade의 상호작용에서 발생한 회귀 가능성이다. 분할 구조 통과와 별개로 merge 전 확인이 필요하다.

## 빌드 산출물 marker/order 증거

Vite는 분할 CSS를 하나의 minified `dist/assets/index-B1mWqvaZ.css`로 합치며 source-file marker 주석은 제거한다. 따라서 파일 marker 대신 build CSS 내 대표 anchor의 byte/string offset을 확인했다.

| anchor | offset |
| --- | ---: |
| `--board-bg` (tokens) | 47 |
| `.app-button` (components) | 4437 |
| `.app-shell{` (shell) | 12247 |
| `.settings-page` (settings) | 21839 |
| `.app-page-shell` (layout) | 27669 |
| `.runtime-detected-device` (panels) | 28812 |
| `.models-panel` (panels) | 30667 |
| `.app-bg-muted` (P0-1 panel replacements) | 33344 |
| `@media(prefers-contrast` | 35699 |
| `@media(max-width:1200px` | 35985 |
| `@media(max-width:1023px` | 36194 |
| `@media(max-width:900px` | 36264 |
| `@media(max-width:640px` | 36961 |

이는 분할 파일의 주요 cascade 그룹과 responsive block이 기대한 순서로 build CSS에 들어갔음을 보여준다. 동시에 `.app-bg-danger-strong`(33865)보다 `.bg-red-900`(59702)이 뒤에 있는 것도 위 P1 이슈의 산출물 증거로 확인했다.

## 실행한 검증 게이트

모든 명령을 직접 실행했으며 exit code는 모두 0이다.

| 명령 | 결과 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — Vitest 17 files / 81 tests; direct script tests도 모두 통과 |
| `npm run build` | PASS — Vite 7.3.6, 120 modules transformed, CSS 76,416 bytes |

`npm test` 중 jsdom의 `HTMLCanvasElement.getContext()` not implemented notice 2건이 출력되었지만 실패로 처리되지 않았고 전체 테스트는 통과했다.

## 변경 파일

- 추가: `docs/review-codex-10.md`
- 수정하지 않음: `src/App.css`, `src/styles/*`, `src/App.tsx`, `src/panels/Models.layout.test.tsx` 및 기타 소스
- 기존 uncommitted 변경은 보존했다.

