import type { ChatContentPart, ChatMessage } from "./api";
import type { JsonObject } from "./panels/tuningValidation";
import type { ChatCitation } from "./chatHistory";

export interface ImageAttachment {
  name: string;
  dataUrl: string;
}

export interface DocumentAttachment {
  name: string;
  path: string;
  text: string;
}

export interface DocumentChunk {
  document: DocumentAttachment;
  text: string;
  score: number;
  order: number;
  offset: number;
}

function queryTerms(query: string): string[] {
  return Array.from(new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).slice(0, 32)));
}

function chunkDocument(document: DocumentAttachment, size = 1800): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (let offset = 0, order = 0; offset < document.text.length; offset += size, order += 1) {
    chunks.push({ document, text: document.text.slice(offset, offset + size), score: 0, order, offset });
  }
  return chunks;
}

export function rankDocumentChunks(documents: DocumentAttachment[], query = ""): DocumentChunk[] {
  const terms = queryTerms(query);
  return documents
    .flatMap((document) => chunkDocument(document))
    .map((chunk) => {
      const lower = chunk.text.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total + (lower.match(new RegExp(escapeRegExp(term), "gu"))?.length ?? 0), 0);
      return { ...chunk, score };
    })
    .sort((left, right) => right.score - left.score || left.document.name.localeCompare(right.document.name) || left.order - right.order);
}

export function splitDocumentChunks(documents: DocumentAttachment[], size = 1800): DocumentChunk[] {
  return documents.flatMap((document) => chunkDocument(document, size));
}

export function buildVectorDocumentContext(
  chunks: DocumentChunk[],
  vectors: number[][],
  queryIndex: number,
  maxChars = 12_000,
): string | null {
  const ranked = rankVectorDocumentChunks(chunks, vectors, queryIndex);
  if (ranked.length === 0) return null;
  const sections: string[] = [];
  let used = 0;
  for (const item of ranked) {
    const section = `\n[Attached document: ${item.chunk.document.name} @ ${item.chunk.offset}]\n${item.chunk.text}\n[/Attached document]`;
    if (used + section.length > maxChars && sections.length > 0) continue;
    sections.push(section);
    used += section.length;
    if (used >= maxChars) break;
  }
  return sections.length ? `\n\nRelevant vector-retrieved context:${sections.join("")}` : null;
}

export interface RankedDocumentChunk {
  chunk: DocumentChunk;
  score: number;
}

export function rankVectorDocumentChunks(
  chunks: DocumentChunk[],
  vectors: number[][],
  queryIndex: number,
): RankedDocumentChunk[] {
  const query = vectors[queryIndex];
  if (!query || query.length === 0 || chunks.length === 0) return [];
  return chunks
    .map((chunk, index) => ({ chunk, score: cosineSimilarity(vectors[index] ?? [], query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score || left.chunk.order - right.chunk.order);
}

export function vectorDocumentSources(
  chunks: DocumentChunk[],
  vectors: number[][],
  queryIndex: number,
  limit = 4,
): string[] {
  return rankVectorDocumentChunks(chunks, vectors, queryIndex)
    .slice(0, Math.max(1, limit))
    .map(({ chunk, score }) => `${chunk.document.name} @ ${chunk.offset} (${score.toFixed(2)})`);
}

export function vectorDocumentCitations(
  chunks: DocumentChunk[],
  vectors: number[][],
  queryIndex: number,
  limit = 4,
): ChatCitation[] {
  return rankVectorDocumentChunks(chunks, vectors, queryIndex)
    .slice(0, Math.max(1, limit))
    .map(({ chunk, score }) => ({
      name: chunk.document.name,
      path: chunk.document.path,
      offset: chunk.offset,
      score: Number(score.toFixed(4)),
    }));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildDocumentContext(documents: DocumentAttachment[], maxChars = 12_000, query = ""): string {
  const budget = Math.max(256, Math.floor(maxChars));
  let used = 0;
  let context = "";
  const chunks = documents.length === 0 ? [] : documents.flatMap((document) => document.text.length <= budget ? [{ document, text: document.text, score: 0, order: 0, offset: 0 }] : rankDocumentChunks([document], query));
  for (const chunk of chunks) {
    const prefix = `\n\n[Attached document: ${chunk.document.name}]\n`;
    const suffix = "\n[/Attached document]";
    const remaining = budget - used - prefix.length - suffix.length;
    if (remaining <= 0) break;
    const text = chunk.text.slice(0, remaining);
    const truncated = text.length < chunk.text.length || chunk.document.text.length > chunk.text.length ? "\n[document excerpt truncated]" : "";
    context += `${prefix}${text}${truncated}${suffix}`;
    used = context.length;
  }
  return context;
}

export function buildMultimodalContent(text: string, images: ImageAttachment[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  if (text.trim()) parts.push({ type: "text", text: text.trim() });
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: image.dataUrl } });
  }
  return parts;
}

export function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ChatContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  let cjk = 0;
  for (const character of text) {
    if (/^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(character)) cjk += 1;
    else if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 2.5 + cjk / 1.8));
}

