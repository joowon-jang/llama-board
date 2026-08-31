import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Refined design: Models.tsx now uses semantic app-button variants instead of
// hand-rolled Tailwind bg utilities. Verify the cascade regressions stay fixed
// under the new single-accent system.

const modelsTsx = readFileSync(new URL("../src/panels/Models.tsx", import.meta.url), "utf8");
const appPanelsCss = readFileSync(new URL("../src/styles/app-panels.css", import.meta.url), "utf8");
const indexCss = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const appComponentsCss = readFileSync(new URL("../src/styles/app-components.css", import.meta.url), "utf8");
const appResponsiveCss = readFileSync(new URL("../src/styles/app-responsive.css", import.meta.url), "utf8");

const retryButtonMatch = modelsTsx.match(/onClick=\{\(\) => void scan\(\)\} className="([^"]*)">\{t\("panel\.retry"\)\}/);
assert.ok(retryButtonMatch, "could not locate the retry button in Models.tsx");
const retryClassName = retryButtonMatch[1];
assert.ok(
  !/\bbg-red-900\b/.test(retryClassName),
  "Models.tsx retry button should not pair Tailwind's bg-red-900 with app-* classes",
);
assert.ok(
  retryClassName.includes("app-button"),
  "Models.tsx retry button should use the shared app-button variant",
);

assert.ok(
  !modelsTsx.includes("hover:app-bg-accent-solid"),
  "Models.tsx should not use hover:app-bg-accent-solid — Tailwind never generates a rule for a variant of a custom class",
);
// New design uses app-button--primary (which already handles hover via CSS).
assert.ok(
  modelsTsx.includes("app-button--primary"),
  "Models.tsx should use app-button--primary for primary actions",
);

// Legacy app-hover class is no longer required; ensure the panels CSS still
// provides a consistent hover token via the component system rather than a
// per-element utility.
assert.ok(
  !appPanelsCss.includes("hover:app-bg-accent-solid"),
  "app-panels.css should not contain literal hover:app-* strings",
);

// Shared theme and layout rules must keep the responsive utility overrides and
// light-mode semantic colors intact as the design system evolves.
assert.match(indexCss, /--color-amber-950:\s*var\(--tone-warning-bg\)/);
assert.match(indexCss, /--color-emerald-950:\s*var\(--tone-success-bg\)/);
assert.match(indexCss, /--color-red-950:\s*var\(--tone-error-bg\)/);
assert.match(appComponentsCss, /@layer components\s*\{\s*\.app-input\s*\{/);
assert.match(appResponsiveCss, /grid-template-rows:\s*48px minmax\(0, 1fr\)/);
assert.match(appResponsiveCss, /padding:\s*5px 8px/);

console.log("Models.tsx and shared CSS cascade regressions passed");
