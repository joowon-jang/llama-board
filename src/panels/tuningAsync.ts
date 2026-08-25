export function draftStillCurrent(current: string | undefined, submitted: string): boolean {
  return current === submitted;
}

export function canRollbackAtRevision(startRevision: number, currentRevision: number): boolean {
  return startRevision === currentRevision;
}
