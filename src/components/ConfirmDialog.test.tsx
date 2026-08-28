import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { I18nProvider } from "../i18n";

function renderDialogs() {
  return render(createElement(
    I18nProvider,
    {
      initialLocale: "en",
      children: createElement(
        "div",
        null,
        createElement(ConfirmDialog, {
          open: true,
          title: "Remove runtime",
          description: "This removes the selected runtime.",
          confirmLabel: "Remove",
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
        createElement(ConfirmDialog, {
          open: true,
          title: "Build pull request",
          description: "This compiles code from the selected commit.",
          confirmLabel: "Build",
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    },
  ));
}

describe("ConfirmDialog accessibility", () => {
  it("gives every instance unique title and description IDs and accessible names", async () => {
    renderDialogs();
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));

    const dialogs = screen.getAllByRole("dialog");
    const titleIds = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
    const descriptionIds = dialogs.map((dialog) => dialog.getAttribute("aria-describedby"));

    expect(new Set(titleIds).size).toBe(2);
    expect(new Set(descriptionIds).size).toBe(2);
    expect(titleIds.every((id) => id && document.getElementById(id))).toBe(true);
    expect(descriptionIds.every((id) => id && document.getElementById(id))).toBe(true);
    expect(dialogs[0]).toHaveAccessibleName("Remove runtime");
    expect(dialogs[0]).toHaveAccessibleDescription("This removes the selected runtime.");
    expect(dialogs[1]).toHaveAccessibleName("Build pull request");
    expect(dialogs[1]).toHaveAccessibleDescription("This compiles code from the selected commit.");
  });
});
