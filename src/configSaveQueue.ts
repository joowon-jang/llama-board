export type ConfigPatch<T extends object> = Partial<T> | ((current: T) => Partial<T>);

export function createConfigSaveQueue<T extends object>(
  getCurrent: () => T | null,
  publish: (value: T) => void,
  persist: (value: T) => Promise<T>,
  onFailure: (error: unknown) => void,
): (patch: ConfigPatch<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return (patch: ConfigPatch<T>) => {
    const operation = tail.catch(() => undefined).then(async () => {
      const previous = getCurrent();
      if (!previous) {
        const error = new Error("Configuration is still loading.");
        onFailure(error);
        throw error;
      }

      const resolvedPatch = typeof patch === "function" ? patch(previous) : patch;
      const next = { ...previous, ...resolvedPatch } as T;
      publish(next);
      try {
        const saved = await persist(next);
        publish(saved);
        return saved;
      } catch (error) {
        publish(previous);
        onFailure(error);
        throw error;
      }
    });
    tail = operation.catch(() => undefined);
    return operation;
  };
}
