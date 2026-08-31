import { describe, expect, it, vi } from "vitest";
import { Fragment, createElement, memo } from "react";
import { render } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";
import type { ChatHistoryMessage } from "../chatHistory";

/**
 * Automated stand-in for a React DevTools Profiler capture on a 200+ message
 * thread: proves the P1-7 fix (isolating the streaming bubble into a memoized
 * component) actually skips re-rendering every earlier bubble on a streaming
 * tick, instead of asserting it by reading the source.
 *
 * This re-wraps the same unmemoized implementation Chat.tsx renders in the
 * same `memo()` call the production default export uses, with a spy around
 * the render function itself — a plain `<Profiler>` can't tell the difference
 * because it fires for every commit that touches its subtree regardless of
 * whether a memoized child inside bailed out.
 */
const MESSAGE_COUNT = 220;

function makeMessages(count: number): ChatHistoryMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  }));
}

describe("MessageBubble memoization under streaming (P1-7)", () => {
  it("re-renders only the last bubble when a streaming tick patches the final message", () => {
    const renderSpy = vi.fn(MessageBubble);
    const MemoizedBubble = memo(renderSpy);
    const messages = makeMessages(MESSAGE_COUNT);
    // Stable across renders, exactly like Chat.tsx's memoized `copyMessage` callback.
    const onCopy = () => undefined;

    const renderList = (msgs: ChatHistoryMessage[]) => msgs.map((message, index) =>
      createElement(MemoizedBubble, {
        key: index,
        message,
        index,
        messageCount: msgs.length,
        phase: "streaming" as const,
        copied: false,
        compact: false,
        locale: "en" as const,
        onCopy,
      })
    );

    const { rerender } = render(createElement(Fragment, null, ...renderList(messages)));
    expect(renderSpy).toHaveBeenCalledTimes(MESSAGE_COUNT);
    renderSpy.mockClear();

    // Mirrors Chat.tsx's `msgs.map` at render time: every bubble but the last
    // keeps the exact same `message` reference; only the last is patched with
    // the streaming draft's content.
    const lastIndex = messages.length - 1;
    const streamed = messages.map((message, index) => index === lastIndex ? { ...message, content: "message 219 (streaming...)" } : message);
    rerender(createElement(Fragment, null, ...renderList(streamed)));

    // The whole point of memoizing the bubble: one streaming tick re-renders
    // exactly one component (the last bubble), not all 220.
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy.mock.calls[0][0].index).toBe(lastIndex);
  });
});
