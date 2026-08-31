# Models.tsx CSS cascade 최종 검수 — Codex 12차

- 검수일: 2026-08-30
- 대상: Claude 11차 수정 및 `docs/review-codex-10.md`의 Models.tsx cascade 잔여 2건
- 검수 방식: 현재 worktree 정적 확인, production build CSS marker 확인, 신규 회귀 테스트 단독/전체 체인 실행, npm 게이트 직접 재실행
- 파일 수정: 이 리포트 1개만 추가했다. 기존 uncommitted 변경은 보존했고 소스/테스트는 수정하지 않았다.
- 종합 판정: **통과**

## 판정 요약

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| retry 버튼의 충돌 class 제거 | 통과 | `src/panels/Models.tsx:411`의 retry 버튼은 `app-bg-danger-strong`만 사용하며 `bg-red-900`이 없다. |
| retry 배경의 dark/light production CSS | 통과 | `src/styles/app-tokens.css:42,99`의 dark/light 토큰과 `src/styles/app-panels.css:357`의 class rule이 production CSS에 함께 생성됐다. |
| 두 action 버튼의 unsupported hover variant 제거 | 통과 | `src/panels/Models.tsx:388,454`는 `app-hover-accent-solid`를 사용하고 `hover:app-bg-accent-solid`는 없다. |
| action hover의 dark/light production CSS | 통과 | `src/styles/app-panels.css:353-354`의 `:hover:not(:disabled)` 규칙과 theme별 색상 변수가 production CSS에 존재한다. |
| 신규 회귀 테스트와 npm test 연결 | 통과 | `Models.css.test.tsx` 3개 테스트와 `test-models-css` script가 실행됐고, `package.json:33-34`에서 전체 `npm test` chain에 포함된다. |
| npm 게이트 | 통과 | typecheck, lint, test, build 모두 exit 0이다. |

## 1. Retry 버튼 및 danger 배경

현재 `src/panels/Models.tsx:411`은 다음 class를 사용한다.

```text
mt-2 block rounded px-2 py-1 text-xs app-bg-danger-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300
```

따라서 이전에 지적된 `bg-red-900 app-bg-danger-strong` 동시 사용은 제거됐다. `bg-red-900` utility 자체는 다른 화면 사용을 위해 build CSS에 남아 있지만(offset 59,896), retry element의 class에는 포함되지 않는다.

`src/styles/app-tokens.css`에는 다음 theme별 토큰이 있다.

- dark (`:root[data-theme="dark"]`, `:42`): `--board-bg-danger-strong: #96544a`
- light (`:root[data-theme="light"]`, `:99`): `--board-bg-danger-strong: #c76657`

`src/styles/app-panels.css:357`의 `.app-bg-danger-strong { background-color: var(--board-bg-danger-strong); }`도 확인했다. `npm run build`가 생성한 `dist/assets/index-BkeBCaAa.css:1`에서 dark/light 토큰과 동일 rule을 확인했다.

| production CSS marker | offset |
| --- | ---: |
| `--board-bg-danger-strong: #96544a` | 922 |
| `--board-bg-danger-strong: #c76657` | 2,331 |
| `.app-bg-danger-strong{background-color:var(--board-bg-danger-strong)}` | 34,059 |

즉 retry 버튼은 양 theme에서 정의된 변수로 해석되는 단일 app class를 사용하며, 이전 Tailwind background utility와의 same-specificity 충돌이 없다.

## 2. 두 action 버튼 및 hover 배경

두 대상 버튼은 다음과 같이 확인됐다.

- LoRA add 버튼: `src/panels/Models.tsx:388`
- model row start/switch 버튼: `src/panels/Models.tsx:454`

두 버튼 모두 `bg-indigo-600 ... app-hover-accent-solid`를 사용한다. `Models.tsx`에는 unsupported `hover:app-bg-accent-solid`가 0건이고, `app-hover-accent-solid` 사용은 정확히 2건이다.

`src/styles/app-panels.css:353-354`에는 다음 규칙이 있다.

