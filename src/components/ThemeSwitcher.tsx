import type { ThemeMode } from "../theme";
import { useI18n } from "../i18n";

export default function ThemeSwitcher({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const { t } = useI18n();
  return (
    <label className="app-theme-control">
      <span className="app-theme-label">{t("theme.label")}</span>
      <select
        aria-label={t("theme.label")}
        value={mode}
        onChange={(event) => onChange(event.target.value as ThemeMode)}
      >
        <option value="light">{t("theme.light")}</option>
        <option value="dark">{t("theme.dark")}</option>
        <option value="system">{t("theme.system")}</option>
      </select>
    </label>
  );
}

export type { ThemeMode };
