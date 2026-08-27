import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { loadPreferences } from "./preferences";
import "./index.css";

const initialPreferences = loadPreferences();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider initialLocale={initialPreferences.locale}>
      <ErrorBoundary label="Application"><App /></ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>,
);
