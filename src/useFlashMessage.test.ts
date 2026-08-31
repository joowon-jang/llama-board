import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlashMessage } from "./useFlashMessage";

describe("useFlashMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the message after the default 4000ms timeout", () => {
    const { result } = renderHook(() => useFlashMessage());
    act(() => result.current[1]("saved"));
    expect(result.current[0]).toBe("saved");

    act(() => vi.advanceTimersByTime(3999));
    expect(result.current[0]).toBe("saved");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeNull();
  });

  it("clears the message after a custom timeout", () => {
    const { result } = renderHook(() => useFlashMessage(1000));
    act(() => result.current[1]("saved"));

    act(() => vi.advanceTimersByTime(999));
    expect(result.current[0]).toBe("saved");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeNull();
  });

  it("restarts the timer when a new message replaces the current one", () => {
    const { result } = renderHook(() => useFlashMessage(1000));
    act(() => result.current[1]("first"));
    act(() => vi.advanceTimersByTime(900));
    act(() => result.current[1]("second"));

    act(() => vi.advanceTimersByTime(900));
    expect(result.current[0]).toBe("second");

    act(() => vi.advanceTimersByTime(100));
    expect(result.current[0]).toBeNull();
  });

  it("dismiss clears the message immediately without arming a new timer", () => {
    const { result } = renderHook(() => useFlashMessage(1000));
    act(() => result.current[1]("saved"));
    act(() => result.current[2]());
    expect(result.current[0]).toBeNull();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current[0]).toBeNull();
  });

  it("setting null clears the message without arming a timer", () => {
    const { result } = renderHook(() => useFlashMessage(1000));
    act(() => result.current[1]("saved"));
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });

  it("clears the pending timer on unmount", () => {
    const { result, unmount } = renderHook(() => useFlashMessage(1000));
    act(() => result.current[1]("saved"));
    const clearSpy = vi.spyOn(window, "clearTimeout");
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
