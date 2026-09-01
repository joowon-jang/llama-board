import { useEffect, useState } from "react";

export const SAMPLER_CHAIN_OPTIONS = [
  "dry",
  "top_k",
  "top_p",
  "min_p",
  "typ_p",
  "temperature",
  "dynatemp",
  "xtc",
  "penalties",
  "mirostat",
] as const;

export function normalizeSamplerChain(value: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const sampler = item.trim();
    if (!sampler || seen.has(sampler)) continue;
    seen.add(sampler);
    normalized.push(sampler);
  }
  return normalized.slice(0, 64);
}

export interface TuningSamplerChainProps {
  /** `value` is the controlled spelling; `samplers` is kept for direct use. */
  value?: readonly string[];
  samplers?: readonly string[];
  options?: readonly string[];
  disabled?: boolean;
  onChange?: (samplers: string[]) => void;
  onReorder?: (samplers: string[]) => void;
  onSamplersChange?: (samplers: string[]) => void;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const EMPTY_SAMPLER_CHAIN: readonly string[] = [];

/**
 * Ordered sampler-chain editor. Native drag events keep this dependency-free
 * for the desktop shell, while the adjacent move buttons make the same action
 * available to keyboard and touch users.
 */
export default function TuningSamplerChain({
  value,
  samplers,
  options = SAMPLER_CHAIN_OPTIONS,
  disabled = false,
  onChange,
  onReorder,
  onSamplersChange,
}: TuningSamplerChainProps) {
  const source = value ?? samplers ?? EMPTY_SAMPLER_CHAIN;
  const [draft, setDraft] = useState<string[]>(() => normalizeSamplerChain(source));
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [selectedToAdd, setSelectedToAdd] = useState("");

  useEffect(() => {
    const next = normalizeSamplerChain(value ?? samplers ?? EMPTY_SAMPLER_CHAIN);
    setDraft((current) => sameValues(current, next) ? current : next);
  }, [samplers, value]);

  const publish = (next: readonly string[]) => {
    const normalized = normalizeSamplerChain(next);
    setDraft(normalized);
    onChange?.(normalized);
    onReorder?.(normalized);
    onSamplersChange?.(normalized);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    [next[index], next[target]] = [next[target], next[index]];
    publish(next);
  };

  const drop = (targetIndex: number) => {
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    const next = [...draft];
    const [item] = next.splice(draggedIndex, 1);
    next.splice(targetIndex, 0, item);
    publish(next);
    setDraggedIndex(null);
  };

  const availableOptions = options.filter((option) => !draft.includes(option));

  return (
    <div className="tuning-sampler-chain" data-testid="tuning-sampler-chain">
      <div className="tuning-sampler-chain__header">
        <div>
          <h3 className="tuning-sampler-chain__title">Sampler chain</h3>
          <p className="tuning-sampler-chain__hint">Drag to reorder the stages used by llama.cpp for each request.</p>
        </div>
        <span className="tuning-sampler-chain__count">{draft.length} stages</span>
      </div>

      {draft.length > 0 ? (
        <div className="tuning-sampler-chain__list" role="list" aria-label="Sampler chain">
          {draft.map((sampler, index) => (
            <div
              key={sampler}
              role="listitem"
              className={`tuning-sampler-chip ${draggedIndex === index ? "is-dragging" : ""}`}
              draggable={!disabled}
              onDragStart={() => setDraggedIndex(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => drop(index)}
              onDragEnd={() => setDraggedIndex(null)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  move(index, -1);
                } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  move(index, 1);
                }
              }}
              tabIndex={disabled ? -1 : 0}
              data-sampler={sampler}
              data-testid={`sampler-chip-${sampler}`}
            >
              <span className="tuning-sampler-chip__grip" aria-hidden="true">⋮⋮</span>
              <span className="tuning-sampler-chip__name">{sampler}</span>
              <span className="tuning-sampler-chip__actions">
                <button type="button" onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={`Move ${sampler} earlier`}>←</button>
                <button type="button" onClick={() => move(index, 1)} disabled={disabled || index === draft.length - 1} aria-label={`Move ${sampler} later`}>→</button>
                <button type="button" onClick={() => publish(draft.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled} aria-label={`Remove ${sampler}`}>×</button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="tuning-sampler-chain__empty" role="status">No sampler override is saved; the runtime default chain is active.</p>
      )}

      <div className="tuning-sampler-chain__add">
        <label htmlFor="tuning-sampler-add" className="sr-only">Add sampler</label>
        <select
          id="tuning-sampler-add"
          value={selectedToAdd}
          onChange={(event) => setSelectedToAdd(event.target.value)}
          disabled={disabled || availableOptions.length === 0}
          className="app-input tuning-sampler-chain__select"
        >
          <option value="">Add sampler…</option>
          {availableOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <button
          type="button"
          className="app-button app-button--secondary app-button--sm"
          disabled={disabled || !selectedToAdd}
          onClick={() => {
            if (!selectedToAdd) return;
            publish([...draft, selectedToAdd]);
            setSelectedToAdd("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

export { TuningSamplerChain };
