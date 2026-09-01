import type { TuningTooltip } from "../panels/tuningFields";

interface TooltipProps {
  content: TuningTooltip | string;
  /** Accessible name for the help affordance. */
  label?: string;
  id?: string;
}

/**
 * Small, CSS-only tooltip used by dense tuning controls.  The content remains
 * in the DOM for screen readers and appears on hover/focus, so the first
 * redesign stage does not need global popover state or a portal.
 */
export default function Tooltip({ content, label = "Show help", id }: TooltipProps) {
  const title = typeof content === "string" ? undefined : content.title;
  const description = typeof content === "string" ? content : content.description;
  const tooltipId = id ? `${id}-tooltip` : undefined;
  return (
    <span className="app-tooltip" data-tooltip>
      <button
        type="button"
        className="app-tooltip-trigger"
        aria-label={label}
        aria-describedby={tooltipId}
        title={description}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span id={tooltipId} role="tooltip" className="app-tooltip-popover">
        {title && <strong className="app-tooltip-title">{title}</strong>}
        <span>{description}</span>
      </span>
    </span>
  );
}

export type { TooltipProps };
