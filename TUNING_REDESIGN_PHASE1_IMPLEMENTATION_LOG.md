# Tuning redesign phase 1 — implementation log

- Date: 2026-09-01 (Asia/Seoul)
- Scope: `tuningFields`/`tuningValidation` contracts, the Tooltip and category
  metadata model, the Tuning left rail/search/Quick–Advanced shell, and the
  inventory P0/P1 fixes.
- Cross-review target: Claude (the line references below are from the final
  working tree after the focused tests were run).

## Decisions and boundaries

1. `AppConfig` already contains the phase-1 dedicated fields (`ngl`,
   `ctx_size`, `parallel`, timeout/idle, speculative, reasoning, `mmproj`,
   `server_args`, and `chat_options`) in `src/api.ts:31-68`, with the matching
   Rust schema in `src-tauri/src/config.rs:99-161`. Per the coordinator's
   phase boundary, this dispatch does not add new persisted batch/KV/context
   fields; future/unknown llama.cpp options remain available through the two
   existing escape hatches.
2. The catalog is UI metadata layered over the existing flat config. It does
   not alter serialization or migration. Each field now carries a stable
   category, tooltip payload, optional upstream aliases, optional request key,
   and an `advancedOnly` marker.
3. Quick mode keeps the common runtime/context/sampling/reasoning surface. The
   Advanced tab exposes speculative, multimodal, raw escape-hatch categories,
   speculative/mmproj controls, and advanced sampling controls. Category
   selection still renders the existing section component in this first
   skeleton; true per-field slicing can be added in phase 2 without changing
   the navigation contract.
4. `--cont-batching` and Web UI flags are intentionally *not* in the blocked
   app-managed set. `server.rs` recognizes all of their aliases before adding
   its default flags, so the raw escape hatch can safely override those
   defaults. The existing regression test
   `advanced_args_allow_cont_batching_and_webui_overrides` is preserved and
   passes. Other dedicated-control aliases are blocked in both TypeScript and
   Rust.

## Implementation map

| File and lines | Change / responsibility |
| --- | --- |
| `src/panels/tuningFields.ts:14-74` | `TuningCategoryId`, view/section IDs, `TuningTooltip`, category metadata, and field metadata types. |
| `src/panels/tuningFields.ts:81-141` | Seven stable categories (`runtime`, `context`, `sampling`, `reasoning`, `speculative`, `multimodal`, `advanced`) with mode visibility, descriptions, and search keywords. |
| `src/panels/tuningFields.ts:143-212` | Existing server/speculative/reasoning/sampling fields enriched with category/tooltips/aliases; Mirostat fields retain `mirostat_lr`/`mirostat_ent` UI keys and declare request keys `mirostat_eta`/`mirostat_tau`. |
| `src/panels/tuningFields.ts:197-234` | `SERVER_TEXT_FIELDS` and flattened `TUNING_FIELD_CATALOG` for non-numeric controls and search. |
| `src/panels/tuningFields.ts:236-246` | Category lookup and search matching across key, request key, label, tooltip, aliases, and category keywords. |
| `src/panels/tuningValidation.ts:52-119` | Central TS app-managed CLI alias map, flattened block set, canonical option lookup, and P0 request alias map. The map includes `-fa`, `--gpu-layers`, `-np`, `-to`, LoRA, reasoning, and speculative draft aliases including `-devd`/`--device-draft` and `-md`/`--model-draft`. |
| `src/panels/tuningValidation.ts:121-166` | `mapChatOptionAliases` (explicit canonical request keys win; UI aliases are removed), whitespace-tolerant option parsing, and alias-aware raw server-arg rejection. |
| `src/api.ts:31-68` | Existing `AppConfig` contract is intentionally retained; no phase-2 persisted fields were introduced. |
| `src/api.ts:565-594` | OpenAI-compatible body now normalizes `chat_options` before spreading and reasoning kwargs are read from the normalized object. |
| `src/endpointAdapters.ts:299-324` | Native `/api/v1/chat` body receives the same Mirostat normalization. The Anthropic adapter remains its existing explicit subset contract. |
| `src/components/Tooltip.tsx:1-38` | CSS-only, keyboard-focusable tooltip with accessible help button and `role=tooltip`; payload accepts the shared metadata shape or a string. |
| `src/panels/NumericFieldGrid.tsx:24-49` | Numeric dedicated controls display metadata tooltips next to labels. |
| `src/panels/TuningChatOptionField.tsx:31-101` | Advanced chat-option controls display metadata tooltips. |
| `src/panels/TuningServerSection.tsx:25-103` | Adds `showAdvanced`; Quick hides mmproj/speculative nested controls while retaining common server controls. |
| `src/panels/TuningSpeculativeSection.tsx:26-154` | Draft type/NGL/device/model controls use catalog tooltip metadata. |
| `src/panels/TuningReasoningSection.tsx:29-143` | Reasoning controls receive tooltip affordances. |
| `src/panels/TuningSamplingSection.tsx:20-59` | Adds `showAdvanced`; the advanced sampling details are omitted in Quick. |
| `src/panels/TuningNavigation.tsx:28-113` | Controlled left rail: Quick/Advanced tabs, search input/clear button, category buttons, active state, and empty state. Icons are inline SVG. |
| `src/panels/Tuning.tsx:20-52` | Section-to-category mapping and catalog-backed category/search filtering. |
| `src/panels/Tuning.tsx:79-216` | Existing controller wiring is retained inside the new shell; category heading, navigation, mode state, and responsive content viewport are added. |
| `src/styles/app-layout.css:76-252` | Desktop tuning rail/header/content grid, active states, search, category heading, and contained scroll viewport. |
| `src/styles/app-responsive.css:67-98` | Small-screen layout collapses the rail into a mode/search row plus horizontal category strip. |
| `src/styles/app-components.css:342-400` | Shared tooltip visual/focus styles using board tokens. |
| `src-tauri/src/config.rs:14-80` | Rust alias block list kept in sync with TS for dedicated app-managed controls. |
| `src-tauri/src/config.rs:378-398` | Trimmed option-name extraction and alias-aware validation. |
| `src-tauri/src/config.rs:716-790` | Regression coverage for blocked aliases and the intentionally allowed cont-batching/Web UI overrides. |
| `src-tauri/src/server.rs:375-388` | `has_flag` recognizes all cont-batching/Web UI aliases so defaults are not duplicated. |
| `src-tauri/src/server.rs:1020-1035` | Builder alias de-duplication test. |
| `scripts/test-tuning-validation.ts:30-51` | TS alias canonicalization, trim handling, P0 mapping, canonical precedence, and parser coverage. |
| `scripts/test-chat-stream.ts:99-111` | OpenAI body smoke assertion for `mirostat_lr/ent` → `mirostat_eta/tau`. |
| `src/panels/TuningNavigation.test.tsx:6-60` | Navigation tabs, category selection, controlled search/clear, and empty state tests. |
| `src/panels/Tuning.test.tsx:68-84` | Tuning shell Quick default, Advanced transition, speculative navigation, and tooltip presence test. |

