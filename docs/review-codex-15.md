# P1-4 i18n 최종 sign-off — Codex 담당 (15차 사이클)

- 검수일: 2026-08-31
- 대상: 14차 검수의 조건부 이슈 수정본 (`ErrorBoundary` 중앙 accessor 적용 및 unified unknown-key 계약)
- 검수 범위: ErrorBoundary fallback UI, base/ui/panel/extra/chat routing·fallback·placeholder, legacy accessor 및 catalog 우회 import 정적 감사, 전체 npm 게이트
- 파일 변경: 기존 uncommitted 변경은 보존했고, 이 리포트만 추가했다. 소스·테스트 파일은 수정하지 않았다.
- 종합 판정: **조건부 통과 — production 동작·정적 감사·전체 게이트는 통과했으나, locale → en fallback을 `scripts/test-i18n.ts`가 실제 누락 키로 주입해 검증하는 assertion이 없어 P2 테스트 커버리지 공백이 남았다.**

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| ErrorBoundary의 catalog 직접 import/index 제거 | 통과 | `src/components/ErrorBoundary.tsx:3`은 `translate`와 `Locale` 타입만 import한다. `:30-32`에서 `error.wrong`/`error.tryAgain`을 모두 `translate(locale, ...)`로 표시한다. |
| ErrorBoundary locale 감지 및 기존 fallback | 통과 | `:25-26`이 `document.documentElement.lang`의 지역 태그를 분리해 `ko/en/ja/zh`만 허용하고 나머지는 `en`으로 fallback한다. 기존 `index.html:14-15`의 브라우저 언어 감지와 `src/App.tsx:123-132`의 document lang 갱신 경로도 유지된다. |
| unified unknown runtime key 계약 | 통과 | `src/i18nUnified.ts:7-14`가 모든 namespace에서 bare-key fallback을 문서화하고, `:31-48`의 base/ui/panel/extra/chat 다섯 분기가 각각 locale → `en` → bare key 순서로 반환한다. |
| 전수 namespace routing | 통과 | `scripts/test-i18n.ts:62-68`이 4개 locale에서 base 109, ui 517, panel 97, extra 38, chat 68개를 각각 `translate()`와 catalog 값으로 대조한다. |
| unknown key assertion | 통과 | `scripts/test-i18n.ts:79-86`이 ui/panel/extra/chat의 `__missing__`와 base의 `error.__missing__`을 모두 확인한다. |
| placeholder 치환 | 통과 | `scripts/test-i18n.ts:70-77`이 ui/extra/chat placeholder 치환과 누락 변수 보존을 확인한다. 현재 base/panel catalog에는 실제 placeholder-bearing 값이 없다. |
| locale → en fallback assertion | **P2 보완 권고** | `scripts/test-i18n.ts:31-57`은 각 locale의 값이 완전한지만 검사하고, `:62-68`은 정상 locale 값을 비교한다. 선택 locale의 key를 의도적으로 누락시켜 `en` 값으로 fallback하는 회귀 assertion은 없다. production 구현은 별도 in-memory probe로 다섯 namespace 모두 통과했다. |
| legacy accessor 호출 제거 | 통과 | production `src`의 정확한 identifier 검색에서 `ut(`, `pt(`, `xt(`, `getChatText(`가 모두 0건이다. |
| catalog value 우회 import/index 제거 | 통과 | `i18nUnified.ts` 외 production 파일에서 `messages`/`uiText`/`panelText`/`extraText`/`chatText` value import 또는 catalog indexing이 발견되지 않았다. `src/i18n.ts:22`의 `messages` re-export는 기존 facade 호환용이며 consumer가 없다. |

## 2. ErrorBoundary 검수

현재 `src/components/ErrorBoundary.tsx`는 다음 경로를 사용한다.

- `:3` — `messages` value import 없이 `translate`와 `Locale` 타입만 import.
- `:25` — `document.documentElement.lang.split("-")[0]`로 기존과 동일하게 primary language를 추출.
- `:26` — 지원 locale 네 가지를 명시적으로 허용하고 미지원/빈 값은 `en`으로 fallback.
- `:30` — `translate(locale, "error.wrong")`를 `EmptyState.title`에 전달.
- `:31` — `translate(locale, "error.tryAgain")`를 description에 전달.
- `:32` — 같은 `error.tryAgain` translation을 retry action label에 전달.

초기 HTML은 `index.html:2`에서 `lang="en"`으로 시작하고, inline bootstrap 감지는 `:14-15`에서 navigator 언어를 `ko/ja/zh/en`으로 정규화한다. React 앱도 `src/App.tsx:123-132`에서 현재 locale을 다시 `document.documentElement.lang`에 반영하므로 ErrorBoundary가 보는 locale source와 일반 UI의 locale이 같은 상태로 유지된다. 기존의 지원 locale 표시와 미지원 locale의 영어 fallback 동작은 유지되며, 직접 `messages[locale]`을 읽던 우회만 제거됐다.

## 3. Unified accessor 계약

`src/i18nUnified.ts:16-21`의 `UnifiedKey`가 base key와 `ui.`, `panel.`, `extra.`, `chat.` namespace를 각각 해당 key type으로 연결한다. `translate()`의 다섯 분기는 모두 같은 우선순위를 사용한다.

