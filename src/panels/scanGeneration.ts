export function nextScanGeneration(current: number): number {
  return current + 1;
}

export function isCurrentScan(generation: number, current: number): boolean {
  return generation === current;
}
