export interface ModelRowKeyEvent {
  key: string;
  stopPropagation: () => void;
}

export function suppressModelRowSelection(event: ModelRowKeyEvent): void {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}
