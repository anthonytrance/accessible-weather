const CACHE_NAME = "weather-clearly-shell-v6";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./weather-utils.js",
  "./deep-data.js",
  "./i18n.js",
  "./icons.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  if (url.pathname.endsWith("/data/kmi-latest.json")) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Pushes arrive without a payload. The service worker asks the Worker which
// notifications are pending for this subscription and shows them.
self.addEventListener("push", (event) => {
  event.waitUntil(showPendingNotifications());
});

async function showPendingNotifications() {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) return;
    const id = await subscriptionId(subscription.endpoint);
    const response = await fetch(`./api/push/pending?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Pending returned ${response.status}.`);
    const { messages } = await response.json();
    if (!Array.isArray(messages) || !messages.length) throw new Error("No pending messages.");
    for (const message of messages) {
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag || "weather",
        lang: message.lang || "en",
        icon: "./icon.svg",
        badge: "./icon.svg"
      });
    }
  } catch {
    await self.registration.showNotification("Weather update", {
      body: "Open the app for the latest weather.",
      tag: "weather-fallback",
      icon: "./icon.svg",
      badge: "./icon.svg"
    });
  }
}

async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientList) {
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow("./");
  })());
});
