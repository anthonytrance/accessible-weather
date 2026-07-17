import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

test("the Worker serves the live KMI snapshot from KV", async () => {
  const snapshot = {
    generatedAt: "2026-07-17T21:22:00Z",
    provider: "Royal Meteorological Institute of Belgium, KMI/IRM",
    observations: [{ code: 6431 }]
  };
  const env = {
    KMI_DATA: { get: async () => snapshot },
    ASSETS: { fetch: async () => { throw new Error("Static fallback should not be used."); } }
  };

  const response = await worker.fetch(new Request("https://weather.test/api/kmi"), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-weather-data-source"), "cloudflare-kv");
  assert.deepEqual(await response.json(), snapshot);
});

test("the Worker uses the checked-in KMI snapshot while KV is empty", async () => {
  let requestedPath = null;
  const env = {
    KMI_DATA: { get: async () => null },
    ASSETS: {
      fetch: async (request) => {
        requestedPath = new URL(request.url).pathname;
        return new Response('{"observations":[]}', {
          headers: { "content-type": "application/json" }
        });
      }
    }
  };

  const response = await worker.fetch(new Request("https://weather.test/api/kmi"), env);

  assert.equal(response.status, 200);
  assert.equal(requestedPath, "/data/kmi-latest.json");
});