export function estimateMessageTokens(message: ChatMessage): number {
  const content = message.content;
  const textTokens = typeof content === "string" ? estimateTextTokens(content) : estimateTextTokens(contentText(content));
  const imageTokens = typeof content === "string" ? 0 : content.filter((part) => part.type === "image_url").length * 256;
  return Math.max(4, textTokens + imageTokens + 4);
}

export function estimateChatTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function capMaxTokens(options: JsonObject, promptTokens: number, contextSize: number): JsonObject {
  const next = { ...options };
  const requested = next.max_tokens;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) return next;
  const available = Math.max(1, Math.floor(contextSize - promptTokens - 64));
  next.max_tokens = Math.min(Math.floor(requested), available);
  return next;
}

function truncateMessage(message: ChatMessage, tokenBudget: number): ChatMessage {
  const budget = Math.max(4, Math.floor(tokenBudget));
  if (estimateMessageTokens(message) <= budget) return message;
  const source = typeof message.content === "string" ? message.content : contentText(message.content);
  const marker = "\n[context excerpt truncated]";
  let low = 0;
  let high = source.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateText = `${source.slice(0, middle)}${middle < source.length ? marker : ""}`;
    const candidate = { ...message, content: candidateText };
    if (estimateMessageTokens(candidate) <= budget) {
      best = candidateText;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { ...message, content: best };
}

export function trimChatHistory(
  messages: ChatMessage[],
  maxTokens: number,
  policy: "rollingWindow" | "truncateMiddle" = "rollingWindow",
): { messages: ChatMessage[]; trimmed: boolean } {
  const budget = Math.max(256, Math.floor(maxTokens));
  if (estimateChatTokens(messages) <= budget) return { messages, trimmed: false };

  const system = messages[0]?.role === "system" ? messages[0] : null;
  const systemBudget = Math.max(32, budget - 32);
  const boundedSystem = system && estimateMessageTokens(system) > systemBudget ? truncateMessage(system, systemBudget) : system;
  const rest = system ? messages.slice(1) : messages.slice();
  const turns: ChatMessage[][] = [];
  for (const message of rest) {
    if (message.role === "user") turns.push([message]);
    else if (turns.length > 0) turns[turns.length - 1].push(message);
  }
  const kept: ChatMessage[] = [];
  let used = boundedSystem ? estimateMessageTokens(boundedSystem) : 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const cost = estimateChatTokens(turn);
    if (kept.length > 0 && used + cost > budget) break;
    if (kept.length === 0 && used + cost > budget) {
      kept.unshift(truncateMessage(turn[0], budget - used));
      break;
    }
    kept.unshift(...turn);
    used += cost;
  }
  if (policy === "truncateMiddle" && turns.length > 1 && kept.length < rest.length) {
    const latest = turns[turns.length - 1];
    const first = turns[0];
    const candidate = [...first, ...latest];
    if (estimateChatTokens(candidate) + (boundedSystem ? estimateMessageTokens(boundedSystem) : 0) <= budget) {
      return { messages: boundedSystem ? [boundedSystem, ...candidate] : candidate, trimmed: true };
    }
  }
  return { messages: boundedSystem ? [boundedSystem, ...kept] : kept, trimmed: true };
}
