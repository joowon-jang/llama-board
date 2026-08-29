import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { defaultPreferences } from "../preferences";
import SettingsPanel from "./Settings";

describe("SettingsPanel layout", () => {
  it("keeps the theme selector in the Appearance page only", () => {
    const { container } = render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(SettingsPanel, {
        preferences: defaultPreferences(),
        update: vi.fn(),
        reset: vi.fn(),
      }),
    }));

    expect(container.querySelector("select#settings-theme")).not.toBeInTheDocument();
    expect(container.querySelector("select#settings-appearance-theme")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    expect(container.querySelectorAll("select#settings-theme")).toHaveLength(1);
    expect(container.querySelector("select#settings-appearance-theme")).not.toBeInTheDocument();
    expect(container.querySelector(".app-theme-control")).not.toBeInTheDocument();
  });
});
