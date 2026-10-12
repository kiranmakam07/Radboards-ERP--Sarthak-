// RadCore keeps nothing on the device: every screen and every figure comes from the server each
// time. This file exists only because some browsers offer "Install app" only to a site that has one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
