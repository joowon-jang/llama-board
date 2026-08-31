import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { CustomSelect } from "./ThemeSwitcher";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function renderSelect(onChange = vi.fn()) {
  render(<CustomSelect id="theme" value="light" options={OPTIONS} onChange={onChange} ariaLabel="Theme" />);
  // The sr-only native <select> also resolves to role "combobox" with the same
  // accessible name; the visible trigger button is the one under test.
  const trigger = screen.getAllByRole("combobox", { name: "Theme" }).find((el) => el.tagName === "BUTTON");
  if (!trigger) throw new Error("CustomSelect trigger button not found.");
  return { onChange, trigger };
}

describe("CustomSelect", () => {
  it("links the trigger to the listbox and to the highlighted option", () => {
    const { trigger } = renderSelect();
    expect(trigger).not.toHaveAttribute("aria-activedescendant");
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Theme" });
    expect(trigger).toHaveAttribute("aria-controls", listbox.id);
    expect(trigger).toHaveAttribute("aria-activedescendant", `${listbox.id}-option-0`);
  });

  it("moves the highlight on arrow keys without committing a value", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("-option-1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits the highlighted option only on Enter", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("commits the highlighted option on Space", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the original value when Escape cancels an in-progress navigation", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Light");
  });

  it("jumps the highlight to a typeahead match while open, without committing", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "s" });
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("-option-2"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects a typeahead match immediately while closed", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.keyDown(trigger, { key: "d" });
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("has no axe-core accessibility violations, closed or open", async () => {
    const { trigger } = renderSelect();
    const closedResults = await axe.run(trigger.closest("div") ?? trigger);
    expect(closedResults.violations).toEqual([]);

    fireEvent.click(trigger);
    const openResults = await axe.run(trigger.closest("div") ?? trigger);
    expect(openResults.violations).toEqual([]);
  });
});
