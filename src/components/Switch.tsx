interface SwitchProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
}

/**
 * A real toggle switch rather than a stretched checkbox.
 *
 * `<button>` is a labelable element, so the surrounding `<label for>` still
 * supplies the accessible name and still toggles on click.
 */
export default function Switch({ id, checked, onChange, disabled, "aria-describedby": describedBy }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="app-switch"
    >
      <span className="app-switch__thumb" aria-hidden="true" />
    </button>
  );
}
