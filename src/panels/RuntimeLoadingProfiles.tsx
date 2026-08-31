import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { normalizeDisplayPath } from "../lifecycleUtils";
import type { LoadingProfile } from "../runtimeUtils";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  profiles: LoadingProfile[];
  profileName: string;
  onProfileNameChange: (value: string) => void;
  onSave: () => void;
  onApply: (profile: LoadingProfile) => void;
  onRemove: (profile: LoadingProfile) => void;
  canSave: boolean;
  serverRunning: boolean;
}

/** Presentational: the "Loading profiles" card on the Runtimes panel. */
export default function RuntimeLoadingProfiles({
  t, profiles, profileName, onProfileNameChange, onSave, onApply, onRemove, canSave, serverRunning,
}: Props) {
  return (
    <section className="mb-4 rounded-xl border border-slate-700 app-bg-muted p-4" aria-labelledby="loading-profiles-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="loading-profiles-heading" className="app-section-title">{t("ui.loadingProfiles")}</h2>
          <p className="app-section-hint">{t("ui.loadingProfilesHint")}</p>
        </div>
        <div className="flex min-w-[16rem] max-w-full gap-2">
          <input value={profileName} onChange={(event) => onProfileNameChange(event.target.value)} placeholder={t("ui.profileNamePlaceholder")} className="app-input min-w-0 flex-1" />
          <button type="button" onClick={onSave} disabled={!canSave || serverRunning} title={serverRunning ? t("ui.serverRunningHint") : undefined} className="app-button app-button--secondary app-button--sm shrink-0">{t("ui.saveCurrent")}</button>
        </div>
      </div>
      {profiles.length === 0 && <p className="mt-3 text-xs text-slate-600">{t("ui.noProfiles")}</p>}
      <div className="mt-3.5 grid gap-3 md:grid-cols-2">
        {profiles.map((profile) => (
          <div key={profile.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-slate-200">{profile.name}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={normalizeDisplayPath(profile.active_model)}>{profile.backend || "system"} {profile.build || "PATH"} · {profile.ctx_size.toLocaleString()} ctx · {profile.ngl} layers</div>
              </div>
              <button type="button" onClick={() => onRemove(profile)} className="app-icon-button app-icon-button--danger" aria-label={`${t("panel.delete")}: ${profile.name}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button>
            </div>
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={() => onApply(profile)} disabled={serverRunning} title={serverRunning ? t("ui.stopBeforeProfile") : undefined} className="app-button app-button--primary app-button--sm">{t("ui.applyProfile")}</button>
              <span className="self-center text-[10px] text-slate-600">flash-attn: {profile.flash_attn}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
