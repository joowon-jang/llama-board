import { Children, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { normalizeDisplayText } from "../lifecycleUtils";

export type FeedbackTone = "info" | "success" | "warning" | "error";

const toneClass: Record<FeedbackTone, string> = {
  info: "app-feedback--info",
  success: "app-feedback--success",
  warning: "app-feedback--warning",
  error: "app-feedback--error",
};

export default function FeedbackBanner({
  tone,
  title,
  children,
  onDismiss,
  action,
  className,
}: {
  tone: FeedbackTone;
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  const { t } = useI18n();
  const displayChildren = Children.map(children, (child) => typeof child === "string" ? normalizeDisplayText(child) : child);
  return (
    <div className={`app-feedback ${toneClass[tone]}${className ? ` ${className}` : ""}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true">
      <div className="app-feedback-body">
        {title && <div className="app-feedback-title">{normalizeDisplayText(title)}</div>}
        <div>{displayChildren}</div>
      </div>
      {action && <button type="button" className="app-feedback-action" onClick={action.onClick}>{action.label}</button>}
      {onDismiss && <button type="button" className="app-feedback-dismiss" aria-label={t("common.dismiss")} onClick={onDismiss}>×</button>}
    </div>
  );
}
