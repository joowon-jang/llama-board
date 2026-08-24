import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";

/**
 * App-wide store: current config (single source of truth for the UI), live
 * server status (polled), and actions that keep both in sync. Per §0 the
 * status dot is global — every panel reads it.
 */
export function useApp() {
  const [cfg, setCfg] = useState<api.AppConfig | null>(null);
  const [status, setStatus] = useState<api.ServerStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadConfig = useCallback(async () => {
    const c = await api.getConfig();
    setCfg(c);
    return c;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.serverStatus());
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  // Initial load + status polling.
  useEffect(() => {
    loadConfig();
    refreshStatus();
    timer.current = setInterval(refreshStatus, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [loadConfig, refreshStatus]);

  // Persist a change to config (and keep local state in sync).
  const updateConfig = useCallback(
    async (patch: Partial<api.AppConfig>) => {
      if (!cfg) return;
      const next = { ...cfg, ...patch };
      setCfg(next);
      try {
        await api.saveConfig(next);
      } catch (e) {
        console.error("save_config failed", e);
      }
      return next;
    },
    [cfg],
  );

  const start = useCallback(async (override?: api.AppConfig) => {
    const effective = override ?? cfg;
    if (!effective) return;
    setBusy(true);
    try {
      await api.startServer(effective);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [cfg, refreshStatus]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await api.stopServer();
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  return {
    cfg,
    status,
    busy,
    setCfg,
    loadConfig,
    updateConfig,
    start,
    stop,
    refreshStatus,
  };
}

export type AppStore = ReturnType<typeof useApp>;