## P0 request mapping

The UI/profile keys remain discoverable as `mirostat_lr` and `mirostat_ent`,
matching the llama.cpp CLI terminology and existing saved profiles. Immediately
before request construction, `mapChatOptionAliases` performs a shallow copy:

```text
mirostat_lr  -> mirostat_eta
mirostat_ent -> mirostat_tau
```

If both spellings are present, the explicit request-schema key wins; the alias
is then deleted in all cases. Thus the outgoing OpenAI and Native bodies carry
one unambiguous key and unrelated values (for example `seed` and
`chat_template_kwargs`) are preserved. `scripts/test-chat-stream.ts:99-111`
and `scripts/test-tuning-validation.ts:41-51` cover both mapping and
precedence.

## P1 collision policy

`src/panels/tuningValidation.ts:52-90` and
`src-tauri/src/config.rs:19-80` contain the same reserved names. The blocked
groups are:

| Dedicated control | Blocked aliases |
| --- | --- |
| model/port/API key/projector | `--model`, `-m`; `--port`, `-p`; API-key/no-key forms; mmproj local/url/auto forms |
| GPU/context/runtime | `--n-gpu-layers`, `--gpu-layers`, `-ngl`; `--ctx-size`, `-c`; `--flash-attn`, `-fa`; MoE/threads; `--parallel`, `-np`; `--timeout`, `-to`; idle sleep |
| LoRA | `--lora`, `--lora-scaled` |
| speculative draft | canonical spec flags, `--draft-p-min`, `--draft-p-split`, `--gpu-layers-draft`, `--n-gpu-layers-draft`, `-devd`, `--device-draft`, `-md`, `--model-draft` |
| reasoning | `--reasoning`, `-rea`, reasoning format/effort/budget/message/preserve forms |

The parser canonicalizes the option portion of both `--flag=value` and
standalone raw lines, including surrounding whitespace. Unknown options remain
valid escape-hatch values. Cont-batching/Web UI forms are handled by the
builder instead of being blocked: `--cont-batching`, `-cb`,
`--no-cont-batching`, `-nocb`, `--webui`, `--ui`, `--no-webui`, and `--no-ui`.

## Verification record

All commands below completed successfully in the final working tree:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run test:tuning`
- `npm run test:advanced-settings`
- `npm run test:chat-stream`
- `npm run test:endpoint-adapters`
- `npm run test:ui -- src/panels/Tuning.test.tsx src/panels/TuningNavigation.test.tsx` (2 files, 3 tests)
- `npm run test:ui` (20 files, 87 tests)
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml advanced_args_cannot_override_dedicated_settings`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml advanced_args_allow_cont_batching_and_webui_overrides`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml build_args_recognizes_cont_batching_and_webui_aliases`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` (174 library tests passed, 1 intentionally ignored; CLI/fake-server integration tests passed)

The Rust test binary emitted only the existing linker stdout warning; all
focused tests passed. `LLAMA_CPP_OPTIONS_INVENTORY.md` was left untouched as an
existing untracked inventory artifact; this log is the implementation-specific
cross-review artifact.

## Follow-up boundary for phase 2

- Add typed S2–S6 batch/KV/rope/device controls only with explicit migration
  and effective-value semantics; do not silently invent persisted keys.
- Replace section-wide rendering with field-level category filtering (the
  phase-1 navigation contract is ready for this).
- Localize static navigation/category copy and enrich tooltip content from the
  localized catalog.
- Reconcile aliases against each installed `llama-server --help`, since a
  static upstream inventory can drift across builds.
- Add route-specific request-schema validation for arbitrary `chat_options`.
