import { useRef, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { TUNING_CONTENT_PANEL_ID, type TuningCategory, type TuningCategoryId, type TuningViewMode } from "./tuningFields";

const MODES: readonly TuningViewMode[] = ["quick", "advanced"];

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="8.5" cy="8.5" r="4.5" />
      <path d="m12 12 4 4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

interface Props {
  categories: readonly TuningCategory[];
  activeCategory: TuningCategoryId;
  onSelectCategory: (category: TuningCategoryId) => void;
  mode: TuningViewMode;
  onModeChange: (mode: TuningViewMode) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

/** Tuning navigation shell; the panel supplies field-level slices to each section. */
export default function TuningNavigation({
  categories, activeCategory, onSelectCategory, mode, onModeChange, query, onQueryChange,
}: Props) {
  const { t } = useI18n();
  const modeTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const categoryRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = MODES.indexOf(mode);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % MODES.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + MODES.length) % MODES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = MODES.length - 1;
    else return;
    event.preventDefault();
    onModeChange(MODES[nextIndex]);
    modeTabRefs.current[nextIndex]?.focus();
  };

  const handleCategoryKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % categories.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + categories.length) % categories.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = categories.length - 1;
    else return;
    event.preventDefault();
    onSelectCategory(categories[nextIndex].id);
    categoryRefs.current[nextIndex]?.focus();
  };

  return (
    <aside className="tuning-navigation" aria-label={t("extra.tuningNavigationLabel")}>
      <div
        className="tuning-navigation__mode"
        role="tablist"
        aria-label={t("extra.tuningDetailLevel")}
        onKeyDown={handleModeKeyDown}
      >
        {MODES.map((value, index) => {
          const isActive = mode === value;
          return (
            <button
              key={value}
              ref={(el) => { modeTabRefs.current[index] = el; }}
              type="button"
              id={`tuning-mode-tab-${value}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={TUNING_CONTENT_PANEL_ID}
              tabIndex={isActive ? 0 : -1}
              className={`tuning-mode-tab ${isActive ? "is-active" : ""}`}
              onClick={() => onModeChange(value)}
            >
              {value === "quick" ? t("extra.quickMode") : t("extra.advancedMode")}
            </button>
          );
        })}
      </div>

      <div className="tuning-navigation__search">
        <label className="sr-only" htmlFor="tuning-settings-search">{t("extra.searchTuningSettingsLabel")}</label>
        <span className="tuning-navigation__search-icon" aria-hidden="true"><SearchIcon /></span>
        <input
          id="tuning-settings-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("extra.searchSettingsPlaceholder")}
          aria-label={t("extra.searchTuningSettingsLabel")}
          data-tuning-search
        />
        {query && (
          <button
            type="button"
            className="tuning-navigation__search-clear"
            aria-label={t("extra.clearTuningSearch")}
            onClick={() => onQueryChange("")}
          >
            <ClearIcon />
          </button>
        )}
      </div>

      <div className="tuning-navigation__caption">{t("extra.categories")}</div>
      <nav className="tuning-navigation__categories" aria-label={t("extra.tuningCategoriesLabel")}>
        {categories.map((category, index) => {
          const isActive = category.id === activeCategory;
          return (
            <button
              key={category.id}
              ref={(el) => { categoryRefs.current[index] = el; }}
              type="button"
              className={`tuning-category-link ${isActive ? "is-active" : ""}`}
              aria-current={isActive ? "page" : undefined}
              aria-controls={TUNING_CONTENT_PANEL_ID}
              tabIndex={isActive ? 0 : -1}
              title={t(`extra.${category.descriptionKey}` as never) || category.description}
              onClick={() => onSelectCategory(category.id)}
              onKeyDown={(event) => handleCategoryKeyDown(event, index)}
              data-tuning-category={category.id}
            >
              <span className="tuning-category-link__label">{t(`extra.${category.labelKey}` as never) || category.label}</span>
              <span className="tuning-category-link__chevron"><ChevronIcon /></span>
            </button>
          );
        })}
        {categories.length === 0 && (
          <p className="tuning-navigation__empty">{t("extra.noMatchingSettings")}</p>
        )}
      </nav>
    </aside>
  );
}

export type { Props as TuningNavigationProps };
