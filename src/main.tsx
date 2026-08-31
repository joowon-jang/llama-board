import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { loadPreferences } from "./preferences";
import "./index.css";

// Track keyboard navigation modality so focus outlines only appear on keyboard interaction
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Tab" || e.key.startsWith("Arrow") || e.key === "Enter" || e.key === "Escape" || e.key === " ") {
      document.body.classList.add("is-keyboard-nav");
    }
  }, true);

  window.addEventListener("pointerdown", () => {
    document.body.classList.remove("is-keyboard-nav");
  }, true);
}

const initialPreferences = loadPreferences();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider initialLocale={initialPreferences.locale}>
      <ErrorBoundary label="Application"><App /></ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>,
);
