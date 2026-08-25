const PROJECTOR_BLOCKED_STATES = new Set(["starting", "running", "stopping"]);

export function projectorChangeAllowed(state: string): boolean {
  return !PROJECTOR_BLOCKED_STATES.has(state);
}
