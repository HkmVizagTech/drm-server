// DRM's service worker: shows follow-up reminders pushed by the server, and opens the right page
// when one is tapped. Nothing else - no fetch handler and no cache - so it cannot serve a stale
// page or change how any DRM screen loads.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "DRM", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Follow-up reminder";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: "/icon.png",
      badge: "/icon.png",
      data: { url: data.url || "/devotee/follow-ups" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/devotee/follow-ups", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A DRM tab already open: bring it forward on the lead rather than opening another.
      for (const c of open) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          await c.focus();
          if ("navigate" in c) await c.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
