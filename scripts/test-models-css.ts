import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// P0-1 follow-up (docs/review-codex-10.md P1 items): two Models.tsx cascade
// regressions where a Tailwind utility silently lost to (or never generated
// a rule to compete with) a hand-written `app-*` class on the same element.

const modelsTsx = readFileSync(new URL("../src/panels/Models.tsx", import.meta.url), "utf8");
const appPanelsCss = readFileSync(new URL("../src/styles/app-panels.css", import.meta.url), "utf8");

const retryButtonMatch = modelsTsx.match(/onClick=\{\(\) => void scan\(\)\} className="([^"]*)">\{t\("panel\.retry"\)\}/);
assert.ok(retryButtonMatch, "could not locate the retry button in Models.tsx");
const retryClassName = retryButtonMatch[1];
assert.ok(
  !/\bbg-red-900\b/.test(retryClassName),
  "Models.tsx retry button should not pair Tailwind's bg-red-900 with app-bg-danger-strong (same-specificity cascade lets bg-red-900 win)",
);
assert.ok(
  retryClassName.includes("app-bg-danger-strong"),
  "Models.tsx retry button should keep the app-bg-danger-strong class",
);

assert.ok(
  !modelsTsx.includes("hover:app-bg-accent-solid"),
  "Models.tsx should not use hover:app-bg-accent-solid — Tailwind never generates a rule for a variant of a custom class",
);
const hoverUsages = modelsTsx.match(/app-hover-accent-solid/g) ?? [];
assert.equal(hoverUsages.length, 2, "expected both action buttons (LoRA add, model row start) to use app-hover-accent-solid");

assert.ok(
  appPanelsCss.includes(".app-hover-accent-solid:hover:not(:disabled) { background-color: var(--board-accent-solid); }"),
  "app-panels.css is missing the dark-theme app-hover-accent-solid rule",
);
assert.ok(
  appPanelsCss.includes(':root[data-theme="light"] .app-hover-accent-solid:hover:not(:disabled) { background-color: var(--board-accent); }'),
  "app-panels.css is missing the light-theme app-hover-accent-solid rule",
);

console.log("Models.tsx CSS cascade regressions (retry background, action hover rules) passed");
