import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";

export interface AppStore {
  cfg: api.AppConfig | null;
  status: api.ServerStatus;
  busy: boolean;
  bootError: string | null;
  actionError: string | null;
  loadConfig: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  updateConfig: (patch: Partial<api.AppConfig>) => Promise<api.AppConfig>;
  start: (cfgOverride?: api.AppConfig) => Promise<string>;
  stop: () => Promise<void>;
  clearActionError: () => void;
  clearErrors: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAppStore(): AppStore {
  const [cfg, setCfg] = useState<api.AppConfig | null>(null);
  const cfgRef = useRef<api.AppConfig | null>(null);
  const [status, setStatus] = useState<api.ServerStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const updateVersion = useRef(0);
  const pollInFlight = useRef(false);

  const loadConfig = useCallback(async () => {
    try {
      const loaded = await api.getConfig();
      cfgRef.current = loaded;
      setCfg(loaded);
      setBootError(null);
    } catch (error) {
      const message = errorMessage(error);
      setBootError(`Configuration could not be loaded: ${message}`);
      throw error;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const next = await api.serverStatus();
      setStatus(next);
    } catch (error) {
      setStatus({ state: "failed", error: `Server status unavailable: ${errorMessage(error)}` });
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  const updateConfig = useCallback(async (patch: Partial<api.AppConfig>) => {
    const previous = cfgRef.current;
    if (!previous) throw new Error("Configuration is still loading.");
    const next = { ...previous, ...patch };
    const version = ++updateVersion.current;
    cfgRef.current = next;
    setCfg(next);

    const save = saveQueue.current
      .catch(() => undefined)
      .then(() => api.saveConfig(next));
    saveQueue.current = save.catch(() => undefined);
    try {
      const saved = await save;
      if (updateVersion.current === version) {
        cfgRef.current = saved;
        setCfg(saved);
        setActionError(null);
      }
      return saved;
    } catch (error) {
      if (updateVersion.current === version) {
        cfgRef.current = previous;
        setCfg(previous);
      }
      setActionError(`Configuration was not saved: ${errorMessage(error)}`);
      throw error;
    }
  }, []);

  const start = useCallback(async (cfgOverride?: api.AppConfig) => {
    const current = cfgOverride ?? cfgRef.current;
    if (!current) throw new Error("Configuration is still loading.");
    setBusy(true);
    setActionError(null);
    setStatus({ state: "starting" });
    try {
      const url = await api.startServer(current);
      await refreshStatus();
      return url;
    } catch (error) {
      setActionError(`Server start failed: ${errorMessage(error)}`);
      await refreshStatus();
      throw error;
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const stop = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setStatus((current) => ({ ...current, state: "stopping" }));
    try {
      await api.stopServer();
      setStatus({ state: "stopped" });
    } catch (error) {
      setActionError(`Server stop failed: ${errorMessage(error)}`);
      await refreshStatus();
      throw error;
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const clearActionError = useCallback(() => setActionError(null), []);
  const clearErrors = useCallback(() => {
    setBootError(null);
    setActionError(null);
    setStatus((current) => ({ ...current, error: undefined }));
  }, []);

  useEffect(() => {
    void loadConfig().catch(() => undefined);
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1500);
    return () => window.clearInterval(timer);
  }, [loadConfig, refreshStatus]);

  return {
    cfg,
    status,
    busy,
    bootError,
    actionError,
    loadConfig,
    refreshStatus,
    updateConfig,
    start,
    stop,
    clearActionError,
    clearErrors,
  };
}
