import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { createConfigSaveQueue, type ConfigPatch } from "./configSaveQueue";

export interface AppStore {
  cfg: api.AppConfig | null;
  status: api.ServerStatus;
  busy: boolean;
  bootError: string | null;
  actionError: string | null;
  statusPollError: string | null;
  getConfig: () => api.AppConfig | null;
  getConfigRevision: () => number;
  loadConfig: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  updateConfig: (patch: ConfigPatch<api.AppConfig>) => Promise<api.AppConfig>;
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
  const configRevisionRef = useRef(0);
  const [status, setStatus] = useState<api.ServerStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusPollError, setStatusPollError] = useState<string | null>(null);
  const saveConfigQueue = useRef<((patch: ConfigPatch<api.AppConfig>) => Promise<api.AppConfig>) | null>(null);
  const pollInFlight = useRef(false);
  const operationInFlight = useRef(false);
  const statusGeneration = useRef(0);

  const loadConfig = useCallback(async () => {
    try {
      const loaded = await api.getConfig();
      cfgRef.current = loaded;
      configRevisionRef.current += 1;
      setCfg(loaded);
      setBootError(null);
    } catch (error) {
      const message = errorMessage(error);
      setBootError(`Configuration could not be loaded: ${message}`);
      throw error;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (pollInFlight.current || operationInFlight.current) return;
    pollInFlight.current = true;
    const generation = statusGeneration.current;
    try {
      const next = await api.serverStatus();
      if (generation === statusGeneration.current && !operationInFlight.current) {
        setStatus(next);
      }
      if (generation === statusGeneration.current && !operationInFlight.current) setStatusPollError(null);
    } catch (error) {
      if (generation === statusGeneration.current && !operationInFlight.current) {
        setStatusPollError(`Server status unavailable: ${errorMessage(error)}`);
      }
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  const updateConfig = useCallback(async (patch: ConfigPatch<api.AppConfig>) => {
    if (!saveConfigQueue.current) {
      saveConfigQueue.current = createConfigSaveQueue(
        () => cfgRef.current,
        (next) => {
          cfgRef.current = next;
          configRevisionRef.current += 1;
          setCfg(next);
        },
        (next) => api.saveConfig(next),
        (error) => setActionError(`Configuration was not saved: ${errorMessage(error)}`),
      );
    }
    const save = saveConfigQueue.current;
    if (!save) throw new Error("Configuration save queue is unavailable.");
    const saved = await save(patch);
    setActionError(null);
    return saved;
  }, []);

  const start = useCallback(async (cfgOverride?: api.AppConfig) => {
    const current = cfgOverride ?? cfgRef.current;
    if (!current) throw new Error("Configuration is still loading.");
    setBusy(true);
    setActionError(null);
    setStatus({ state: "starting" });
    operationInFlight.current = true;
    statusGeneration.current += 1;
    try {
      const url = await api.startServer(current);
      await refreshStatus();
      return url;
    } catch (error) {
      setActionError(`Server start failed: ${errorMessage(error)}`);
      await refreshStatus();
      throw error;
    } finally {
      operationInFlight.current = false;
      await refreshStatus();
      setBusy(false);
    }
  }, [refreshStatus]);

  const stop = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setStatus((current) => ({ ...current, state: "stopping" }));
    operationInFlight.current = true;
    statusGeneration.current += 1;
    try {
      await api.stopServer();
      setStatus({ state: "stopped" });
    } catch (error) {
      setActionError(`Server stop failed: ${errorMessage(error)}`);
      await refreshStatus();
      throw error;
    } finally {
      operationInFlight.current = false;
      await refreshStatus();
      setBusy(false);
    }
  }, [refreshStatus]);

  const clearActionError = useCallback(() => setActionError(null), []);
  const getConfig = useCallback(() => cfgRef.current, []);
  const getConfigRevision = useCallback(() => configRevisionRef.current, []);
  const clearErrors = useCallback(() => {
    setBootError(null);
    setActionError(null);
    setStatusPollError(null);
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
    statusPollError,
    getConfig,
    getConfigRevision,
    loadConfig,
    refreshStatus,
    updateConfig,
    start,
    stop,
    clearActionError,
    clearErrors,
  };
}
