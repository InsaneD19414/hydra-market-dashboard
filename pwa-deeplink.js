/* html2pwa deep links: ?action=NAME (plus any other params) for Shortcuts / Siri / Action Button.
   - window.PWA_LAUNCH = {action, params, standalone}
   - fires window event 'pwa:action' {detail:{action, params}}
   - clicks the first element with [data-pwa-action="NAME"], else scrolls to #NAME if present
   - removes the query from the address bar afterwards (set data-keep-query on <html> to keep it) */
(function () {
  var q = new URLSearchParams(location.search), params = {};
  q.forEach(function (v, k) { params[k] = v; });
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  if (standalone) document.documentElement.classList.add('pwa-standalone');
  var action = params.action || null;
  window.PWA_LAUNCH = { action: action, params: params, standalone: standalone };
  var done = false, me = document.currentScript;
  function run() {
    if (done) return; done = true;
    if (action) {
      window.dispatchEvent(new CustomEvent('pwa:action', { detail: { action: action, params: params } }));
      var el = document.querySelector('[data-pwa-action="' + action.replace(/"/g, '') + '"]');
      if (el) el.click(); else { var t = document.getElementById(action); if (t && t.scrollIntoView) t.scrollIntoView(); }
      window.PWA_LAUNCH.handled = true;
      if (!document.documentElement.hasAttribute('data-keep-query') && history.replaceState) history.replaceState(null, '', location.pathname + location.hash);
    }
    me = me || document.querySelector('script[src$="pwa-deeplink.js"]');
    if (me && me.getAttribute('data-register-sw') === '1' && 'serviceWorker' in navigator && location.protocol !== 'file:')
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('sw', e); });
  }
  // run after the page's own scripts (deferred/module scripts finish before DOMContentLoaded) so apps that read
  // location.search themselves still see the query first
  if (document.readyState === 'complete') run(); else { document.addEventListener('DOMContentLoaded', run); window.addEventListener('load', run); }
})();
