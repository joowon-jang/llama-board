import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import TabNav, { type TabNavItem } from "./TabNav";

type Section = "one" | "two" | "three";

const items: TabNavItem<Section>[] = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
];

function Harness({ orientation = "horizontal", onSelect }: { orientation?: "horizontal" | "vertical"; onSelect?: (id: Section) => void }) {
  const [active, setActive] = useState<Section>("one");
  return (
    <TabNav
      items={items}
      active={active}
      onSelect={(id) => { setActive(id); onSelect?.(id); }}
      label="Sections"
      orientation={orientation}
      tabId={(id) => `tab-${id}`}
      panelId={() => "panel"}
    />
  );
}

// Focus follows selection asynchronously, so drive the key from the tab that
// is currently selected rather than from document.activeElement.
const press = (key: string) => {
  fireEvent.keyDown(screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")!, { key });
};

describe("TabNav", () => {
  it("exposes a single tab stop with the ARIA tabs wiring", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-label", "Sections");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[0]).toHaveAttribute("aria-controls", "panel");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  });

  it("moves selection and focus with the horizontal arrow keys and wraps", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    press("ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("two");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("three");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveAttribute("aria-selected", "true");
  });

  it("uses the vertical arrow keys when the list is vertical", () => {
    const onSelect = vi.fn();
    render(<Harness orientation="vertical" onSelect={onSelect} />);

    press("ArrowRight");
    expect(onSelect).not.toHaveBeenCalled();
    press("ArrowDown");
    expect(onSelect).toHaveBeenLastCalledWith("two");
  });

  it("jumps to the first and last tab with Home and End", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    press("End");
    expect(onSelect).toHaveBeenLastCalledWith("three");
    press("Home");
    expect(onSelect).toHaveBeenLastCalledWith("one");
  });
});
