import assert from "node:assert/strict";
import { buildDocumentContext, buildVectorDocumentContext, documentChunksExceedSearchLimit, estimateTextTokens, MAX_SEARCHABLE_DOCUMENT_CHUNKS, rankDocumentChunks, splitDocumentChunks, type DocumentAttachment } from "../src/chatUtils.ts";

const document: DocumentAttachment = {
  name: "notes.md",
  path: "C:/safe/notes.md",
  text: "alpha\nbeta",
};
assert.equal(buildDocumentContext([document]), "\n\n[Attached document: notes.md]\nalpha\nbeta\n[/Attached document]");
const long: DocumentAttachment = { ...document, text: "x".repeat(20_000) };
const context = buildDocumentContext([long], 100);
assert.ok(context.length < 500);
assert.match(context, /Attached document: notes\.md/);
const ranked = rankDocumentChunks([{ ...long, text: "unrelated ".repeat(250) + "needle " + "other ".repeat(250) }], "needle");
assert.equal(ranked[0].text.includes("needle"), true);
const vectorDocument: DocumentAttachment = { name: "vector.md", path: "C:/safe/vector.md", text: "first\nsecond" };
const vectorChunks = splitDocumentChunks([vectorDocument], 6);
const vectorContext = buildVectorDocumentContext(vectorChunks, [[1, 0], [0, 1], [0, 1]], 2, 500);
assert.ok(vectorContext?.includes("second"));
assert.ok(estimateTextTokens("한글 테스트") > estimateTextTokens("test"));

// A document past the 64-chunk (~115KB at the default 1800-char chunk size)
// vector-search limit must be flagged so the UI can warn the user instead of
// silently dropping the tail of the document from retrieval.
const oversizedDocument: DocumentAttachment = { name: "big.md", path: "C:/safe/big.md", text: "x".repeat(200_000) };
assert.equal(splitDocumentChunks([oversizedDocument]).length > MAX_SEARCHABLE_DOCUMENT_CHUNKS, true);
assert.equal(documentChunksExceedSearchLimit([oversizedDocument]), true);
assert.equal(documentChunksExceedSearchLimit([document]), false);
console.log("document context tests passed");
