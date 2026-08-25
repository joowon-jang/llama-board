const SAFE_HF_COMPONENT = /^[^<>:"|?*\u0000-\u001f]+$/;

export function validateHfRepoId(value: string): boolean {
  const repo = value.trim();
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part));
}

export function validateHfPath(value: string): boolean {
  const path = value.trim();
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && SAFE_HF_COMPONENT.test(part) && !part.endsWith(".") && !part.endsWith(" "));
}

export function isGgufPath(path: string): boolean {
  return path.toLowerCase().endsWith(".gguf");
}

export function isMmprojPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  return name.startsWith("mmproj") && isGgufPath(name);
}

export function quantLabel(path: string): string {
  const name = path.split("/").pop() ?? path;
  const match = name.match(/(?:^|[-_])(Q\d+(?:_[A-Z0-9]+)*|IQ\d+(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_.]|$)/i);
  return match?.[1]?.toUpperCase() ?? "unknown";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
