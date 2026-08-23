import { consumeAnthropicStream } from "./anthropic-sse";
import { consumeOpenAIStream } from "./sse";
import type { ChatRequest, StreamEvent } from "../types/chat";

function endpoint(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

async function readError(response: Response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return parsed.error?.message || parsed.message || text;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

export async function streamChat(request: ChatRequest, onEvent: (event: StreamEvent) => void) {
  const isAnthropic = request.provider === "anthropic";
  const url = isAnthropic ? endpoint(request.baseUrl, "/v1/messages") : endpoint(request.baseUrl, "/chat/completions");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = request.apiKey || "";
    headers["anthropic-version"] = request.anthropicVersion || "2023-06-01";
  } else if (request.apiKey) {
    headers.Authorization = `Bearer ${request.apiKey}`;
  }
  const body = isAnthropic
    ? {
        model: request.model,
        system: request.system || undefined,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stream: true,
      }
    : {
        model: request.model,
        messages: [
          ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
          ...request.messages,
        ],
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stream: true,
      };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
  if (!response.ok) throw new Error(await readError(response));
  if (isAnthropic) {
    await consumeAnthropicStream(response, onEvent);
  } else {
    await consumeOpenAIStream(response, onEvent);
  }
}

export async function getModels(baseUrl: string, apiKey?: string) {
  const response = await fetch(endpoint(baseUrl, "/models"), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as { data?: Array<{ id: string }> };
}

export async function waitForEndpoint(baseUrl: string, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = "Endpoint unavailable";
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await fetch(endpoint(baseUrl.replace(/\/v1$/, ""), "/health"));
      if (health.ok) {
        const models = await getModels(baseUrl);
        return models.data?.[0]?.id || "local-model";
      }
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(lastError);
}
