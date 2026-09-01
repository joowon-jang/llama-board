# Tuning redesign phase 2 — cross-validation log (Claude)

- Date: 2026-09-01 (Asia/Seoul)
- Scope requested by coordinator: cross-check codex's phase-2 output against
  LMStudio/oMLX slider & sampler-order visual patterns, verify
  `TuningNavigation` a11y (`aria-controls`/`tabpanel` + roving tabindex +
  arrow keys), verify effective-value/migration semantics when S2–S6 typed
  controls are added, and check i18n catalog consistency.
- Baseline reviewed: the phase-1 working tree already in this repo (see
  `TUNING_REDESIGN_PHASE1_IMPLEMENTATION_LOG.md`). No phase-2 S2–S6 diff had
  arrived from codex at review time, so items below split into **fixed now**
  (self-contained, in the existing phase-1 surface) and **guidance for the
  pending S2–S6 diff**.

## 1. Accessibility — fixed

`src/panels/TuningNavigation.tsx` declared `role="tablist"`/`role="tab"` for
the Quick/Advanced mode switch (old lines 44–63) but implemented none of the
WAI-ARIA Tabs pattern beyond the role/aria-selected pair: no `aria-controls`,
no matching `role="tabpanel"`, no roving tabindex, no arrow-key handling —
every tab was independently `Tab`-focusable and only mouse-operable. The
category list (old lines 90–108) had the same gap: no keyboard navigation at
all, despite behaving as a single-selection vertical list.

Fixed in this pass:

- `src/panels/TuningNavigation.tsx:49-96` — mode tabs now use roving
  `tabIndex` (0 on the active tab, -1 otherwise), `id="tuning-mode-tab-${value}"`,
  `aria-controls={TUNING_CONTENT_PANEL_ID}`, and `onKeyDown` handling
  `ArrowLeft`/`ArrowRight`/`Home`/`End` (wraparound, moves focus + activates —
  matches the "automatic activation" tabs pattern).
- `src/panels/TuningNavigation.tsx:126-146` — category buttons get the same
  roving-tabindex treatment with `ArrowUp`/`ArrowDown`/`Home`/`End`, plus
  `aria-controls={TUNING_CONTENT_PANEL_ID}`. Kept `aria-current="page"`
  (unchanged) instead of forcing `role="tab"` onto it — it's a nav landmark,
  not a second tablist, so re-using the tabs pattern verbatim would have been
  a semantics mismatch.
