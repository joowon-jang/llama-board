export function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function redactApiKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

export function buildCurlSnippet(baseUrl: string, path: string): string {
  return `curl ${endpointUrl(baseUrl, path)} \\\n  -H "Authorization: Bearer <LOCAL_API_KEY>" \\\n  -H "Content-Type: application/json"`;
}
