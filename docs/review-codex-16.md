# P1-4 i18n 최종 sign-off — Codex 담당 (16차 사이클)

- 검수일: 2026-08-31
- 대상: 15차 검수 이후 coordinator가 보완한 `scripts/test-i18n.ts`의 locale → `en` fallback fixture/assertion
- 검수 범위: fallback fixture 복구·상태 오염, 다섯 catalog namespace fallback, `ErrorBoundary` 중앙 accessor와 locale 처리, `i18nUnified.ts` bare-key runtime 계약, production `src` 정적 감사, 전체 npm 게이트
- 파일 변경: 기존 uncommitted 변경은 보존했고 이 리포트만 추가했다. 소스와 테스트 파일은 수정하지 않았다.
- 종합 판정: **통과 — 보완된 다섯 catalog fallback assertion, 중앙 accessor 계약, 정적 감사 및 전체 npm 게이트가 모두 통과했다.**

## 1. 판정 요약

| 검수 항목 | 판정 | 근거 |
| --- | --- | --- |
| 임시 catalog mutation의 `finally` 복구 | 통과 | `scripts/test-i18n.ts:90-99`가 `catalog.ko[key]`의 원래 값을 저장하고 `try/finally`에서 삭제 후 복구한다. assertion/`translate()`가 throw해도 `finally`가 실행된다. |
| 다섯 catalog locale → `en` fallback assertion | 통과 | `scripts/test-i18n.ts:101-105`가 base `messages`, `uiText`, `panelText`, `extraText`, `chatText` 각각의 known key를 삭제한 뒤 `translate("ko", ...) === catalog.en[key]`를 확인한다. |
| 테스트 간 상태 오염 없음 | 통과 | 다섯 호출이 순차적으로 통과했고, 실제 스크립트 import 직후 5개 fixture key의 own property/문자열 복구를 확인하는 post-script probe도 통과했다. |
| `ErrorBoundary` unified translate 및 locale 처리 | 통과 | `src/components/ErrorBoundary.tsx:3,25-32`가 `translate`만 value import하고 `document.documentElement.lang`을 지원 locale로 정규화한 뒤 `error.wrong`/`error.tryAgain`을 중앙 accessor로 조회한다. |
| unified bare-key unknown runtime 계약 | 통과 | `src/i18nUnified.ts:31-48`의 다섯 분기가 locale → `en` → bare key 순서를 사용하고, `scripts/test-i18n.ts:82-86`이 ui/panel/extra/chat 및 base unknown key를 확인한다. |
| legacy accessor 호출/import | 통과 | production `src`의 `ut(`, `pt(`, `xt(`, `getChatText(` 호출 및 해당 legacy accessor import 검색 결과가 0건이다. |
| catalog value 우회 | 통과 | domain catalog value import/indexing은 `src/i18nUnified.ts`와 각 catalog 내부 completeness assert에만 남아 있고 production consumer의 직접 조회는 없다. `src/i18n.ts:22`의 `messages` re-export는 호환 facade export이며 별도 consumer는 확인되지 않았다. |
| npm 게이트 | 통과 | `npm run test:i18n`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` 모두 exit 0이다. |

## 2. `scripts/test-i18n.ts` fallback fixture 검수

### 복구 보장

현재 helper는 다음 순서로 동작한다.

```text
local = catalog.ko
original = local[key]
delete local[key]
try:
  assert(translate("ko", unifiedKey) === catalog.en[key])
finally:
  local[key] = original
