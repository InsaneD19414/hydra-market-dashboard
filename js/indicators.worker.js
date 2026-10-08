/* HYDRA indicator worker — RSI / EMA / volume spike / band helpers off the main thread */
'use strict';
function rsi(closes, n) {
  n = n || 14; if (!closes || closes.length < n + 1) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function ema(vals, n) { if (!vals || !vals.length) return NaN; const k = 2 / (n + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
function volSpike(vols, n) {
  n = n || 20; if (!vols || vols.length < n + 1) return { mult: NaN, spike: false };
  const last = vols[vols.length - 1], avg = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
  const mult = avg > 0 ? last / avg : NaN;
  return { mult, spike: mult >= 2 };
}
self.onmessage = (e) => {
  const { id, closes, vols, kind } = e.data || {};
  let out = {};
  if (kind === 'bundle' || !kind) {
    out = {
      rsi14: rsi(closes, 14),
      ema20: ema(closes, 20),
      ema50: closes && closes.length >= 50 ? ema(closes.slice(-50), 50) : ema(closes, 50),
      ema200: closes && closes.length >= 200 ? ema(closes.slice(-200), 200) : NaN,
      vol: volSpike(vols, 20)
    };
  }
  self.postMessage({ id, out });
};
