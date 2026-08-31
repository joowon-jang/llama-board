# P1-4 i18n 최종 검수 — Codex 담당 (14차 사이클)

- 검수일: 2026-08-31
- 대상: Claude 13차의 src/i18nUnified.ts 중앙 accessor 통합
- 검수 범위: namespace routing, placeholder/fallback, useI18n().t 타입·호출부, catalog 중복 lookup 제거, 전체 npm 게이트
- 파일 변경: 기존 worktree 변경은 보존했고, 이 리포트만 추가했다. 소스·테스트 파일은 수정하지 않았다.
- 종합 판정: **조건부 통과 — 정상 경로와 회귀 게이트는 통과했으나, 중앙 accessor 계약을 엄격히 적용하면 잔여 이슈 2건이 있다.**

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| base/ui/panel/extra/chat namespace routing | 통과 | src/i18nUnified.ts:29-48이 다섯 catalog를 namespace별로 조회한다. scripts/test-i18n.ts:62-68에서 4 locale의 109 base, 517 ui, 97 panel, 38 extra, 68 chat key를 모두 catalog 값과 대조했다. |
| locale fallback 및 정상 key 동작 | 통과 | 각 catalog completeness assert와 test:i18n의 모든 locale/key assertion이 통과했다. translate()의 locale 값 우선, en fallback 순서도 기존 ut()의 base/ui 동작과 동일하다. |
| non-ui placeholder 치환 | 통과 | substitute()가 namespace 분기 이후 공통으로 적용되며, scripts/test-i18n.ts:73-74에서 extra.presetLoaded와 chat.deleteBody 치환을 직접 검증했다. 현재 panel catalog에는 placeholder-bearing 문자열이 없다. |
| unknown key 동작의 완전한 기존 호환 | **미달(수정 권고)** | 현재 translate()는 모든 namespace의 unknown key를 bare key로 반환한다(src/i18nUnified.ts:32-47). HEAD의 pt()/xt()/getChatText()는 invalid key에 undefined를 반환했으므로 비-ui namespace의 runtime 동작이 달라졌다. scripts/test-i18n.ts:79-81은 ui unknown만 검사해 이 차이를 검출하지 못한다. |
| useI18n().t unified accessor 사용 및 타입 | 통과 | src/i18n.ts:3,13,18이 UnifiedKey, TranslationVars, translate()를 사용한다. npm run typecheck와 npm run build가 통과했다. |
| legacy accessor 호출 제거 | 통과 | production src에서 ut(, pt(, xt(, getChatText( 검색 결과가 없다. |
| direct catalog value import 제거 | **부분 통과(수정 권고)** | uiText/panelText/extraText/chatText의 production value import는 unified accessor 한 곳에만 남았다. 그러나 src/components/ErrorBoundary.tsx:3,25-32가 messages를 직접 import·indexing해 중앙 accessor를 우회한다. |
| dynamic key 및 t prop threading | 통과 | runtime phase, backend/advisory, endpoint, tuning label 매핑이 typed key를 사용하고, presentational component의 t props가 UnifiedKey+TranslationVars를 받는다. typecheck 및 UI tests에서 회귀가 없었다. |
| catalog 중복 lookup 제거 | 통과(단, ErrorBoundary 예외) | uiI18n.ts, panelI18n.ts, extraI18n.ts, chatI18n.ts에는 data/type/completeness assert만 있고 기존 ut/pt/xt/getChatText 구현은 제거됐다. i18nCatalog.ts의 locale detection/storage는 lookup 구현이 아닌 기존 locale utility다. |

## 2. 중앙 accessor 및 호환성 검토

### 정상 namespace routing

src/i18nUnified.ts:15-20의 UnifiedKey는 base key와 ui., panel., extra., chat. prefix를 각각 해당 catalog key type에 연결한다. translate()는 prefix를 먼저 판별하고 catalog별로 locale → en → bare key 순서로 조회한 뒤 공통 substitute()를 호출한다.

npm run test:i18n의 전수 대조는 각 locale에서 다음 결과를 확인했다.

    i18n catalog and preference validation passed (109 app keys, 68 chat keys, 97 panel keys, 38 extra keys, 517 ui keys, 4 locales)
    unified translate() namespace routing, placeholder substitution, and fallback verified

### Placeholder

기존 ut()의 정규식과 동일한 /{(\w+)}/ 치환 규칙을 substitute() 하나로 공유한다. 제공되지 않은 변수는 placeholder를 그대로 남기며(scripts/test-i18n.ts:76-77), extra/chat namespace에도 같은 규칙이 적용된다.

### 잔여 이슈 A — 비-ui unknown key 의미 변경

src/i18nUnified.ts:32-47의 네 분기 모두 다음 형태를 사용한다.

    catalog[locale][key] ?? catalog.en[key] ?? key

HEAD에서 pt(), xt(), getChatText()는 각각 catalog[locale][key]만 반환했다. 따라서 잘못된 runtime key를 주입했을 때 기존 비-ui accessor 결과는 undefined였지만 현재 unified accessor 결과는 "__missing__" 같은 bare key다. 현재 production의 typed 정상 호출은 이 경로에 도달하지 않지만, 이번 검수 요구사항이 “unknown key 동작도 기존과 동일”을 포함하므로 계약을 명확히 정하고 회귀 assertion을 namespace별로 보강해야 한다.

현재 focused probe 결과:

    ui unknown    -> "__missing__"
    panel unknown -> "__missing__"
    extra unknown -> "__missing__"
    chat unknown  -> "__missing__"

scripts/test-i18n.ts:79-81은 ui unknown만 확인하며 panel/extra/chat의 기존 undefined 결과는 검증하지 않는다. bare-key fallback을 새 의도된 계약으로 채택한다면 해당 변경을 명시하고 네 namespace assertion을 추가해야 하며, 엄격한 backward compatibility가 요구되면 accessor 반환 계약을 별도로 조정해야 한다.

### 잔여 이슈 B — ErrorBoundary의 base catalog 우회

레거시 도메인 accessor 호출과 uiText/panelText/extraText/chatText value import는 제거됐지만, src/components/ErrorBoundary.tsx:3은 여전히 messages를 ../i18n에서 import한다. :25-32에서 messages[locale]를 직접 읽어 error.wrong/error.tryAgain을 렌더하므로 i18nUnified.ts 주석의 “유일한 key routing 장소”와 중앙 accessor 정책을 엄밀히 만족하지 않는다.

이는 일반 panel 호출에는 영향을 주지 않고 fallback error UI에서만 발생하지만, central accessor 통합 범위에 base catalog도 포함한다면 translate(locale, "error.wrong")/translate(locale, "error.tryAgain") 경로로 후속 정리해야 한다. 이번 작업 지시에 따라 소스는 수정하지 않았다.

## 3. Static migration audit

- exact call audit: production src에서 ut(, pt(, xt(, getChatText( 0건.
- domain catalog value import audit: i18nUnified.ts만 uiText, panelText, extraText, chatText를 value import한다. 예외적으로 ErrorBoundary.tsx에 base messages value import가 남아 있다.
- src/i18n.ts:13,18의 t signature는 (key: UnifiedKey, vars?: TranslationVars) => string이다.
- ExecutionProfileCards, runtime presentational cards, Tuning section components 등 prop-threading 경계는 동일 signature를 사용한다.
- RuntimeBackendList, RuntimePortableBundle, RuntimePullRequestCard, RuntimePullRequestProvenance, Developer endpoint, Mcp policy, useTuningController label 매핑의 dynamic template keys가 typecheck를 통과했다.
- catalog tails 확인 결과 sibling files는 data/type/assert 위주로 남았으며 중복 accessor 함수는 삭제됐다. extraI18n.ts의 assertExtraCatalogComplete()도 module load 시 실행된다.

## 4. 직접 실행한 회귀 게이트

| 명령 | 결과 |
| --- | --- |
| npm run test:i18n | 통과 — 109/68/97/38/517 keys, 4 locales; unified routing, placeholder, ui fallback assertion 통과 |
| npm run typecheck | 통과 — tsc --noEmit -p tsconfig.json |
| npm run lint | 통과 — eslint src |
| npm test | 통과 — direct Node assertions 전체 통과, Vitest 18 files / 84 tests 통과 |
| npm run build | 통과 — TypeScript + Vite 7.3.6 production build, 121 modules transformed |

npm test 중 jsdom의 HTMLCanvasElement.getContext() 미구현 안내 2건은 출력됐지만 테스트 실패로 집계되지 않았고 exit code는 0이었다. 빌드와 테스트 실행으로 생성된 dist/ 변경은 ignore 대상이며, 기존 worktree 변경은 되돌리지 않았다.

## 5. 잔여 조치

1. central accessor 범위를 base messages까지 엄격히 적용할지 결정하고, 적용한다면 ErrorBoundary의 직접 index를 unified translate() 호출로 교체한다.
2. non-ui unknown key에 대해 backward-compatible undefined와 새 bare-key fallback 중 하나를 명시적인 계약으로 선택한다. 선택한 계약에 맞춰 scripts/test-i18n.ts에 panel/extra/chat unknown assertion과 locale fallback assertion을 추가한다.
3. 위 두 결정 후 npm run test:i18n, npm run typecheck, npm run lint, npm test, npm run build를 다시 실행하면 P1-4 최종 sign-off가 가능하다.
