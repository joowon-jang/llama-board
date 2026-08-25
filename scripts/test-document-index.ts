import assert from "node:assert/strict";
import { boundedIndexRecords, documentFingerprint, indexRecordForChunks, mergeCachedVectors, type DocumentIndexRecord } from "../src/documentIndex.ts";
import type { DocumentAttachment, DocumentChunk } from "../src/chatUtils.ts";

const document: DocumentAttachment = {
  name: "notes.md",
  path: "C:/safe/notes.md",
  text: "alpha\nbeta\ngamma",
};
const chunks: DocumentChunk[] = [
  { document, text: "alpha", score: 0, order: 0, offset: 0 },
  { document, text: "beta", score: 0, order: 1, offset: 6 },
];
const fingerprint = documentFingerprint(document.text);
assert.equal(fingerprint, documentFingerprint(document.text));
assert.notEqual(fingerprint, documentFingerprint(`${document.text}!`));

const record = indexRecordForChunks("model-a", chunks, [[1, 0], [0, 1]], 100, "endpoint-a");
assert.equal(record.model, "model-a");
assert.equal(record.path, document.path);
assert.equal(record.fingerprint, fingerprint);
assert.equal(record.namespace, "endpoint-a");
assert.equal(record.vectors.length, 2);

const cached: DocumentIndexRecord[] = [record];
assert.deepEqual(mergeCachedVectors("model-a", chunks, cached, "endpoint-a"), [[1, 0], [0, 1]]);
assert.equal(mergeCachedVectors("model-a", chunks, cached, "endpoint-b"), null);
assert.equal(mergeCachedVectors("model-b", chunks, cached), null);
assert.equal(mergeCachedVectors("model-a", [{ ...chunks[0], document: { ...document, text: "changed" } }], cached), null);

const bounded = boundedIndexRecords(Array.from({ length: 260 }, (_, index) => ({ ...record, key: `key-${index}`, updatedAt: index })));
assert.equal(bounded.records.length, 256);
assert.deepEqual(bounded.removedKeys, ["key-0", "key-1", "key-2", "key-3"]);
console.log("document index tests passed");