- `src/panels/Tuning.tsx:190-196` — the content region now carries
  `id={TUNING_CONTENT_PANEL_ID}` (new export, `tuningFields.ts:27-28`),
  `role="tabpanel"`, `aria-labelledby={`tuning-mode-tab-${mode}`}`, closing the
  loop the mode tablist needs. (Category buttons also point `aria-controls`
  at the same id, which is valid per spec even though they aren't `role=tab`.)
- Test coverage added: `src/panels/TuningNavigation.test.tsx` now wraps every
  render in `I18nProvider` (required once the component calls `useI18n`) and
  adds two new cases asserting `tabindex` roving state and that
  `ArrowRight`/`ArrowDown` invoke `onModeChange`/`onSelectCategory`.

Verified: `npm run typecheck`, `npm run lint`, `npm run build`,
`npx vitest run src/panels/Tuning.test.tsx src/panels/TuningNavigation.test.tsx`
(5/5), `npm run test:ui` (20 files / 89 tests, all green — was 87 before this
pass).

## 2. i18n catalog consistency — fixed for the nav shell, gap flagged for field data

`TuningNavigation.tsx` had **zero** `useI18n`/`t()` calls even though the rest
of the Tuning surface is localized (`NumericFieldGrid.tsx:16`,
`TuningChatOptionField.tsx`, `Tuning.tsx` itself). Every string — "Quick",
"Advanced", "Search settings", "Clear tuning search", "Categories", "No
matching settings.", all four `aria-label`s — was hardcoded English, so ko/ja/zh
users got an English-only rail inside an otherwise-localized panel.
`Tuning.tsx:175` (subtitle) and the old `Tuning.tsx:213` empty-search message
had the same gap.

Fixed: added 12 new `extra.*` keys (`quickMode`, `advancedMode`,
`tuningNavigationLabel`, `tuningDetailLevel`, `searchTuningSettingsLabel`,
`searchSettingsPlaceholder`, `clearTuningSearch`, `categories`,
`tuningCategoriesLabel`, `noMatchingSettings`, `noSettingsMatchQuery`,
`tuningSubtitle`) in `src/extraI18n.ts:10-16` (type union) with explicit `en`
and `ko` values (`src/extraI18n.ts:29-30` / `39-40`); `ja`/`zh` inherit via
the existing `...en` spread convention already used for partially-translated
`extra.*` keys, so `assertExtraCatalogComplete()` still passes (it does —
confirmed via the full `test:ui` run above, since that assert throws at
import time on any gap). Wired both files to `t()` throughout.

**Not fixed — flagged as a known, larger gap for whoever owns S2–S6 copy:**
`src/panels/tuningFields.ts:81-213` (`TUNING_CATEGORIES` labels/descriptions,
every `NumericField`/`ChatOptionField`/`ServerTextField` `label`/`hint`/
`tooltip.title`/`tooltip.description`) is entirely hardcoded English baked
into the catalog's data structure — not routed through `i18nUnified` at all.
This is already called out as deferred work in
`TUNING_REDESIGN_PHASE1_IMPLEMENTATION_LOG.md:142` ("Localize static
navigation/category copy and enrich tooltip content from the localized
catalog"), so I left it alone rather than doing an unscoped ~50-entry ×
4-locale rewrite. **Guidance for the S2–S6 diff:** any new field metadata
codex adds should go straight into the `extra.*`/`panel.*` catalogs (key per
field, `t()`'d from the field definition or from the section component) —
not more hardcoded label/hint/tooltip strings that need retrofitting later
the same way this nav shell just did.

## 3. LMStudio/oMLX slider & sampler-order pattern — gap flagged, not implemented

`src/panels/NumericFieldGrid.tsx:34-47` renders every dedicated numeric
control — including `ngl` (GPU layers, the primary offload knob) — as a plain
`<input type="text">` with a static hint string underneath
(`tuningFields.ts:144`, e.g. "0–128. 0 keeps inference on CPU."). There is no
slider element, no 0–100%/0–max filled track, no live value readout tied to a
drag handle. LM Studio's GPU Offload control and MLX-family front-ends both
anchor this exact field to a horizontal slider with a percentage-filled
track; that visual affordance doesn't exist anywhere in this panel today.
`TuningSamplingSection.tsx`'s temperature/top_p/top_k controls use the same
flat-text-input pattern (via the same `NumericFieldGrid`), and the advanced
sampling controls (`tuningFields.ts:170-195`, `ADVANCED_SAMPLING_FIELDS`) have
no drag-reorderable sampler-chain visualization — the upstream request's
actual chain-order field, `samplers`
(`LLAMA_CPP_OPTIONS_INVENTORY.md:288`), isn't exposed as a control at all.

This is a visual-design-scale change (slider component + track/fill styling +
possibly a reorderable chip list for `samplers`), not a scoped bug fix, so I
did not implement it — flagging it as an open gap against the named reference
apps for whoever is driving the phase-2 visual design (codex or a follow-up
design pass), rather than making an unrequested UI redesign call myself.

## 4. Effective-value / migration semantics for S2–S6 — guidance (no S2–S6 diff to review yet)

The existing migration pattern in `src-tauri/src/config.rs` is the contract
any new typed field must follow:

- `config.rs:8` — `CURRENT_CONFIG_VERSION: u32 = 7`. A new persisted field
  requires bumping this and adding a new arm to the `match cfg.config_version`
  block (`config.rs:448-469`).
- `config.rs:420-422` (`field_missing`) + `config.rs:434-447` — presence is
  checked against the **raw pre-deserialization JSON**, not the
  already-serde-defaulted struct. This is the load-bearing detail: serde's
  `#[serde(default)]` alone cannot distinguish "field absent because the
  config predates it" from "field present and the user explicitly set it to
  0/empty" — and for llama.cpp options, 0/empty is very often a legitimate
  explicit value (e.g. `n_cpu_moe=0`, `threads=0`). Any S2–S6 field
  (batch_size, ubatch_size, rope_*, kv/cache type, device, …) must use the
  same `field_missing(raw, "new_field")` + explicit documented-default
  backfill, not rely on struct defaults.
- No "effective value" display exists anywhere in the Tuning panel today —
  inputs show only the raw `AppConfig`/draft value. The project's own
  `LLAMA_CPP_OPTIONS_INVENTORY.md:784-786` (P1) already recommends showing the
  app's clamped/safe range next to upstream's wider allowed range (e.g. `ngl`
  only exposes a plain number while upstream also accepts `auto`/`all`;
  `ctx_size=0` — "use model metadata" — is unrepresentable; `top_k=0`,
  `top_p=0`, `temperature>2` are valid upstream but unreachable through the
  current UI clamp). There's precedent elsewhere in the app for surfacing a
  computed/effective value distinct from the configured one —
  `src/panels/Bench.tsx:222` (`t("panel.effectiveArgs")`, an expandable
  "effective llama-bench arguments" block) and
  `src/panels/Developer.tsx:120` (an `effective: {model}` status chip). S2–S6
  typed controls should reuse that established pattern rather than invent a
  new one, and should keep app-clamp vs. upstream-range explicit in the field
  metadata/tooltip rather than silently narrowing what upstream allows.
- Alias/collision parity: `src/panels/tuningValidation.ts:52-119` and
  `src-tauri/src/config.rs:14-80` are today kept in lockstep (TS and Rust
  reserved-alias lists) with matching regression tests
  (`advanced_args_cannot_override_dedicated_settings`,
  `advanced_args_allow_cont_batching_and_webui_overrides`,
  `build_args_recognizes_cont_batching_and_webui_aliases`). Any new dedicated
  S2–S6 control must extend **both** lists and get equivalent test coverage in
  both languages — this is already the tested convention, just flagging it as
  a checklist item for the incoming diff.

## 5. codex's S2/S6 diff — live review (batch_size, ubatch_size, keep, cache_type_k/v)

codex's diff started landing in the shared working tree mid-review (no
`send` arrived first; the files themselves changed under me). Reviewed as it
stood, file:line references below; codex was still actively editing several
of these files at review time, so a couple of items may already have moved on.

**CONFIRMED CRITICAL — fixed by me, regression test added:**
`src-tauri/src/config.rs` bumped `CURRENT_CONFIG_VERSION` from 7 to 8
(line 8) for the new fields, but the migration `match cfg.config_version`
block still read `2..=6 => {}` followed by a bare `CURRENT_CONFIG_VERSION => {}`
arm (old lines 632-633) — so `config_version == 7`, which is what **every
existing installed config.json has right now** (and what this repo's own
test fixtures use, e.g. `src/panels/Tuning.test.tsx:9`), matched neither arm
and fell into `_ => unreachable!("future config versions are rejected above")`,
panicking on load. Reproduced directly: reverted to `2..=6` and ran
`cargo test v7_config_migrates` → confirmed panic at the exact
`unreachable!()` call site. Fixed by widening the arm to `2..=7 => {}`
(`config.rs:632`) — no special-case backfill was needed for the new fields
since they use `#[serde(default = "default_batch_size")]`-style functions
that already resolve to the documented llama.cpp defaults (2048/512/0/"f16")
when the key is absent, unlike the raw-presence `field_missing()` pattern
needed for `spec_draft_n_max` etc. Added
`config::tests::v7_config_migrates_without_panicking_and_backfills_batch_defaults`
to lock this in.

**CONFIRMED — fixed by me:** `src-tauri/src/server.rs`'s
`build_args_binds_loopback_without_exposing_supplied_token` test put
`--batch-size 1024` in `cfg.server_args` as its "generic raw arg passes
through" example and asserted it appears in the built argv. Once
`--batch-size`/`-b` joined `APP_MANAGED_SERVER_ARGS` (correctly — see below),
`append_unmanaged_server_args` (`server.rs:408-429`) now strips it, so the
test failed for real (`cargo test` — 174 passed, 1 failed) exactly because
the *filtering is working as designed*; the test fixture was stale. Fixed by
dropping the now-invalid `--batch-size`/`1024` pair from the fixture and its
assertion, keeping `--jinja` as the still-valid unmanaged-passthrough proof.

**Good design, no action needed:** `migrate_server_args` (`config.rs:506-588`,
new) is a well-built answer to the exact alias-collision risk flagged in
§4/`LLAMA_CPP_OPTIONS_INVENTORY.md` P1 — on migration it walks old
`server_args`, and for any entry matching `APP_MANAGED_SERVER_ARGS` whose
dedicated field is `field_missing()` in the raw JSON, copies the raw value
into the new dedicated field before dropping the raw entry; TS
(`tuningValidation.ts:72-76`) and Rust (`config.rs:42-50`) alias lists were
both extended in lockstep for all five new options
(`--batch-size`/`-b`, `--ubatch-size`/`-ub`, `--keep`, `--cache-type-k`/`-ctk`,
`--cache-type-v`/`-ctv`), matching the existing convention exactly.

**CONFIRMED — the LMStudio/oMLX slider gap from §3 is now addressed:**
`src/panels/TuningSliderField.tsx` (new) pairs a native `input[type=range]`
with a numeric text box and wires into `NumericFieldGrid.tsx` for every
numeric field, including `ngl`. Good outcome. One a11y defect in the new
component: **`TuningSliderField.tsx:106-108`** sets both `aria-label={\`${resolvedLabel} slider\`}`
and `aria-labelledby={labelId}` on the range input. Per the ARIA
accessible-name computation order, `aria-labelledby` wins outright and
`aria-label` is completely ignored — so the intended "…slider" suffix that
distinguishes the range control from its paired number input (same
`aria-labelledby`, no `aria-label`) never reaches assistive tech; both
controls announce the identical name and are distinguished only by role.
Fix: drop `aria-labelledby` from the range input (keep `aria-label`), or
drop `aria-label` and instead point `aria-labelledby` at a node that already
contains "…slider" text.

**CONFIRMED type-safety/UI-completeness gap (self-resolving as codex works):**
`cache_type_k`/`cache_type_v` are full `ServerTextField` catalog entries with
`options: CACHE_TYPE_OPTIONS` (`tuningFields.ts:222-223`), persisted, sent in
argv (`server.rs:278-281`), and alias-blocked — but at first read had no
rendered control anywhere in `TuningServerSection.tsx`/`TuningSpeculativeSection.tsx`/
`TuningReasoningSection.tsx`/`TuningSamplingSection.tsx`, and
`SERVER_TEXT_LABEL_KEYS: Record<ServerTextKey, UiTextKey>`
(`tuningControllerHelpers.ts:31`) was missing both keys — the compiler
caught the same gap I found by grep. By the last read, `Tuning.tsx` had
gained a `showCacheTypes={categoryId === "context"}` prop into
`TuningServerSection`, i.e. codex is actively wiring this in — flagging for
awareness, not re-reporting as new.

**Currently red — `npm run typecheck` fails as of this snapshot** (three
errors, all inside files codex was actively editing, so likely transient):
- `src/modelProfiles.test.ts:5` — an `AppConfig` test fixture cast is missing
  the five new fields (other fixtures, e.g. `Tuning.test.tsx`, `Chat.test.tsx`,
  already have them — this one file was missed).
- `src/panels/tuningControllerHelpers.ts:76-77` — `TS1117`, the same object
  literal now defines `cache_type_k`/`cache_type_v` twice.
- `src/panels/tuningFields.ts:239` — `TUNING_FIELD_CATALOG`'s flattened
  `TuningFieldCatalogEntry.options` type was widened to `readonly string[]`
  for the new `cache_type_k`/`cache_type_v` `CACHE_TYPE_OPTIONS` entries, but
  the pre-existing `ChatOptionField.options` (used by `mirostat`,
  `ADVANCED_SAMPLING_FIELDS`) is `readonly { value: number; label: string }[]`
  — the two shapes now collide in the shared union. `TuningFieldCatalogEntry.options`
  needs to accept both shapes (e.g. `readonly string[] | readonly { value: number; label: string }[]`)
  rather than being narrowed to just `string[]`.

I did not fix these three — they're inside files codex was mid-edit on at
review time, so editing concurrently risked colliding with their next pass
rather than helping. Worth a fast follow-up check once codex signals done.

**`cargo test --locked` (full suite):** ran clean at 174/175 before my
server.rs fix (1 known failure, now fixed and unverified by a second full
run — a later full-suite re-run hit a transient
"애플리케이션 제어 정책에서 이 파일을 차단했습니다" (application-control-policy
block) on the freshly rebuilt test binary, most likely AV/policy contention
from codex's own concurrent `cargo build`/`test` in the same `target/`
directory, not a code issue. The specific fix was verified in isolation
(reverted → reproduced the exact panic → restored → targeted `config::` run
passed 9/9) before that lock appeared.

## 6. Follow-up pass — typecheck fixed green, sampler-chain gap closed by codex

A second pass after §5 found the tree had moved further:

- `tuningControllerHelpers.ts:76-77`'s duplicate `cache_type_k`/`cache_type_v`
  properties — codex fixed this themselves between my read and my edit
  attempt (edit rejected as stale, re-read showed it already gone).
- `src/modelProfiles.test.ts:5-13` and `scripts/test-project-store.ts:23-40`
  — two more `AppConfig` test/script fixtures missing the five new fields
  (same shape as the gap already fixed in other fixtures). Fixed by me:
  added `batch_size: 2048, ubatch_size: 512, keep: 0, cache_type_k: "f16",
  cache_type_v: "f16"` to both, matching the values already used in
  `Chat.test.tsx`/`Tuning.test.tsx`.
- `tuningFields.ts:234` (`TuningFieldCatalogEntry.options`) — fixed by me:
  widened `readonly string[]` to `readonly string[] | readonly { value: number; label: string }[]`
  so the flattened catalog union accepts both `ChatOptionField.options`
  (numeric, e.g. `mirostat`) and the new `ServerTextField.options`
  (string, `cache_type_k`/`cache_type_v`) shapes without collision.

`npm run typecheck` is now clean (0 errors). `npm run lint` is clean (0
errors; 1 pre-existing-pattern warning, see below). `npm run test:ui` is
89/89 green.

**New, and it closes out §3's slider/sampler-order finding:**
`src/panels/TuningSamplerChain.tsx` (new) is a full drag-and-drop +
keyboard-operable (arrow keys, move buttons) reorderable chip list for the
`samplers` chain, wired into `TuningSamplingSection.tsx:41`. Between this and
`TuningSliderField.tsx` (§5), both halves of the original LMStudio/oMLX
comparison gap (offload slider, sampler-order visualization) are now
implemented. Minor: `TuningSamplerChain.tsx:64-67`'s `useEffect` depends on
`[samplers, value]` but reads the derived `source` (line 59) inside the
effect body — `react-hooks/exhaustive-deps` warns on this. It's harmless in
practice (`source` is recomputed fresh from exactly those two deps every
render, so the effect already re-runs for the right reasons) — flagging as a
lint-hygiene nit, not a functional bug, not fixed.

**`cargo test --locked` (Rust):** could not get a clean full-suite run after
the fixes — every attempt after the first hit the same
"애플리케이션 제어 정책에서 이 파일을 차단했습니다" (application-control-policy)
block on the cached test binary at
`target\debug\deps\llama_board_lib-*.exe`, even after retries and even
though `cargo` reports "Finished ... in 0.3s" (i.e. not recompiling — same
binary, same block). This reads as an environment/AV policy issue in the
shared `target/` directory (plausibly triggered by codex's own concurrent
Rust builds), not a code regression: both of my Rust fixes were already
verified in isolation *before* this block appeared (migration panic:
reverted → reproduced the exact `unreachable!()` panic → restored → targeted
`config::` run passed 9/9; the `server.rs` fixture fix was covered by the
same full-suite run that first surfaced it, 174/175 → fix applied). Whoever
picks this up next should re-run `cargo test --locked` once the lock clears
to get a clean full-suite confirmation.

**Update:** the lock cleared on a later retry — `cargo test --locked` is now
confirmed clean: 175 passed, 0 failed, 1 ignored (the pre-existing ignored
test; unrelated), including the new
`v7_config_migrates_without_panicking_and_backfills_batch_defaults`
regression test.

**Final check** (after codex expanded further into `bench.rs`,
`executionProfileFields.ts`, `storeConfig.ts`, `modelProfiles.ts`,
`ExecutionProfiles.tsx`): `npm run typecheck` clean, `npm run lint` clean
(same 1 pre-existing warning), `npm run test:ui` 89/89, `cargo test --locked`
176/0/1-ignored. Two consecutive 5-minute waits for a codex/coordinator
`send` returned nothing, so closing this dispatch out here with the tree in
a fully green state; see §5–6 for what's still open (small, scoped items,
none blocking).

## 7. Status

Fixed and verified: TuningNavigation a11y + i18n (§1–2), config.rs v7
migration panic + regression test (§5), stale server.rs test fixture (§5),
and all four typecheck errors across two passes (§5–6) — `npm run
typecheck`/`lint`/`test:ui` are green as of this log. Flagged, not fixed
(small, scoped, safe to pick up next): the tuning-field-data i18n gap (§2),
`TuningSliderField.tsx:106-108`'s dead `aria-label` (§5), and the
`TuningSamplerChain.tsx` exhaustive-deps lint nit (§6). Outstanding: a clean
`cargo test --locked` full-suite run once the local AV/build lock clears.
