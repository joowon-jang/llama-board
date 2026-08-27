export default function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return <span className={`app-status-badge app-status-badge--${tone}`}><span aria-hidden="true" />{label}</span>;
}