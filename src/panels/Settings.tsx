import { cloneElement, isValidElement, useState, type ReactNode } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import Switch from "../components/Switch";
import TabNav, { type TabNavItem } from "../components/TabNav";
import { CustomSelect } from "../components/ThemeSwitcher";
import { localeOptions, useI18n } from "../i18n";
import { ut } from "../uiI18n";
import { clearChatWorkspace } from "../chatHistory";
import { clearDocumentIndex } from "../documentIndex";
import { defaultPreferences, exportPreferences, importPreferences, type AppPreferences } from "../preferences";

interface Props { preferences: AppPreferences; update: (patch: Partial<AppPreferences>) => void; reset: () => void; }

type Section = "general" | "appearance" | "chat" | "server" | "advanced";

function Row({ id, label, description, children }: { id: string; label: string; description: string; children: ReactNode }) {
  const descriptionId = `${id}-description`;
  const control = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": descriptionId })
    : children;
  return <div className="settings-row"><div className="settings-copy"><label htmlFor={id}>{label}</label><p id={descriptionId}>{description}</p></div><div className="settings-control">{control}</div></div>;
}

export default function SettingsPanel({ preferences, update, reset }: Props) {
  const { t, locale, setLocale } = useI18n();
  const [section, setSection] = useState<Section>("general");
  const [confirmReset, setConfirmReset] = useState(false);
  const [ioError, setIoError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeNotice, setWipeNotice] = useState<string | null>(null);

  const wipeConversationData = async () => {
    setWiping(true);
    try {
      // Both stores hold readable content: the workspace keeps message text,
      // the index keeps the extracted document chunks it embedded.
      await clearChatWorkspace();
      await clearDocumentIndex();
      setWipeNotice(ut(locale, "wipeDataDone"));
      setIoError(null);
    } catch (error) {
      setIoError(`${ut(locale, "wipeDataFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWiping(false);
      setConfirmWipe(false);
    }
  };
  const sections: TabNavItem<Section>[] = [
    { id: "general", label: t("settings.general") }, { id: "appearance", label: t("settings.appearance") },
    { id: "chat", label: t("settings.chat") }, { id: "server", label: t("settings.server") }, { id: "advanced", label: t("settings.advanced") },
  ];
  const patch = (next: Partial<AppPreferences>) => {
    update(next);
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1800);
  };
  const toggle = (key: "enterToSend" | "showTimestamps" | "streamResponses" | "compactMessages", value: boolean) => patch({ chat: { ...preferences.chat, [key]: value } });
  const bool = (id: string, checked: boolean, onChange: (value: boolean) => void) => <Switch id={id} checked={checked} onChange={onChange} />;
  const downloadExport = () => {
    const blob = new Blob([exportPreferences(preferences)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "llama-board-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const next = importPreferences(await file.text());
      update(next);
      setLocale(next.locale);
      setIoError(null);
    } catch (error) {
      setIoError(error instanceof Error ? error.message : String(error));
    }
  };


  return <div className="app-page-scroll settings-page">
    <div className="settings-header"><div><div className="app-eyebrow">llama-board</div><h2>{t("settings.title")}</h2><p>{t("settings.subtitle")}</p></div><span className={`settings-save-slot ${saveState === "saved" ? "" : "is-empty"}`} role={saveState === "saved" ? "status" : undefined} aria-live={saveState === "saved" ? "polite" : undefined}>{saveState === "saved" ? <span className="app-status-badge app-status-badge--success">{t("common.saved")}</span> : "—"}</span></div>
    <div className="settings-layout">
      <TabNav
        items={sections}
        active={section}
        onSelect={setSection}
        label={t("settings.title")}
        orientation="vertical"
        tabId={(id) => `settings-tab-${id}`}
        panelId={() => "settings-tabpanel"}
        className="settings-nav"
        tabClassName={(isActive) => (isActive ? "is-active" : "")}
      />
      <section className="settings-content" role="tabpanel" id="settings-tabpanel" aria-labelledby={`settings-tab-${section}`} tabIndex={-1}>
        {section === "general" && <>
          <h3>{t("settings.general")}</h3>
          <Row id="settings-language" label={t("settings.language")} description={t("settings.languageDesc")}>
            <CustomSelect id="settings-language" value={locale} options={localeOptions} onChange={(next) => { setLocale(next); patch({ locale: next }); }} triggerClassName="w-[180px]" />
          </Row>
          <Row id="settings-density" label={t("settings.density")} description={t("settings.densityDesc")}>
            <CustomSelect id="settings-density" value={preferences.appearance.density} options={[{ value: "comfortable", label: t("settings.comfortable") }, { value: "compact", label: t("settings.compact") }]} onChange={(density) => patch({ appearance: { ...preferences.appearance, density } })} triggerClassName="w-[180px]" />
          </Row>
        </>}
        {section === "appearance" && <>
          <h3>{t("settings.appearance")}</h3>
          <Row id="settings-reduce-motion" label={t("settings.reduceMotion")} description={t("settings.reduceMotionDesc")}>{bool("settings-reduce-motion", preferences.appearance.reduceMotion, (value) => patch({ appearance: { ...preferences.appearance, reduceMotion: value } }))}</Row>
          <Row id="settings-theme" label={t("settings.theme")} description={t("settings.themeDesc")}>
            <CustomSelect id="settings-theme" value={preferences.theme} options={[{ value: "light", label: t("theme.light") }, { value: "dark", label: t("theme.dark") }, { value: "system", label: t("theme.system") }]} onChange={(theme) => patch({ theme })} triggerClassName="w-[180px]" />
          </Row>
        </>}
        {section === "chat" && <>
          <h3>{t("settings.chat")}</h3>
          <Row id="settings-enter-to-send" label={t("settings.enterToSend")} description={t("settings.enterToSendDesc")}>{bool("settings-enter-to-send", preferences.chat.enterToSend, (value) => toggle("enterToSend", value))}</Row>
          <Row id="settings-timestamps" label={t("settings.timestamps")} description={t("settings.timestampsDesc")}>{bool("settings-timestamps", preferences.chat.showTimestamps, (value) => toggle("showTimestamps", value))}</Row>
          <Row id="settings-stream" label={t("settings.stream")} description={t("settings.streamDesc")}>{bool("settings-stream", preferences.chat.streamResponses, (value) => toggle("streamResponses", value))}</Row>
          <Row id="settings-compact-messages" label={t("settings.compactMessages")} description={t("settings.compactMessagesDesc")}>{bool("settings-compact-messages", preferences.chat.compactMessages, (value) => toggle("compactMessages", value))}</Row>
        </>}
        {section === "server" && <>
          <h3>{t("settings.server")}</h3>
          <Row id="settings-auto-start" label={t("settings.autoStart")} description={t("settings.autoStartDesc")}>{bool("settings-auto-start", preferences.server.autoStart, (value) => patch({ server: { ...preferences.server, autoStart: value } }))}</Row>
          <Row id="settings-auto-stop" label={t("settings.autoStop")} description={t("settings.autoStopDesc")}>{bool("settings-auto-stop", preferences.server.autoStopOnExit, (value) => patch({ server: { ...preferences.server, autoStopOnExit: value } }))}</Row>
          <Row id="settings-polling" label={t("settings.polling")} description={t("settings.pollingDesc")}>
            <CustomSelect id="settings-polling" value={preferences.server.pollIntervalMs} options={[{ value: 500, label: "500 ms" }, { value: 1000, label: "1 s" }, { value: 2000, label: "2 s" }, { value: 5000, label: "5 s" }]} onChange={(pollIntervalMs) => patch({ server: { ...preferences.server, pollIntervalMs } })} triggerClassName="w-[180px]" />
          </Row>
        </>}
        {section === "advanced" && <>
          <h3>{t("settings.advanced")}</h3>
          <Row id="settings-developer-mode" label={t("settings.developerMode")} description={t("settings.developerModeDesc")}>{bool("settings-developer-mode", preferences.advanced.developerMode, (value) => patch({ advanced: { ...preferences.advanced, developerMode: value } }))}</Row>
          <Row id="settings-confirm-destructive" label={t("settings.confirmDestructive")} description={t("settings.confirmDestructiveDesc")}>{bool("settings-confirm-destructive", preferences.advanced.confirmDestructiveActions, (value) => patch({ advanced: { ...preferences.advanced, confirmDestructiveActions: value } }))}</Row>
          <div className="settings-danger"><strong>{t("settings.reset")}</strong><p>{t("settings.resetDesc")}</p><button type="button" className="app-button app-button--danger" onClick={() => setConfirmReset(true)}>{t("settings.resetAction")}</button></div>
          {ioError && <div className="settings-danger" role="alert"><strong>{ioError}</strong></div>}
          <div className="settings-note"><strong>{t("settings.backupTitle")}</strong><p>{t("settings.backupDescription")}</p><div className="mt-3 flex flex-wrap gap-2.5"><button type="button" className="app-button app-button--secondary" onClick={downloadExport}>{t("settings.export")}</button><label className="app-button app-button--secondary cursor-pointer">{t("settings.import")}
<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><button type="button" className="app-button app-button--secondary" onClick={() => update({ chat: defaultPreferences().chat })}>{t("settings.resetChat")}</button><button type="button" className="app-button app-button--secondary" onClick={() => update({ server: defaultPreferences().server })}>{t("settings.resetServer")}</button><button type="button" className="app-button app-button--secondary" onClick={() => update({ appearance: defaultPreferences().appearance, theme: defaultPreferences().theme })}>{t("settings.resetAppearance")}</button><button type="button" className="app-button app-button--secondary" onClick={() => update({ advanced: defaultPreferences().advanced })}>{t("settings.resetAdvanced")}</button></div></div>
          <div className="settings-danger"><strong>{ut(locale, "wipeDataTitle")}</strong><p>{ut(locale, "wipeDataDescription")}</p><button type="button" className="app-button app-button--danger" disabled={wiping} onClick={() => setConfirmWipe(true)}>{ut(locale, "wipeDataAction")}</button></div>
          <div className="settings-note"><strong>{t("settings.nativeTitle")}</strong><p>{t("settings.nativeMessage")}</p></div>
        </>}
      </section>
    </div>
    <div className="settings-wipe-slot">
      {wipeNotice && <div className="settings-note" role="status"><strong>{wipeNotice}</strong></div>}
    </div>
    <ConfirmDialog
      open={confirmWipe}
      title={ut(locale, "wipeDataConfirmTitle")}
      description={ut(locale, "wipeDataConfirmBody")}
      confirmLabel={ut(locale, "wipeDataAction")}
      cancelLabel={t("common.cancel")}
      busy={wiping}
      onConfirm={() => void wipeConversationData()}
      onCancel={() => { if (!wiping) setConfirmWipe(false); }}
    />
    <ConfirmDialog open={confirmReset} title={t("settings.resetTitle")} description={t("settings.resetMessage")} confirmLabel={t("settings.resetAction")} onConfirm={() => { reset(); setConfirmReset(false); }} onCancel={() => setConfirmReset(false)} />
  </div>;
}
