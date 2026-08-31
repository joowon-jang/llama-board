import type * as api from "../api";
import type { UiTextKey } from "../uiI18n";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";

/**
 * What the user is agreeing to. Building a pull request compiles and runs code
 * written by whoever opened it, so the dialog names them, the repository the
 * code actually comes from, the branch, and the exact commit — rather than
 * only the PR number the user typed, which says nothing about any of that.
 */
export default function PullRequestProvenance({ t, preview, backend }: { t: (key: UnifiedKey, vars?: TranslationVars) => string; preview: api.PullRequestPreview; backend: string }) {
  const rows: [string, string][] = [
    [t("ui.prFieldTitle"), preview.title || "—"],
    [t("ui.prFieldAuthor"), preview.author || "—"],
    [t("ui.prFieldRepository"), preview.repository],
    [t("ui.prFieldHeadRef"), preview.head_ref || "—"],
    [t("ui.prFieldCommit"), preview.commit],
    [t("ui.prFieldState"), preview.draft ? t("ui.prStateDraft", { state: preview.state }) : preview.state],
    [t("ui.prFieldUpdated"), preview.updated_at || "—"],
    [t("ui.prFieldBackend"), backend],
  ];
  // The backend decides which of these apply; the frontend only translates
  // them, so a new state never silently renders as nothing.
  const advisoryText: Record<api.PrAdvisory, UiTextKey> = {
    draft: "prAdvisoryDraft",
    closed: "prAdvisoryClosed",
    merged: "prAdvisoryMerged",
    // Rendered with the repository name and its own emphasis, below.
    fork: "prForkWarning",
    "no-head-ref": "prAdvisoryNoHeadRef",
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-300">{t("ui.prConfirmBody", { pr: preview.pull_request })}</p>
      {/* Defensive: a preview from an older backend carries no advisories, and
          a crashed dialog would be a worse failure than a missing warning. */}
      {(preview.advisories ?? []).map((advisory) => (
        <p key={advisory} className={`rounded-lg border px-2.5 py-2 text-xs ${advisory === "fork" ? "border-amber-700 bg-amber-950/40 text-amber-200" : "app-border-strongest bg-slate-900/60 text-slate-300"}`}>
          {advisory === "fork" ? t("ui.prForkWarning", { repository: preview.repository }) : t(`ui.${advisoryText[advisory] ?? "prAdvisoryUnknown"}`, { advisory })}
        </p>
      ))}
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-500">{label}</dt>
            <dd className="min-w-0 break-all font-mono text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      {/* L5: say exactly what the build produces, so "build this PR" is not an
          open-ended promise. Mirrors SOURCE_BUILD_TARGETS in runtime.rs. */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-2.5 py-2">
        <p className="text-[11px] font-medium text-slate-300">{t("ui.prBuildPlanTitle")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-slate-400">
          <li>{t("ui.prBuildPlanTargets")}</li>
          <li>{t("ui.prBuildPlanWebui")}</li>
          <li>{t("ui.prBuildPlanOffline")}</li>
          {backend === "cuda" && <li>{t("ui.prBuildPlanCuda", { variable: "LLAMA_BOARD_CUDA_ARCHITECTURES" })}</li>}
        </ul>
      </div>
      {preview.artifact ? (
        <p className="rounded-lg border app-border-success bg-emerald-950/40 px-2.5 py-2 text-[11px] text-emerald-200">
          {t("ui.prPrebuiltAvailable", {
            name: preview.artifact.name,
            size: (preview.artifact.bytes / 1048576).toFixed(1),
          })}
          <span className="mt-1 block break-all font-mono text-[10px] text-emerald-300/70">SHA-256: {preview.artifact.sha256}</span>
        </p>
      ) : (
        <p className="rounded-lg border border-slate-700 bg-slate-900/50 px-2.5 py-2 text-[11px] text-slate-400">{t("ui.prLocalBuildRequired")}</p>
      )}
      {preview.artifact_error && <p className="rounded-lg border border-amber-700 bg-amber-950/40 px-2.5 py-2 text-[11px] text-amber-200">{t("ui.prArtifactLookupFailed", { error: preview.artifact_error })}</p>}
      <p className="text-[11px] text-slate-500">{t("ui.prReplaceNote", { pr: preview.pull_request, backend })}</p>
      {backend === "rocm" && <p className="rounded-lg border border-amber-700 bg-amber-950/40 px-2.5 py-2 text-[11px] text-amber-200">{t("ui.prRocmLocalOnly")}</p>}
      <p className="text-[11px] text-slate-500">{t("ui.prIntegrityNote")}</p>
    </div>
  );
}
