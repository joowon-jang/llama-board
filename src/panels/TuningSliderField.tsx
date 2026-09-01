import type { ChangeEvent, FocusEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";

export interface TuningSliderFieldDescriptor {
  key?: string;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
  labelExtra?: ReactNode;
  valueMeta?: ReactNode;
}

export interface TuningSliderFieldProps {
  /** Optional field metadata keeps the control convenient for catalog-backed fields. */
  field?: TuningSliderFieldDescriptor;
  /** Explicit values are useful for controls that are not in tuningFields.ts. */
  id?: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void | Promise<void>;
  labelExtra?: ReactNode;
  valueMeta?: ReactNode;
}

function finiteValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A range input paired with a text-friendly numeric input.  The text input is
 * deliberately controlled by the caller so intermediate values such as `-`
 * remain editable; the range falls back to the nearest valid endpoint until a
 * completed value is entered.
 */
export default function TuningSliderField({
  field,
  id,
  label,
  min,
  max,
  step,
  hint,
  value,
  disabled = false,
  onChange,
  onCommit,
  labelExtra,
  valueMeta,
}: TuningSliderFieldProps) {
  const resolvedLabel = label ?? field?.label ?? field?.key ?? "Value";
  const resolvedMin = min ?? field?.min ?? 0;
  const resolvedMax = max ?? field?.max ?? 100;
  const resolvedStep = step ?? field?.step ?? 1;
  const inputId = id ?? `tuning-${field?.key ?? "value"}`;
  const labelId = `${inputId}-label`;
  const resolvedHint = hint ?? field?.hint;
  const hintId = resolvedHint ? `${inputId}-hint` : undefined;
  const rangeValue = Math.min(resolvedMax, Math.max(resolvedMin, finiteValue(value, resolvedMin)));

  const commit = (event: FocusEvent<HTMLInputElement> | PointerEvent<HTMLInputElement>) => {
    onCommit(event.currentTarget.value);
  };

  const commitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  const update = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.currentTarget.value);
  };

  return (
    <div className="tuning-slider-field">
      <div className="tuning-slider-field__header">
        <div className="tuning-slider-field__label-wrap">
          <label id={labelId} htmlFor={inputId} className="tuning-slider-field__label">{resolvedLabel}</label>
          {labelExtra}
        </div>
        <div className="tuning-slider-field__value-wrap">
          <output className="tuning-slider-field__value" htmlFor={inputId}>{value}</output>
          {valueMeta}
        </div>
      </div>
      <div className="tuning-slider-field__controls">
        <input
          id={`${inputId}-range`}
          type="range"
          min={resolvedMin}
          max={resolvedMax}
          step={resolvedStep}
          value={rangeValue}
          onChange={update}
          onBlur={commit}
          onPointerUp={commit}
          onKeyDown={commitOnEnter}
          disabled={disabled}
          aria-label={`${resolvedLabel} slider`}
          aria-describedby={hintId}
          className="tuning-slider-field__range"
        />
        <input
          id={inputId}
          type="number"
          inputMode={resolvedStep < 1 ? "decimal" : "numeric"}
          value={value}
          min={resolvedMin}
          max={resolvedMax}
          step={resolvedStep}
          onChange={update}
          onBlur={commit}
          onKeyDown={commitOnEnter}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          className="tuning-slider-field__number"
        />
      </div>
      {resolvedHint && <span id={hintId} className="tuning-slider-field__hint">{resolvedHint}</span>}
    </div>
  );
}

export { TuningSliderField };
