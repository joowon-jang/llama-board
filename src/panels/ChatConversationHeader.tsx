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
    <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setThreadPanelOpen((current) => !current)}
          className="rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-xs text-slate-300 app-border-strongest hover:text-white sm:hidden"
          aria-expanded={threadPanelOpen}
          aria-controls="chat-thread-panel"
        >
          {ct("conversations")}
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-100">{activeThread?.title ?? ct("newConversation")}</h2>
          <p className="truncate text-xs text-slate-500">{headerSubtitle}{activeProjectName ? ` · ${activeProjectName}` : ""}</p>
        </div>
      </div>
      <details className="relative shrink-0">
        <summary className="cursor-pointer list-none rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-xs text-slate-300 app-border-strongest hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
          {ct("conversationSettings")}
        </summary>
        <div className="absolute right-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-300" htmlFor="chat-thread-title">{ct("title")}</label>
            <input
              id="chat-thread-title"
              value={activeThread?.title ?? ""}
              onChange={(event) => onUpdateThread({ title: event.target.value })}
              disabled={phase !== "idle"}
              className="mt-1.5 w-full rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300" htmlFor="chat-system-prompt">{ct("systemPrompt")}</label>
            <textarea
              id="chat-system-prompt"
              value={activeThread?.systemPrompt ?? ""}
              onChange={(event) => onUpdateThread({ systemPrompt: event.target.value })}
              disabled={phase !== "idle"}
              rows={5}
              className="mt-1.5 w-full resize-y rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
              placeholder={ct("systemPromptPlaceholder")}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">{ct("savedLocallyDescription")}</p>
        </div>
      </details>
    </div>
  );
}