```text
catalog[locale][key] ?? catalog.en[key] ?? bare key
```

이제 runtime에서 typed key 바깥의 값이 들어와도 undefined 대신 bare key가 반환된다. namespace prefix는 routing 전용이므로 namespaced unknown key는 prefix를 제거한 key를 반환하고, base key는 입력 key 자체를 반환한다.

```text
ui.__missing__     -> __missing__
panel.__missing__  -> __missing__
extra.__missing__  -> __missing__
chat.__missing__   -> __missing__
error.__missing__  -> error.__missing__
```

`scripts/test-i18n.ts:79-86`의 assertion이 위 계약을 모두 직접 확인하며 `npm run test:i18n`에서 통과했다. 또한 별도 read-only in-memory probe에서 각 catalog의 `ko` key를 일시적으로 제거한 뒤 base/ui/panel/extra/chat 각각이 `en` 값을 반환하는지 확인했고 다섯 namespace 모두 통과했다.

## 4. `scripts/test-i18n.ts` coverage 검수

정상 경로 coverage는 충분하다.

- `:31-57` — 4 locale의 base/ui/panel/extra completeness와 build-phase UI 번역 검증.
- `:62-68` — 4 locale × 5 namespace 전체 routing을 catalog 값과 전수 대조.
- `:70-77` — ui, extra, chat placeholder 치환 및 누락 변수의 placeholder 보존 검증.
- `:79-86` — base/ui/panel/extra/chat unknown key의 bare-key 계약 검증.

### P2 — locale fallback 회귀 assertion 누락

`scripts/test-i18n.ts:31-57`에서 각 locale의 catalog 값이 모두 존재하도록 assert하고, `:62-68`에서 그 완성된 값을 그대로 비교하기 때문에 `catalog[locale][key]`가 없는 경우의 `catalog.en[key]` fallback 분기는 실행되지 않는다. 현재 구현의 fallback expression은 `src/i18nUnified.ts:33,37,41,45,48`에 정확히 존재하고 별도 in-memory probe는 통과했으므로 production regression은 확인되지 않았다. 다만 이번 acceptance 조건이 “script가 locale fallback을 검증”하는 것까지 포함하므로, 다음 보완에서 namespace별 key 하나를 격리 fixture 또는 일시적 누락으로 만들어 `translate(locale, namespacedKey) === catalog.en[key]`를 assertion하는 것이 필요하다.

이 보완은 테스트 harness의 coverage 문제이며 현재 기능의 runtime failure가 아니다. 본 사이클에서는 지시대로 소스와 테스트를 수정하지 않았다.

## 5. Static migration audit

production `src`(test 파일 제외)를 exact identifier로 검색했다.

| 검색 대상 | 결과 |
| --- | ---: |
| `ut(` | 0 |
| `pt(` | 0 |
| `xt(` | 0 |
| `getChatText(` | 0 |
| `messages`/`uiText`/`panelText`/`extraText`/`chatText` value import outside `i18nUnified.ts` | 0 |
| catalog value indexing outside `i18nUnified.ts` | 0 |

catalog 파일 내부의 completeness assert가 자기 catalog를 indexing하는 것과 `src/i18n.ts:22`의 facade re-export는 중앙 accessor 우회 consumer가 아니므로 위 결과의 예외로 보지 않았다. `ErrorBoundary.tsx`에도 `messages` import/indexing은 더 이상 없다.

## 6. 직접 실행한 게이트

| 명령 | 결과 |
| --- | --- |
| `npm run test:i18n` | **통과**, exit 0 — 109 base / 68 chat / 97 panel / 38 extra / 517 ui keys, 4 locales; unified routing·placeholder·unknown fallback 출력 확인 |
| `npm run typecheck` | **통과**, exit 0 — `tsc --noEmit -p tsconfig.json` |
| `npm run lint` | **통과**, exit 0 — `eslint src` |
| `npm test` | **통과**, exit 0 — direct script tests 및 Vitest 18 files / 84 tests |
| `npm run build` | **통과**, exit 0 — Vite 7.3.6, 121 modules transformed |

`npm test` 중 jsdom의 `HTMLCanvasElement.getContext()` 미구현 안내 2건은 출력됐지만 테스트 실패로 집계되지 않았다. 별도 locale fallback in-memory probe도 exit 0으로 base/ui/panel/extra/chat 모두 통과했다.

## 7. Worktree 보존

검수 시작 전후 `git status --short`를 대조했으며 기존의 `package*.json`, `scripts`, `src`, `src-tauri`, `docs/` 등 uncommitted 변경은 보존됐다. 테스트와 build로 tracked source 변경은 추가되지 않았고, 이 사이클에서 작성한 artifact는 `docs/review-codex-15.md` 하나다.

## 최종 결론

14차에서 지적한 ErrorBoundary의 base catalog 직접 우회와 non-ui unknown key 의미 미명시 문제는 해결됐다. 중앙 accessor의 다섯 namespace routing, bare-key runtime 계약, placeholder 처리, legacy accessor 제거, 전체 npm 게이트는 모두 통과했다. 다만 `scripts/test-i18n.ts` 자체에 선택 locale 누락을 주입하는 locale → en fallback 회귀 assertion이 없으므로, 엄격한 checklist 기준 최종 판정은 **P2 조건부 통과**로 보고한다.
