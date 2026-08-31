import type { ChatThread } from "../chatHistory";
import type { ChatTextKey } from "../chatI18n";

interface ChatConversationHeaderProps {
  threadPanelOpen: boolean;
  setThreadPanelOpen: (updater: (value: boolean) => boolean) => void;
  activeThread: ChatThread | undefined;
  headerSubtitle: string;
  activeProjectName: string | null;
  phase: "idle" | "thinking" | "streaming";
  onUpdateThread: (patch: Partial<Pick<ChatThread, "title" | "systemPrompt">>) => void;
  ct: (key: ChatTextKey) => string;
}

export default function ChatConversationHeader({
  threadPanelOpen, setThreadPanelOpen, activeThread, headerSubtitle, activeProjectName, phase, onUpdateThread, ct,
}: ChatConversationHeaderProps) {
  return (
    <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setThreadPanelOpen((current) => !current)}
          className="app-button app-button--secondary app-button--sm sm:hidden"
          aria-expanded={threadPanelOpen}
          aria-controls="chat-thread-panel"
        >
          {ct("conversations")}
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold" style={{ color: "var(--board-ink)" }}>{activeThread?.title ?? ct("newConversation")}</h2>
          <p className="truncate text-xs tabular-nums" style={{ color: "var(--board-faint)" }}>{headerSubtitle}{activeProjectName ? ` · ${activeProjectName}` : ""}</p>
        </div>
      </div>
      <details className="relative shrink-0">
        <summary className="app-button app-button--secondary app-button--sm cursor-pointer list-none">
          {ct("conversationSettings")}
        </summary>
        <div className="absolute right-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border p-4 shadow-xl space-y-3" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
          <div>
            <label className="block text-xs font-medium" style={{ color: "var(--board-ink)" }} htmlFor="chat-thread-title">{ct("title")}</label>
            <input
              id="chat-thread-title"
              value={activeThread?.title ?? ""}
              onChange={(event) => onUpdateThread({ title: event.target.value })}
              disabled={phase !== "idle"}
              className="app-input mt-1.5"
            />
          </div>
          <div>
            <label className="block text-xs font-medium" style={{ color: "var(--board-ink)" }} htmlFor="chat-system-prompt">{ct("systemPrompt")}</label>
            <textarea
              id="chat-system-prompt"
              value={activeThread?.systemPrompt ?? ""}
              onChange={(event) => onUpdateThread({ systemPrompt: event.target.value })}
              disabled={phase !== "idle"}
              rows={4}
              className="app-textarea mt-1.5"
              placeholder={ct("systemPromptPlaceholder")}
            />
          </div>
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--board-faint)" }}>{ct("savedLocallyDescription")}</p>
        </div>
      </details>
    </div>
  );
}
