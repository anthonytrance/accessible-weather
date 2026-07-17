import test from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlEncode,
  createVapidJwt,
  sanitizeSubscriptionRecord,
  subscriptionIdFromEndpoint,
  timezoneOffsetMs
} from "../src/push.js";
import worker from "../src/worker.js";

function createMemoryKv() {
  const store = new Map();
  return {
    store,
    async get(key, options) {
      const value = store.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) };
    }
  };
}

async function createVapidEnv(kv) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    env: {
      KMI_DATA: kv,
      VAPID_PUBLIC_KEY: base64UrlEncode(publicRaw),
      VAPID_PRIVATE_KEY_JWK: JSON.stringify(privateJwk)
    },
    publicKey: pair.publicKey
  };
}

test("VAPID JWTs are well-formed and verifiable", async () => {
  const { env, publicKey } = await createVapidEnv(createMemoryKv());
  const jwt = await createVapidJwt("https://push.example.com/send/abc", env);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  const decode = (part) => JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  assert.deepEqual(decode(headerPart), { typ: "JWT", alg: "ES256" });
  const payload = decode(payloadPart);
  assert.equal(payload.aud, "https://push.example.com");
  assert.ok(payload.exp > Date.now() / 1000);
  assert.match(payload.sub, /^mailto:/);

  const signature = Buffer.from(signaturePart.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  );
  assert.equal(valid, true);
});

test("subscription records are sanitized before storage", async () => {
  const record = sanitizeSubscriptionRecord({
    subscription: { endpoint: "https://push.example.com/send/abc", keys: { p256dh: "x", auth: "y" } },
    location: { name: "Mechelen", latitude: 51.02, longitude: 4.47, timezone: "Europe/Brussels" },
    language: "nl",
    units: { temperatureUnit: "celsius", windUnit: "bft" },
    prefs: { rainAlerts: true, briefingHour: 7 }
  });
  assert.equal(record.language, "nl");
  assert.equal(record.prefs.briefingHour, 7);
  assert.equal(record.units.windUnit, "bft");

  assert.equal(sanitizeSubscriptionRecord({ subscription: { endpoint: "http://insecure" } }), null);
  const weird = sanitizeSubscriptionRecord({
    subscription: { endpoint: "https://push.example.com/x" },
    location: { latitude: 1, longitude: 2 },
    language: "zz",
    prefs: { briefingHour: 99 }
  });
  assert.equal(weird.language, "en");
  assert.equal(weird.prefs.briefingHour, null);
});

test("timezone offsets are computed from IANA names", () => {
  const july = new Date("2026-07-15T12:00:00Z");
  assert.equal(timezoneOffsetMs("Europe/Brussels", july), 2 * 3_600_000);
  assert.equal(timezoneOffsetMs("UTC", july), 0);
});

test("the Worker stores, serves and clears push subscriptions", async () => {
  const kv = createMemoryKv();
  const { env } = await createVapidEnv(kv);
  const endpoint = "https://push.example.com/send/abc";

  const subscribeResponse = await worker.fetch(new Request("https://weather.test/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      subscription: { endpoint, keys: {} },
      location: { name: "Mechelen", latitude: 51.02, longitude: 4.47, timezone: "Europe/Brussels" },
      language: "en",
      prefs: { rainAlerts: true, briefingHour: null }
    })
  }), env);
  assert.equal(subscribeResponse.status, 200);
  const { id } = await subscribeResponse.json();
  assert.equal(id, await subscriptionIdFromEndpoint(endpoint));
  assert.ok(kv.store.has(`push:${id}`));

  await kv.put(`pushmsg:${id}`, JSON.stringify([{ title: "Rain soon", body: "Test", tag: "rain-alert", lang: "en" }]));
  const pendingResponse = await worker.fetch(new Request(`https://weather.test/api/push/pending?id=${id}`), env);
  assert.equal(pendingResponse.status, 200);
  const { messages } = await pendingResponse.json();
  assert.equal(messages.length, 1);
  assert.equal(kv.store.has(`pushmsg:${id}`), false);

  const badPending = await worker.fetch(new Request("https://weather.test/api/push/pending?id=nope"), env);
  assert.equal(badPending.status, 400);

  const keyResponse = await worker.fetch(new Request("https://weather.test/api/push/vapid-public-key"), env);
  assert.equal((await keyResponse.json()).key, env.VAPID_PUBLIC_KEY);

  const unsubscribeResponse = await worker.fetch(new Request("https://weather.test/api/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint })
  }), env);
  assert.equal(unsubscribeResponse.status, 200);
  assert.equal(kv.store.has(`push:${id}`), false);

  const invalid = await worker.fetch(new Request("https://weather.test/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: { endpoint: "notaurl" } })
  }), env);
  assert.equal(invalid.status, 400);
});
