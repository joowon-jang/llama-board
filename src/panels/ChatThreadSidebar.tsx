import type { ChatThread } from "../chatHistory";
import type { ChatTextKey } from "../chatI18n";

interface ChatThreadSidebarProps {
  open: boolean;
  activeThreadId: string;
  threadCount: number;
  threadQuery: string;
  setThreadQuery: (value: string) => void;
  visibleThreads: ChatThread[];
  onSelect: (thread: ChatThread) => void;
  onDelete: (thread: ChatThread) => void;
  onNewThread: () => void;
  ct: (key: ChatTextKey) => string;
}

export default function ChatThreadSidebar({
  open, activeThreadId, threadCount, threadQuery, setThreadQuery, visibleThreads,
  onSelect, onDelete, onNewThread, ct,
}: ChatThreadSidebarProps) {
  return (
    <aside
      id="chat-thread-panel"
      aria-label={ct("conversations")}
      className={`${open ? "absolute inset-y-0 left-0 z-20 flex" : "hidden"} w-72 shrink-0 flex-col rounded-xl border bg-[var(--board-panel)] p-3 shadow-[var(--board-elev-2)] sm:relative sm:inset-auto sm:z-auto sm:flex sm:w-64 sm:shadow-none sm:border-[var(--board-border)]`}
      style={{ borderColor: "var(--board-border)" }}
    >
      <div className="flex items-center gap-2 pb-3">
        <div className="min-w-0 flex-1">
          <div className="app-eyebrow" style={{ color: "var(--board-faint)" }}>{ct("conversations")}</div>
          <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: "var(--board-faint)" }}>{threadCount} {ct("conversations")}</div>
        </div>
        <button type="button" onClick={onNewThread} className="app-button app-button--primary app-button--sm">{ct("newChat")}</button>
      </div>
      <label className="sr-only" htmlFor="chat-thread-search">{ct("search")}</label>
      <input
        id="chat-thread-search"
        value={threadQuery}
        onChange={(event) => setThreadQuery(event.target.value)}
        placeholder={ct("search")}
        className="app-input mb-2.5"
      />
      <div className="min-h-0 flex-1 space-y-1 overflow-auto pr-0.5" role="list">
        {visibleThreads.length === 0 && <p className="px-2 py-4 text-xs" style={{ color: "var(--board-faint)" }}>{ct("noMatches")}</p>}
        {visibleThreads.map((thread) => (
          <div key={thread.id} role="listitem" className={`app-list-row flex items-center justify-between gap-1 px-1 py-1 ${thread.id === activeThreadId ? "is-selected" : ""}`}>
            <button
              type="button"
              onClick={() => onSelect(thread)}
              className="min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--board-focus)]"
              aria-current={thread.id === activeThreadId ? "page" : undefined}
            >
              <span className="block truncate text-xs font-medium" style={{ color: "var(--board-ink)" }}>{thread.title || ct("newConversation")}</span>
              <span className="mt-0.5 block text-[11px] tabular-nums" style={{ color: "var(--board-faint)" }}>{thread.messages.length ? `${thread.messages.length} ${ct("messages")}` : ct("empty")}</span>
            </button>
            <button type="button" onClick={() => onDelete(thread)} aria-label={`${ct("delete")}: ${thread.title || ct("newConversation")}`} className="app-icon-button app-icon-button--danger mr-1" title={ct("delete")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
