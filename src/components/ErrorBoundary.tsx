import React from "react";
import EmptyState from "./EmptyState";
import { translate, type Locale } from "../i18n";

type Props = { children: React.ReactNode; label?: string };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("llama-board render error", error, info.componentStack);
  }

  private recover = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const language = document.documentElement.lang.split("-")[0];
    const locale: Locale = language === "ko" || language === "ja" || language === "zh" || language === "en" ? language : "en";
    return (
      <div className="app-runtime-empty" role="alert">
        <EmptyState
          title={translate(locale, "error.wrong")}
          description={translate(locale, "error.tryAgain")}
          action={{ label: translate(locale, "error.tryAgain"), onClick: this.recover }}
          icon="!"
        />
      </div>
    );
  }
}

export function PanelBoundary({ label, children }: Props) {
  return <ErrorBoundary label={label}>{children}</ErrorBoundary>;
}