```css
.app-hover-accent-solid:hover:not(:disabled) { background-color: var(--board-accent-solid); }
:root[data-theme="light"] .app-hover-accent-solid:hover:not(:disabled) { background-color: var(--board-accent); }
```

production CSS `dist/assets/index-BkeBCaAa.css:1`에도 두 규칙이 생성됐다.

| production CSS marker | offset | resolved theme value |
| --- | ---: | --- |
| `.app-hover-accent-solid:hover:not(:disabled){background-color:var(--board-accent-solid)}` | 33,745 | dark `--board-accent-solid: #96662c` |
| `:root[data-theme=light] .app-hover-accent-solid:hover:not(:disabled){background-color:var(--board-accent)}` | 33,833 | light `--board-accent: #8d5516` |

unsupported selector `hover\:app-bg-accent-solid`는 production CSS에 생성되지 않았다. 기본 `.bg-indigo-600` rule은 offset 58,693으로 더 뒤에 있지만, hover rule은 `:hover:not(:disabled)`로 specificity가 더 높으므로 두 action 버튼의 enabled hover에서 app 색상이 적용된다.

## 3. 회귀 테스트 및 npm chain

`src/panels/Models.css.test.tsx:78-115`는 실제 `ModelsPanel`을 render하고 다음을 검증한다.

- scan error retry button에 `app-bg-danger-strong`가 있고 `bg-red-900`가 없음
- LoRA add button에 `bg-indigo-600`과 `app-hover-accent-solid`가 있고 unsupported variant가 없음
- model row start button도 동일한 explicit hover class를 사용함

`scripts/test-models-css.ts:11-37`는 source-level CSS 회귀를 추가로 검증한다.

- retry button class의 `bg-red-900` 부재 및 `app-bg-danger-strong` 존재
- Models.tsx의 unsupported `hover:app-bg-accent-solid` 부재
- `app-hover-accent-solid` 사용 수가 두 action button에 맞게 2건인지 확인
- `app-panels.css`의 dark/light `:hover:not(:disabled)` rule을 exact match

이 두 테스트는 build CSS의 computed style을 직접 계산하지는 않지만, 이번 검수에서는 production build 산출물까지 별도로 확인해 source rule과 실제 bundle 생성을 교차 검증했다. `npm run test:models-css` 단독 실행은 다음 메시지와 함께 통과했다.

```text
Models.tsx CSS cascade regressions (retry background, action hover rules) passed
```

`npm run test:ui -- --reporter=verbose`에서도 `Models.css.test.tsx`의 3개 테스트가 모두 발견·통과했다. 전체 결과는 18 test files / 84 tests passed다.

`package.json:33`에 `test:models-css` script가 있고, `package.json:34`의 `test` chain은 `npm run test:models-css && npm run test:ui` 순서로 이를 포함한다.

## 4. 직접 실행한 npm 게이트

| 명령 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과, exit 0 |
| `npm run lint` | 통과, exit 0 |
| `npm test` | 통과, direct scripts 및 Vitest 18 files / 84 tests |
| `npm run build` | 통과, Vite 7.3.6 / 120 modules transformed / CSS 76.68 kB |

`npm test` 중 jsdom의 `HTMLCanvasElement.getContext()` 미구현 안내 2건이 출력됐지만 실패가 아니며 명령은 exit 0으로 종료했다.

## 최종 결론 및 잔여 이슈

Models.tsx의 retry background 충돌과 unsupported hover variant라는 Codex 10차 잔여 2건은 모두 해결됐다. source class, source CSS rule, theme token, production CSS 산출물, 신규 테스트 및 npm chain을 모두 확인했고 blocking issue 없이 최종 **통과** 판정한다.

남은 위험은 신규 테스트가 jsdom에서 class 존재를 검증하고 static script가 source CSS를 검증하는 형태라 실제 브라우저의 computed hover 색상을 직접 자동화하지 않는다는 점이다. 다만 이번 build의 production CSS에서 두 theme의 token/rule을 직접 확인했으므로 이번 cascade sign-off를 막지는 않는다.
