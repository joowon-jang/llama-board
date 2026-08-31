import type { ReactNode } from "react";

/**
 * Navigation icons for the left rail. One consistent 1.75px stroke weight,
 * 20px grid, currentColor — they inherit the rail's active/hover colours.
 */

function Base({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
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
      <path d="M3.5 5.75a2.25 2.25 0 0 1 2.25-2.25h8.5a2.25 2.25 0 0 1 2.25 2.25v6.5a2.25 2.25 0 0 1-2.25 2.25H8.9l-3.35 2.7a.55.55 0 0 1-.9-.43v-2.34a2.25 2.25 0 0 1-1.15-1.98v-6.7Z" />
      <path d="M6.75 7.25h6.5M6.75 10h4" />
    </Base>
  );
}

export function ModelsIcon() {
  return (
    <Base>
      <ellipse cx="10" cy="4.75" rx="6.25" ry="2.25" />
      <path d="M3.75 4.75v10.5c0 1.24 2.79 2.25 6.25 2.25s6.25-1.01 6.25-2.25V4.75" />
      <path d="M3.75 10c0 1.24 2.79 2.25 6.25 2.25s6.25-1.01 6.25-2.25" />
    </Base>
  );
}

export function DeveloperIcon() {
  return (
    <Base>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
      <path d="M6.25 8.25l2.5 1.9-2.5 1.9" />
      <path d="M10.75 12.4h3.25" />
    </Base>
  );
}

export function SettingsIcon() {
  return (
    <Base>
      <path d="M3.25 6.75h13.5M3.25 13.25h13.5" />
      <circle cx="7.75" cy="6.75" r="1.9" />
      <circle cx="12.75" cy="13.25" r="1.9" />
    </Base>
  );
}

/** Stacked slabs — the app's board mark. */
export function BoardMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="4" y="3.2" width="16" height="4.1" rx="1.3" opacity="0.4" />
      <rect x="4" y="9.95" width="16" height="4.1" rx="1.3" opacity="0.68" />
      <rect x="4" y="16.7" width="16" height="4.1" rx="1.3" />
    </svg>
  );
}
