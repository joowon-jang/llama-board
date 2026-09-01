import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import TuningNavigation from "./TuningNavigation";
import { TUNING_CATEGORIES, TUNING_CONTENT_PANEL_ID } from "./tuningFields";

function renderNav(props: Partial<React.ComponentProps<typeof TuningNavigation>> = {}) {
  const defaults: React.ComponentProps<typeof TuningNavigation> = {
    categories: TUNING_CATEGORIES,
    activeCategory: "runtime",
    onSelectCategory: vi.fn(),
    mode: "quick",
    onModeChange: vi.fn(),
    query: "",
    onQueryChange: vi.fn(),
  };
  return render(
    <I18nProvider initialLocale="en">
      <TuningNavigation {...defaults} {...props} />
    </I18nProvider>,
  );
}

describe("TuningNavigation", () => {
  it("exposes Quick and Advanced tabs and selects a category", () => {
    const onSelectCategory = vi.fn();
    const onModeChange = vi.fn();
    renderNav({ onSelectCategory, onModeChange });

    const quickTab = screen.getByRole("tab", { name: "Quick" });
    const advancedTab = screen.getByRole("tab", { name: "Advanced" });
    expect(quickTab).toHaveAttribute("aria-selected", "true");
    expect(quickTab).toHaveAttribute("aria-controls", TUNING_CONTENT_PANEL_ID);
    expect(advancedTab).toHaveAttribute("aria-selected", "false");
    fireEvent.click(advancedTab);
    expect(onModeChange).toHaveBeenCalledWith("advanced");
    fireEvent.click(screen.getByRole("button", { name: "Sampling" }));
    expect(onSelectCategory).toHaveBeenCalledWith("sampling");
  });

  it("supports roving-tabindex arrow-key navigation between mode tabs", () => {
    const onModeChange = vi.fn();
    renderNav({ onModeChange });

    const quickTab = screen.getByRole("tab", { name: "Quick" });
    const advancedTab = screen.getByRole("tab", { name: "Advanced" });
    expect(quickTab).toHaveAttribute("tabindex", "0");
    expect(advancedTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(quickTab, { key: "ArrowRight" });
    expect(onModeChange).toHaveBeenCalledWith("advanced");
  });

  it("supports roving-tabindex arrow-key navigation between categories", () => {
    const onSelectCategory = vi.fn();
    renderNav({ onSelectCategory, categories: TUNING_CATEGORIES.slice(0, 2), activeCategory: TUNING_CATEGORIES[0].id });

    const firstCategory = screen.getByRole("button", { name: TUNING_CATEGORIES[0].label });
    const secondCategory = screen.getByRole("button", { name: TUNING_CATEGORIES[1].label });
    expect(firstCategory).toHaveAttribute("tabindex", "0");
    expect(secondCategory).toHaveAttribute("tabindex", "-1");
    expect(firstCategory).toHaveAttribute("aria-controls", TUNING_CONTENT_PANEL_ID);

    fireEvent.keyDown(firstCategory, { key: "ArrowDown" });
    expect(onSelectCategory).toHaveBeenCalledWith(TUNING_CATEGORIES[1].id);
  });

  it("renders a controlled settings search and clear affordance", () => {
    const onQueryChange = vi.fn();
    const { rerender } = renderNav({ categories: TUNING_CATEGORIES.slice(0, 1), query: "gpu", onQueryChange });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tuning settings" }), { target: { value: "threads" } });
    expect(onQueryChange).toHaveBeenCalledWith("threads");
    fireEvent.click(screen.getByRole("button", { name: "Clear tuning search" }));
    expect(onQueryChange).toHaveBeenCalledWith("");
    rerender(
      <I18nProvider initialLocale="en">
        <TuningNavigation
          categories={[]}
          activeCategory="runtime"
          onSelectCategory={vi.fn()}
          mode="quick"
          onModeChange={vi.fn()}
          query=""
          onQueryChange={onQueryChange}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("No matching settings.")).toBeInTheDocument();
  });
});
