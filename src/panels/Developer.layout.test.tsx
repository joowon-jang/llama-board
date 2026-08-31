import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import type { AppStore } from "../store";
import { I18nProvider } from "../i18n";
import DeveloperPanel from "./Developer";

vi.mock("../api", () => ({
  anthropicGatewayStatus: vi.fn(async () => ({ running: false })),
  localModels: vi.fn(),
  startAnthropicGateway: vi.fn(),
  stopAnthropicGateway: vi.fn(),
}));

const store = {
  cfg: null,
  status: { state: "stopped" },
  start: async () => "",
} as unknown as AppStore;

function renderPanel(section: "api" | "gateways" | "diagnostics") {
  return render(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(DeveloperPanel, { store, section }),
  }));
}

describe("DeveloperPanel layout", () => {
  it("keeps API documentation in the API page only", () => {
    const { container } = renderPanel("api");

    expect(container.querySelector(".developer-summary-grid")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--connection")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--endpoints")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--compatibility")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--snippets")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--gateway")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--responses")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--diagnostics")).not.toBeInTheDocument();
  });

  it("keeps gateway documentation in the gateways page only", () => {
    const { container } = renderPanel("gateways");

    expect(container.querySelector(".developer-summary-grid")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--gateway")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--responses")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--connection")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--endpoints")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--compatibility")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--snippets")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--diagnostics")).not.toBeInTheDocument();
  });

  it("keeps runtime diagnostics in the diagnostics page only", () => {
    const { container } = renderPanel("diagnostics");

    expect(container.querySelector(".developer-summary-grid")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--diagnostics")).toBeInTheDocument();
    expect(container.querySelector(".developer-section--connection")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--endpoints")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--compatibility")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--gateway")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--responses")).not.toBeInTheDocument();
    expect(container.querySelector(".developer-section--snippets")).not.toBeInTheDocument();
  });
});
