import { useRef } from "react";

export interface TabNavItem<T extends string> {
  id: T;
  label: string;
}

interface TabNavProps<T extends string> {
  items: readonly TabNavItem<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** Accessible name for the tablist. */
  label: string;
  /** DOM id for a tab button; must match the `aria-labelledby` of its panel. */
  tabId: (id: T) => string;
  /** DOM id of the panel a tab controls. Several tabs may share one panel. */
  panelId: (id: T) => string;
  orientation?: "horizontal" | "vertical";
  className?: string;
  tabClassName?: (isActive: boolean) => string;
}

/**
 * The WAI-ARIA tabs pattern with automatic activation: one tab stop for the
 * whole list, arrow keys move the selection and the focus with it.
 *
 * All three navigation levels (top bar, section sidebar, settings sidebar) use
 * this so they behave identically from the keyboard.
 */
export default function TabNav<T extends string>({
  items,
  active,
  onSelect,
  label,
  tabId,
  panelId,
  orientation = "horizontal",
  className,
  tabClassName,
}: TabNavProps<T>) {
  const tabRefs = useRef<Partial<Record<T, HTMLButtonElement>>>({});

  const activate = (id: T) => {
    onSelect(id);
    window.requestAnimationFrame(() => tabRefs.current[id]?.focus());
  };

  const move = (delta: number) => {
    const index = items.findIndex((item) => item.id === active);
    const next = items[(index + delta + items.length) % items.length];
    if (next) activate(next.id);
  };

  const forwardKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const backKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === forwardKey) {
      event.preventDefault();
      move(1);
    } else if (event.key === backKey) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      activate(items[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      activate(items[items.length - 1].id);
    }
  };

  return (
    <div role="tablist" aria-label={label} aria-orientation={orientation} className={className}>
      {items.map((item) => (
        <button
          key={item.id}
          id={tabId(item.id)}
          ref={(element) => { tabRefs.current[item.id] = element ?? undefined; }}
          type="button"
          role="tab"
          aria-selected={item.id === active}
          aria-controls={panelId(item.id)}
          tabIndex={item.id === active ? 0 : -1}
          onClick={() => onSelect(item.id)}
          onKeyDown={onKeyDown}
          className={tabClassName?.(item.id === active)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
