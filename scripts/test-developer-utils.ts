import assert from "node:assert/strict";
import { buildCurlSnippet, endpointUrl, redactApiKey } from "../src/developerUtils.ts";

assert.equal(endpointUrl("http://127.0.0.1:8080/v1", "/models"), "http://127.0.0.1:8080/v1/models");
assert.equal(redactApiKey("lb-secret-value", "lb-secret-value"), "[REDACTED]");
assert.equal(redactApiKey("no secret", "lb-secret-value"), "no secret");
assert.match(buildCurlSnippet("http://127.0.0.1:8080/v1", "/models"), /<LOCAL_API_KEY>/);
assert.doesNotMatch(buildCurlSnippet("http://127.0.0.1:8080/v1", "/models"), /lb-/);
console.log("developer utility tests passed");
