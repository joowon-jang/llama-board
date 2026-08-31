import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface CustomSelectOption<T extends string | number = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface CustomSelectProps<T extends string | number = string> {
  id?: string;
  name?: string;
  value: T;
  options: CustomSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  size?: "sm" | "md";
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  opensAbove: boolean;
}

export function CustomSelect<T extends string | number = string>({
  id,
  name,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  triggerClassName = "",
  menuClassName = "",
  ariaLabel,
  ariaDescribedBy,
  size = "md",
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuPosition, setMenuPosition] = useState<DropdownPosition | null>(null);
  const selected = options.find((opt) => opt.value === value) || options[0];
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const typeaheadRef = useRef<{ query: string; timer: ReturnType<typeof setTimeout> | null }>({ query: "", timer: null });

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const edge = 8;
    const gap = 4;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - edge - gap);
    const spaceAbove = Math.max(0, rect.top - edge - gap);
    const opensAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const availableSpace = opensAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(64, Math.min(240, availableSpace || 64));
    const width = Math.min(rect.width, Math.max(0, window.innerWidth - edge * 2));
    const maxLeft = Math.max(edge, window.innerWidth - edge - width);

    setMenuPosition({
      top: opensAbove ? rect.top - gap : rect.bottom + gap,
      left: Math.min(Math.max(edge, rect.left), maxLeft),
      width,
      maxHeight,
      opensAbove,
    });
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setIsOpen(false);
    }
    if (isOpen) {
      document.addEventListener("pointerdown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    // Keyboard navigation only moves the highlight while open; re-seed it from the
    // committed value each time the listbox opens so a previous preview never leaks in.
    setHighlightedIndex(options.findIndex((opt) => opt.value === value));
    updateMenuPosition();
    const handleViewportChange = () => updateMenuPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, updateMenuPosition]);

  /** Finds the next enabled option at or after `from` (wrapping), matching `predicate`. */
  const findEnabledOption = (from: number, step: number, predicate: (opt: CustomSelectOption<T>) => boolean) => {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = ((from + step * offset) % options.length + options.length) % options.length;
      if (!options[index].disabled && predicate(options[index])) return index;
    }
    return -1;
  };

  const commitHighlighted = () => {
    const option = options[highlightedIndex];
    if (option && !option.disabled) onChange(option.value);
    setIsOpen(false);
  };

  const handleTypeahead = (char: string) => {
    const buffer = typeaheadRef.current;
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.query = `${buffer.query}${char.toLowerCase()}`;
    buffer.timer = setTimeout(() => { buffer.query = ""; }, 700);
    const matches = (opt: CustomSelectOption<T>) => opt.label.toLocaleLowerCase().startsWith(buffer.query);
    const searchFrom = isOpen ? highlightedIndex + 1 : selectedIndex + 1;
    let match = findEnabledOption(searchFrom, 1, matches);
    // A repeated single letter (e.g. "d", "d") should still find something even if
    // it only matches the option already active, so retry from the start once.
    if (match === -1 && buffer.query.length > 1) match = findEnabledOption(0, 1, matches);
    if (match === -1) return;
    if (isOpen) setHighlightedIndex(match);
    else onChange(options[match].value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setIsOpen(true);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handleTypeahead(e.key);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = findEnabledOption(highlightedIndex + 1, 1, () => true);
      if (next !== -1) setHighlightedIndex(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = findEnabledOption(highlightedIndex - 1, -1, () => true);
      if (prev !== -1) setHighlightedIndex(prev);
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = findEnabledOption(0, 1, () => true);
      if (first !== -1) setHighlightedIndex(first);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = findEnabledOption(options.length - 1, -1, () => true);
      if (last !== -1) setHighlightedIndex(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commitHighlighted();
    } else if (e.key === "Tab") {
      setIsOpen(false);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      handleTypeahead(e.key);
    }
  };

  const isSm = size === "sm";

  return (
    <div
      ref={containerRef}
      className={`app-custom-select-container relative inline-block text-left ${className}`}
      onKeyDown={handleKeyDown}
    >
      <select
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        className="sr-only"
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={isOpen && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        className={`app-custom-select-trigger ${
          isSm ? "app-custom-select-trigger--sm" : "app-custom-select-trigger--md"
        } ${triggerClassName}`}
      >
        <span className="truncate flex items-center gap-1.5 min-w-0">
          {selected?.icon}
          <span className="truncate">{selected?.label ?? String(value)}</span>
        </span>
        <svg
          className={`shrink-0 text-slate-400 transition-transform duration-150 ${isSm ? "h-3 w-3" : "h-3.5 w-3.5"} ${
            isOpen ? "rotate-180 text-slate-200" : ""
          }`}
          fill="none"
          viewBox="0 0 20 20"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m6 8 4 4 4-4" />
        </svg>
      </button>

      {isOpen && menuPosition && createPortal(
        <ul
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`app-custom-dropdown-menu ${menuClassName}`}
          style={{
            top: menuPosition.top,
            left: menuPosition.left,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
            transform: menuPosition.opensAbove ? "translateY(-100%)" : undefined,
          }}
        >
          {options.map((opt, index) => {
            const isSelected = opt.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={String(opt.value)}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                className={`app-custom-dropdown-item ${isSelected || isHighlighted ? "is-selected" : ""} ${opt.disabled ? "opacity-40 cursor-not-allowed pointer-events-none" : ""}`}
              >
                <span className="truncate flex items-center gap-2 min-w-0">
                  {opt.icon}
                  <span className="truncate">{opt.label}</span>
                </span>
                {isSelected && (
                  <svg className="app-custom-dropdown-check h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </div>
  );
}
