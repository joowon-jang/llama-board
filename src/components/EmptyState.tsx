import type { ReactNode } from "react";

export default function EmptyState({
  title,
  description,
  action,
  icon,
  children,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const defaultIcon = (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="12" height="14" rx="1.5" />
      <path d="M7 8h6M7 11h6M7 14h4" />
    </svg>
  );
  return (
    <div className="app-empty-state">
      <div className="app-empty-icon" aria-hidden="true">{icon ?? defaultIcon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && <button type="button" className="app-button app-button--primary" onClick={action.onClick}>{action.label}</button>}
      {children}
    </div>
  );
}