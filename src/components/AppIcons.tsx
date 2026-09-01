import type { ReactNode } from "react";

/**
 * Navigation icons — 1.5px stroke, 20px grid, currentColor.
 * Refined for technical instrument aesthetic: quieter, more precise.
 */

function Base({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ChatIcon() {
  return (
    <Base>
      <path d="M4.2 5.6a1.8 1.8 0 0 1 1.8-1.8h8a1.8 1.8 0 0 1 1.8 1.8v5.8a1.8 1.8 0 0 1-1.8 1.8H8.6l-2.8 2.2v-2.6A1.8 1.8 0 0 1 4.2 11V5.6Z" />
      <path d="M7 7.3h6M7 10h3.5" strokeWidth="1.3" />
    </Base>
  );
}

export function ModelsIcon() {
  return (
    <Base>
      <ellipse cx="10" cy="5" rx="5.8" ry="1.9" />
      <path d="M4.2 5v8.8c0 1.05 2.6 1.9 5.8 1.9s5.8-.85 5.8-1.9V5" />
      <path d="M4.2 9.4c0 1.05 2.6 1.9 5.8 1.9s5.8-.85 5.8-1.9" />
    </Base>
  );
}

export function DeveloperIcon() {
  return (
    <Base>
      <rect x="3" y="4" width="14" height="12" rx="1.6" />
      <path d="M6.2 8.2 8.4 10 6.2 11.8" />
      <path d="M10.2 12.2h3" />
    </Base>
  );
}

export function SettingsIcon() {
  return (
    <Base>
      <path d="M8.5 2.8h3l.45 1.8a5.8 5.8 0 0 1 1.55.9l1.75-.75 2.1 2.1-.75 1.75c.38.48.68 1 .9 1.55l1.8.45v3l-1.8.45a5.8 5.8 0 0 1-.9 1.55l.75 1.75-2.1 2.1-1.75-.75a5.8 5.8 0 0 1-1.55.9l-.45 1.8h-3l-.45-1.8a5.8 5.8 0 0 1-1.55-.9l-1.75.75-2.1-2.1.75-1.75a5.8 5.8 0 0 1-.9-1.55l-1.8-.45v-3l1.8-.45c.22-.55.52-1.07.9-1.55l-.75-1.75 2.1-2.1 1.75.75a5.8 5.8 0 0 1 1.55-.9l.45-1.8Z" />
      <circle cx="10" cy="10" r="2.45" />
    </Base>
  );
}

export function TuningIcon() {
  return (
    <Base>
      <path d="M4 4v12M10 2.8v14.4M16 4v12" />
      <circle cx="4" cy="8" r="1.6" fill="currentColor" stroke="none" opacity="0.95" />
      <circle cx="10" cy="12" r="1.6" fill="currentColor" stroke="none" opacity="0.95" />
      <circle cx="16" cy="7" r="1.6" fill="currentColor" stroke="none" opacity="0.95" />
      <circle cx="4" cy="8" r="1.6" />
      <circle cx="10" cy="12" r="1.6" />
      <circle cx="16" cy="7" r="1.6" />
    </Base>
  );
}

/** Minimal wordmark — refined LB monogram */
export function BoardMark() {
  return (
    <span
      aria-hidden="true"
      style={{
        fontSize: "10px",
        fontWeight: 800,
        letterSpacing: "-0.04em",
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      LB
    </span>
  );
}
