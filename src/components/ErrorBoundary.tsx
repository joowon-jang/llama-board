import React from "react";
import EmptyState from "./EmptyState";
import { messages, type Locale } from "../i18n";

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
    const locale = (document.documentElement.lang.split("-")[0] as Locale) in messages ? document.documentElement.lang.split("-")[0] as Locale : "en";
    const copy = messages[locale];
    return (
      <div className="app-runtime-empty" role="alert">
        <EmptyState
          title={copy["error.wrong"]}
          description={copy["error.tryAgain"]}
          action={{ label: copy["error.tryAgain"], onClick: this.recover }}
          icon="!"
        />
      </div>
    );
  }
}

export function PanelBoundary({ label, children }: Props) {
  return <ErrorBoundary label={label}>{children}</ErrorBoundary>;
}