```

`try` 안에서 assertion뿐 아니라 `translate()` 호출도 실행되므로, 실패·예외 경로 모두 `finally` 복구를 거친다. 다섯 catalog 호출은 같은 process 안에서 순차 실행되며 각 대상 key가 다음 호출 전에 원래 값으로 돌아온다.

| catalog | fixture key | unified key | fallback expected |
| --- | --- | --- | --- |
| base `messages` | `error.tryAgain` | `error.tryAgain` | `messages.en.error.tryAgain` |
| `uiText` | `installedOk` | `ui.installedOk` | `uiText.en.installedOk` |
| `panelText` | `models` | `panel.models` | `panelText.en.models` |
| `extraText` | `presetLoaded` | `extra.presetLoaded` | `extraText.en.presetLoaded` |
| `chatText` | `deleteBody` | `chat.deleteBody` | `chatText.en.deleteBody` |

`npm run test:i18n`은 다음 출력과 함께 다섯 assertion을 모두 통과했다.

```text
i18n catalog and preference validation passed (109 app keys, 68 chat keys, 97 panel keys, 38 extra keys, 517 ui keys, 4 locales)
unified translate() namespace routing, placeholder substitution, and fallback verified
```

추가로 실제 `scripts/test-i18n.ts`를 같은 Node process에서 import한 직후 위 5개 `ko` key의 own property와 non-empty string 복구를 검사했다.

```text
post-script catalog restoration probe passed (5/5)
```

따라서 fixture가 fallback branch를 실제로 통과하고, 뒤의 catalog assertion이나 process 종료 전 상태에 mutation을 남기지 않는 것으로 판단한다.

## 3. `ErrorBoundary` 및 unified accessor

`src/components/ErrorBoundary.tsx`는 다음 경로를 사용한다.

- `:3` — base `messages` value 대신 `translate`와 `Locale` 타입만 import한다. `translate`는 `src/i18n.ts:24`가 `i18nUnified.ts`에서 re-export하는 unified accessor다.
- `:25` — `document.documentElement.lang.split("-")[0]`로 primary language를 추출한다.
- `:26` — `ko`, `ja`, `zh`, `en`만 `Locale`로 허용하고 빈 값·미지원 값은 `en`으로 fallback한다.
- `:30-32` — `error.wrong` 및 `error.tryAgain` title/description/action label을 모두 `translate(locale, ...)`로 조회한다.

`src/i18nUnified.ts:31-48`은 namespace별로 다음 우선순위를 동일하게 적용한다.

```text
catalog[locale][key] ?? catalog.en[key] ?? bare key
```

현재 unknown string runtime 계약은 다음과 같이 확인됐다.

```text
ui.__missing__     -> __missing__
panel.__missing__  -> __missing__
extra.__missing__  -> __missing__
chat.__missing__   -> __missing__
error.__missing__  -> error.__missing__
```

namespace prefix는 routing 전용이므로 namespaced unknown key는 prefix 제거 후 bare key를 반환하고, base unknown key는 입력 key 자체를 반환한다. `scripts/test-i18n.ts:82-86`의 다섯 assertion이 이 계약을 직접 검증한다.

## 4. Production `src` 정적 감사

test 파일을 제외한 production `src`를 대상으로 다음을 검색했다.

| 검색 대상 | 결과 |
| --- | ---: |
| `ut(`, `pt(`, `xt(`, `getChatText(` 호출 | 0건 |
| 위 legacy accessor의 import | 0건 |
| `messages`/`uiText`/`panelText`/`extraText`/`chatText` value import outside `i18nUnified.ts` | 0건(단, `src/i18n.ts:22`의 기존 `messages` facade re-export는 별도 consumer 없음) |
| unified accessor 밖의 production catalog value indexing | 0건(각 catalog completeness assert의 자기 catalog 검사 제외) |

검색 중 `src/panels/Developer.tsx`의 Python snippet 안 `messages=[...]`는 OpenAI API 예제 문자열이며 i18n catalog import/index가 아니다. `src/chatUtils.ts`의 `messages[0]`도 대화 메시지 배열이지 catalog value가 아니므로 false positive로 분류했다.

## 5. 직접 실행한 게이트

| 명령 | 결과 |
| --- | --- |
| `npm run test:i18n` | **통과**, exit 0 — 109 base / 68 chat / 97 panel / 38 extra / 517 ui keys, 4 locales; routing·placeholder·unknown·locale fallback 확인 |
| `npm run typecheck` | **통과**, exit 0 — `tsc --noEmit -p tsconfig.json` |
| `npm run lint` | **통과**, exit 0 — `eslint src` |
| `npm test` | **통과**, exit 0 — direct Node assertion 전체 및 Vitest 18 files / 84 tests |
| `npm run build` | **통과**, exit 0 — Vite 7.3.6, 121 modules transformed |

`npm test` 중 jsdom의 `HTMLCanvasElement.getContext()` 미구현 안내 2건은 출력됐지만 실패로 집계되지 않았고 전체 명령은 exit 0으로 종료했다.

## 6. Worktree 보존 및 최종 결론

검수 전후 `git status --short --untracked-files=all`를 대조했다. 기존 `package*.json`, `scripts`, `src`, `src-tauri`, `docs/` 등 uncommitted 변경은 그대로 보존됐고, validation/build가 소스나 기존 문서를 추가로 변경하지 않았다. 이 사이클에서 추가한 artifact는 `docs/review-codex-16.md` 하나다.

15차의 P2 보완 권고였던 “script가 실제 누락 locale key를 주입해 `en` fallback을 assertion하지 않음”은 다섯 namespace fixture로 해결됐다. 이번 검수 범위에서 severity를 부여할 미해결 문제는 없으며, P1-4 최종 판정은 **통과**다.
