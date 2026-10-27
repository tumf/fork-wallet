'use strict';
// EIP-6963 discovery fixture. Runs after the wallet init script, so it subscribes *after* the initial announce and
// then requests a re-announce. Every announce is recorded; consumers deduplicate by uuid.
window.__discovered = [];
window.addEventListener('eip6963:announceProvider', (event) => {
  window.__discovered.push({ uuid: event.detail.info.uuid, detail: event.detail });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
window.__uniqueProviders = () => [...new Map(window.__discovered.map((d) => [d.uuid, d.detail])).values()];
