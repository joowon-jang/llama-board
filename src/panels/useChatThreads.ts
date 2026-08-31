import { useEffect, useRef, useState } from "react";
import { createChatThread, loadChatWorkspace, loadChatWorkspaceAsync, mergeHydratedWorkspace, saveChatWorkspaceAsync, threadMatchesQuery, titleFromMessage, type ChatHistoryMessage, type ChatThread, type ChatWorkspace } from "../chatHistory";
import { removeDocumentVectorsForPaths } from "../documentIndex";
import { shouldConfirmDestructive } from "../preferences";

type Msg = ChatHistoryMessage;

interface UseChatThreadsOptions {
  phase: "idle" | "thinking" | "streaming";
  /** True (and proceeds) only when the panel is idle; otherwise surfaces an error and blocks the switch. */
  requireIdle: () => boolean;
  /** Resets composer-local state (input, attachments, context warnings) after a thread switch. */
  onSwitchThread: () => void;
}

/** Document paths this thread used that no remaining thread still needs. */
function orphanedDocumentPaths(removed: ChatThread, remaining: ChatThread[]): string[] {
  const pathsOf = (threads: ChatThread[]) => new Set(
    threads.flatMap((item) => item.messages.flatMap((message) => (message.documents ?? []).map((document) => document.path))),
  );
  const kept = pathsOf(remaining);
  return [...pathsOf([removed])].filter((path) => !kept.has(path));
}

export function useChatThreads({ phase, requireIdle, onSwitchThread }: UseChatThreadsOptions) {
  const [workspace, setWorkspace] = useState<ChatWorkspace>(() => loadChatWorkspace());
  const activeThread = workspace.threads.find((thread) => thread.id === workspace.activeThreadId) ?? workspace.threads[0];
  const [msgs, setMsgs] = useState<Msg[]>(() => activeThread?.messages ?? []);
  const [threadQuery, setThreadQuery] = useState("");
  const [threadPanelOpen, setThreadPanelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ChatThread | null>(null);
  const hydratedRef = useRef(false);
  const initialWorkspaceRef = useRef(workspace);
  const initialMsgsRef = useRef(msgs);
  const workspaceRef = useRef(workspace);
  const msgsRef = useRef(msgs);
  workspaceRef.current = workspace;
  msgsRef.current = msgs;

  useEffect(() => {
    let cancelled = false;
    void loadChatWorkspaceAsync().then((persisted) => {
      if (cancelled) return;
      const merged = mergeHydratedWorkspace(persisted, workspaceRef.current, initialWorkspaceRef.current);
      const localMessagesChanged = JSON.stringify(msgsRef.current) !== JSON.stringify(initialMsgsRef.current);
      const nextActive = merged.threads.find((thread) => thread.id === merged.activeThreadId) ?? merged.threads[0];
      hydratedRef.current = true;
      setWorkspace(merged);
      if (!localMessagesChanged) setMsgs(nextActive?.messages ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (hydratedRef.current) void saveChatWorkspaceAsync(workspace);
  }, [workspace]);

  useEffect(() => {
    if (phase !== "idle" || !activeThread) return;
    setWorkspace((current) => {
      const thread = current.threads.find((item) => item.id === current.activeThreadId);
      if (!thread || thread.messages === msgs) return current;
      const firstUser = msgs.find((message) => message.role === "user");
      const nextTitle = thread.title === "New conversation" && firstUser ? titleFromMessage(firstUser.content) : thread.title;
      return {
        ...current,
        threads: current.threads.map((item) => item.id === thread.id
          ? { ...item, messages: msgs, title: nextTitle, updatedAt: Date.now() }
          : item),
      };
    });
  }, [activeThread, msgs, phase]);

  const visibleThreads = workspace.threads
    .filter((thread) => threadMatchesQuery(thread, threadQuery))
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const selectThread = (thread: ChatThread) => {
    if (!requireIdle()) return;
    setWorkspace((current) => ({ ...current, activeThreadId: thread.id }));
    setMsgs(thread.messages);
    onSwitchThread();
    setThreadPanelOpen(false);
  };

  const newThread = () => {
    if (!requireIdle()) return;
    const now = Date.now();
    let id = `thread-${now}`;
    let suffix = 1;
    while (workspace.threads.some((thread) => thread.id === id)) id = `thread-${now}-${suffix++}`;
    const thread = createChatThread(now, id);
    setWorkspace((current) => ({ activeThreadId: thread.id, threads: [thread, ...current.threads] }));
    setMsgs([]);
    onSwitchThread();
    setThreadPanelOpen(false);
  };

  const deleteThread = (thread: ChatThread) => {
    if (!requireIdle()) return;
    if (shouldConfirmDestructive()) setPendingDelete(thread);
    else performDeleteThread(thread);
  };

  const performDeleteThread = (thread: ChatThread) => {
    setPendingDelete(null);
    const remaining = workspace.threads.filter((item) => item.id !== thread.id);
    // The embedding cache is shared between conversations, so only drop vectors
    // for documents nothing else references any more.
    const orphaned = orphanedDocumentPaths(thread, remaining);
    if (orphaned.length > 0) void removeDocumentVectorsForPaths(orphaned).catch(() => undefined);
    if (thread.id !== workspace.activeThreadId) {
      setWorkspace((current) => ({ ...current, threads: remaining }));
      return;
    }
    const replacement = remaining[0] ?? createChatThread(Date.now(), `thread-${Date.now()}`);
    setWorkspace({ activeThreadId: replacement.id, threads: remaining.length ? remaining : [replacement] });
    setMsgs(replacement.messages);
    onSwitchThread();
  };

  const updateActiveThread = (patch: Partial<Pick<ChatThread, "title" | "systemPrompt">>) => {
    if (!activeThread || !requireIdle()) return;
    setWorkspace((current) => ({
      ...current,
      threads: current.threads.map((thread) => thread.id === current.activeThreadId
        ? { ...thread, ...patch, updatedAt: Date.now() }
        : thread),
    }));
  };

  return {
    workspace, setWorkspace, activeThread, msgs, setMsgs,
    threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen,
    pendingDelete, setPendingDelete, visibleThreads,
    selectThread, newThread, deleteThread, performDeleteThread, updateActiveThread,
  };
}
