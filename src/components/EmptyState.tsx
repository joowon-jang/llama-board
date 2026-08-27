import type { ReactNode } from "react";

export default function EmptyState({
  title,
  description,
  action,
  icon = "✦",
  children,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="app-empty-state">
      <div className="app-empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && <button type="button" className="app-button app-button--primary" onClick={action.onClick}>{action.label}</button>}
      {children}
    </div>
  );
}