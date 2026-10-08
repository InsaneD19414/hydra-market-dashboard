/* HYDRA Market Dashboard v3.1
 * Live public Coinbase Exchange market data (no account, no API keys).
 * ALERTS + ORDER PREVIEWS ONLY: this app never places, edits or cancels orders and stores no credentials.
 */
'use strict';
(() => {
const API = 'https://api.exchange.coinbase.com';
const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const VERSION = '3.1.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem('hmd.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('hmd.' + k, JSON.stringify(v)); } catch (e) {} }
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const uid = () => Math.random().toString(36).slice(2, 9);
const r3 = x => Math.round(x * 1000) / 1000;

/* ---------------------------------------------------------------- defaults */
const DEFAULT_WATCH = ['ATOM-USD', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'MET-USD'];
// Your open position as of 2026-10-08 (typed in, editable; never read from the account API).
const DEFAULT_POS = { product: 'ATOM-USD', qty: 3.11, entry: 1.8121, cost: 5.6863, tp: 1.885, sl: 1.695, order: '29fb4574', usd: 0.08, usdc: 0.04, cash: 0.12 };
const DEFAULT_FEES = { taker: 0.90, maker: 0.50, slip: 0.05 }; // percent, Intro tier (coinbase_fees, 2026-10-08)
const mkRule = (product, o = {}) => Object.assign({ id: uid(), product, on: false, trigger: 'dip', tf: '5m', dip: 3, bars: 12, rsi: 30, vm: 0,
  N: 20, k: 2, trend: 'none', L: 96, m: 0, tp: 4, sl: 2, H: 0, max: 5, cool: 60 }, o);
const defaultRules = () => [
  mkRule('ATOM-USD'), mkRule('SOL-USD', { trigger: 'band', tf: '1h', tp: 3, sl: 3, trend: 'close>ema200' }),
  mkRule('BTC-USD', { trigger: 'rsi', tf: '1h', rsi: 25, tp: 3, sl: 2 }), mkRule('ETH-USD', { trigger: 'breakout', tf: '1h', tp: 5, sl: 2, m: 2 })
];
const defaultAlerts = () => [
  { id: uid(), product: 'ATOM-USD', cond: 'below', value: 1.72, on: true },
  { id: uid(), product: 'ATOM-USD', cond: 'above', value: 1.875, on: true },
  { id: uid(), product: 'BTC-USD', cond: 'move', value: 3, on: true }
];

const S = {
  watch: LS.get('watch', DEFAULT_WATCH.slice()),
  pos: Object.assign({}, DEFAULT_POS, LS.get('pos', {})),
  fees: Object.assign({}, DEFAULT_FEES, LS.get('fees', {})),
  rules: LS.get('rules', null) || defaultRules(),
  alerts: LS.get('alerts', null) || defaultAlerts(),
  spikeTh: LS.get('spikeTh', 3),
  minVol: LS.get('minVol', 1_000_000),
  gainMode: LS.get('gainMode', 'gain'),
  exHot: LS.get('exHot', true),
  rankBy: LS.get('rankBy', 'score'),
  gainers: [], gainUpdated: 0, products: {}, productsAt: 0,
  order: null,
  journal: LS.get('journal', []),
  risk: Object.assign({ dailyCap: 5, maxPos: 10, streakBlock: 2, cooldownMin: 30, maxPortfolioPct: 10, edgeGate: 2, cashOverride: null }, LS.get('risk', {})),
  cooldowns: LS.get('cooldowns', {}),   // v3.1: product -> ms timestamp of the last copied request
  log: LS.get('log', []),
  fired: LS.get('fired', {}),
  m: {},                 // market data per product
  feed: 'connecting', ws: null, wsOpen: false, wsLast: 0, wsRetry: 0, wsTicks: 0, restPolls: 0,
  unread: 0, tab: 'market', edit: false
};
const save = () => { LS.set('watch', S.watch); LS.set('pos', S.pos); LS.set('fees', S.fees); LS.set('rules', S.rules); LS.set('alerts', S.alerts); LS.set('spikeTh', S.spikeTh); LS.set('minVol', S.minVol); LS.set('gainMode', S.gainMode); LS.set('exHot', S.exHot); LS.set('rankBy', S.rankBy); LS.set('journal', S.journal); LS.set('risk', S.risk); LS.set('fired', S.fired); LS.set('cooldowns', S.cooldowns); };
window.HMD = { S, VERSION };
(function migratePos(){ const P=S.pos; if (P.usd==null && P.usdc==null){ P.usd=0.08; P.usdc=0.04; } P.cash=r3((num(P.usd)+num(P.usdc))||num(P.cash,0.12)); })();

/* ---------------------------------------------------------------- fees + edge math */
function feesFrac() { return { tk: S.fees.taker / 100, mk: S.fees.maker / 100, s: S.fees.slip / 100 }; }
function edge(tpPct, slPct) {
  const { tk, mk, s } = feesFrac(), buy = (1 + s) * (1 + tk);
  const costTp = (1 - (1 - s) * (1 - mk) / buy) * 100, costSl = (1 - (1 - s) * (1 - tk) / buy) * 100;
  const netTp = ((1 + tpPct / 100) * (1 - s) * (1 - mk) / buy - 1) * 100;
  const netSl = ((1 - slPct / 100) * (1 - s) * (1 - tk) / buy - 1) * 100;
  const beWin = netTp > 0 ? (-netSl / (netTp - netSl)) * 100 : 100;
  const level = tpPct <= costTp ? 'fail' : tpPct <= costSl ? 'thin' : 'ok';
  return { costTp, costSl, netTp, netSl, beWin, level, clears: level !== 'fail' };
}

/* ---------------------------------------------------------------- formatting */
function fp(p) {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 10) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}
const fpct = (x, d = 2) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) + '%' : '—';
const fusd = x => Number.isFinite(x) ? (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2) : '—';
const fsusd = x => Number.isFinite(x) ? (x >= 0 ? '+$' : '−$') + Math.abs(x).toFixed(2) : '—';
const cls = x => x >= 0 ? 'up' : 'dn';
const sym = p => p.split('-')[0];
const cbTradeUrl = p => 'https://www.coinbase.com/advanced-trade/spot/' + encodeURIComponent(p);
const fum = x => Number.isFinite(x) ? (x >= 1e6 ? '$' + (x/1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x/1e3).toFixed(0) + 'k' : '$' + x.toFixed(0)) : '—';
const PRODUCT_TTL = 15 * 60e3;
let _worker = null, _wpend = new Map(), _wid = 0;
function getWorker() {
  if (_worker) return _worker;
  try { _worker = new Worker('js/indicators.worker.js'); _worker.onmessage = e => { const { id, out } = e.data || {}; const r = _wpend.get(id); if (r) { _wpend.delete(id); r(out); } }; _worker.onerror = () => { _worker = null; }; }
  catch (e) { _worker = null; }
  return _worker;
}
function callWorker(closes, vols) {
  return new Promise(res => {
    const w = getWorker();
    if (!w) { // sync fallback
      const rsi14 = (function(c,n){if(!c||c.length<n+1)return NaN;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}g/=n;l/=n;for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;}return l===0?100:100-100/(1+g/l);})(closes,14);
      res({ rsi14, vol: { mult: NaN, spike: false } }); return;
    }
    const id = ++_wid; _wpend.set(id, res); w.postMessage({ id, kind: 'bundle', closes, vols });
    setTimeout(() => { if (_wpend.has(id)) { _wpend.delete(id); res({}); } }, 3000);
  });
}
function canBuzz() { return !!navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive); }  // browsers block vibrate before the first tap
function buzz(ms) { if (canBuzz()) try { navigator.vibrate(ms || 12); } catch (e) {} }


/* ---------------------------------------------------------------- throttled REST queue (public endpoints, CORS *) */
const queue = []; let qBusy = false;
function api(path) {
  return new Promise((res, rej) => { queue.push({ path, res, rej, tries: 0 }); pump(); });
}
async function pump() {
  if (qBusy) return; qBusy = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const r = await fetch(API + job.path, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (r.status === 429 && job.tries < 3) { job.tries++; queue.push(job); await sleep(1200); continue; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; job.rej(e); }
      else job.res(await r.json());
    } catch (e) { job.rej(e); }
    await sleep(170); // stay well under Coinbase public rate limits
  }
  qBusy = false;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md = p => (S.m[p] = S.m[p] || { price: NaN, open24: NaN, c5: [], c1h: [], lastTick: 0, lastC5: 0, lastC1h: 0 });

async function loadStats(p) {
  const d = await api(`/products/${p}/stats`), m = md(p);
  m.open24 = num(d.open, NaN); m.high24 = num(d.high, NaN); m.low24 = num(d.low, NaN); m.vol24 = num(d.volume, NaN);
  if (!m.lastTick) { m.price = num(d.last, NaN); m.lastTick = Date.now(); m.src = 'rest'; }
  dirty(p);
}
async function loadTicker(p) {
  const d = await api(`/products/${p}/ticker`), m = md(p);
  tick(p, { price: num(d.price, NaN), bid: num(d.bid, NaN), ask: num(d.ask, NaN) }, 'rest'); S.restPolls++;
  return m;
}
async function loadCandles(p, g) {
  const d = await api(`/products/${p}/candles?granularity=${g}`);
  return d.map(c => ({ t: c[0], l: c[1], h: c[2], o: c[3], c: c[4], v: c[5] })).sort((a, b) => a.t - b.t);
}
async function refreshCandles(p, force) {
  const m = md(p), now = Date.now();
  try {
    if (force || now - m.lastC5 > 5 * 60e3) { m.c5 = await loadCandles(p, 300); m.lastC5 = now; }
    if (force || now - m.lastC1h > 15 * 60e3) { m.c1h = await loadCandles(p, 3600); m.lastC1h = now; }
    derive(p); dirty(p);
  } catch (e) { console.warn('candles', p, e); }
}

/* live tick -> merge into candles */
function tick(p, d, src) {
  const m = md(p), prev = m.price;
  if (Number.isFinite(d.price)) m.price = d.price;
  ['bid', 'ask', 'open24', 'high24', 'low24', 'vol24'].forEach(k => { if (Number.isFinite(d[k])) m[k] = d[k]; });
  m.lastTick = Date.now(); m.src = src; m.dir = d.price > prev ? 1 : d.price < prev ? -1 : 0;
  const t = Math.floor(Date.now() / 1000);
  for (const [arr, g] of [[m.c5, 300], [m.c1h, 3600]]) {
    if (!arr.length || !Number.isFinite(m.price)) continue;
    const last = arr[arr.length - 1], b = Math.floor(t / g) * g;
    if (b === last.t) { last.c = m.price; last.h = Math.max(last.h, m.price); last.l = Math.min(last.l, m.price); }
    else if (b > last.t) arr.push({ t: b, o: m.price, h: m.price, l: m.price, c: m.price, v: 0 });
  }
  derive(p); dirty(p);
}

/* ---------------------------------------------------------------- indicators */
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function ema(vals, n) { const k = 2 / (n + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
function resample(c5, mins) {
  const g = mins * 60, out = [];
  for (const c of c5) { const b = Math.floor(c.t / g) * g, o = out[out.length - 1];
    if (o && o.t === b) { o.h = Math.max(o.h, c.h); o.l = Math.min(o.l, c.l); o.c = c.c; o.v += c.v; } else out.push({ t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }); }
  return out;
}
function bars(m, tf) { return tf === '1h' ? m.c1h : tf === '15m' ? resample(m.c5, 15) : m.c5; }
function derive(p) {
  const m = md(p);
  if (m.c5.length && Number.isFinite(m.price)) {
    const target = Date.now() / 1000 - 3600; let ref = null;
    for (let i = m.c5.length - 1; i >= 0; i--) if (m.c5[i].t <= target) { ref = m.c5[i].c; break; }
    m.ch1h = ref ? (m.price / ref - 1) * 100 : NaN;
  }
  if (m.c1h.length) m.rsi1h = rsi(m.c1h.map(c => c.c));
  m.ch24 = Number.isFinite(m.open24) ? (m.price / m.open24 - 1) * 100 : NaN;
}

/* ---------------------------------------------------------------- feed: websocket first, REST polling fallback */
function setFeed(f) {
  if (S.feed === f) return; S.feed = f;
  const el = $('#feed'); el.className = 'feed ' + f;
  $('#feedTxt').textContent = f === 'ws' ? 'LIVE · WS' : f === 'rest' ? 'LIVE · REST' : f === 'down' ? 'OFFLINE' : 'CONNECTING';
}
function connectWS() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  let ws; try { ws = new WebSocket(WS_URL); } catch (e) { S.wsOpen = false; return wsRetry(); }
  S.ws = ws;
  ws.onopen = () => { S.wsOpen = true; S.wsRetry = 0; ws.send(JSON.stringify({ type: 'subscribe', product_ids: S.watch, channels: ['ticker', 'heartbeat'] })); };
  ws.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch (x) { return; }
    S.wsLast = Date.now();
    if (d.type === 'ticker' && d.product_id) {
      S.wsTicks++; setFeed('ws');
      tick(d.product_id, { price: num(d.price, NaN), bid: num(d.best_bid, NaN), ask: num(d.best_ask, NaN), open24: num(d.open_24h, NaN),
        high24: num(d.high_24h, NaN), low24: num(d.low_24h, NaN), vol24: num(d.volume_24h, NaN) }, 'ws');
    } else if (d.type === 'subscriptions' || d.type === 'heartbeat') { setFeed('ws'); }
    else if (d.type === 'error') console.warn('ws error', d.message, d.reason);
  };
  ws.onclose = () => { S.wsOpen = false; if (S.ws === ws) S.ws = null; if (S.feed === 'ws') setFeed(navigator.onLine ? 'rest' : 'down'); wsRetry(); };
  ws.onerror = () => { try { ws.close(); } catch (x) {} };
}
let wsTimer = null;
function wsRetry() {
  if (wsTimer || document.hidden) return;
  const delay = Math.min(60e3, 2000 * Math.pow(2, S.wsRetry++));
  wsTimer = setTimeout(() => { wsTimer = null; connectWS(); }, delay);
}
function wsSub(type, p) { if (S.ws && S.wsOpen) S.ws.send(JSON.stringify({ type, product_ids: [p], channels: ['ticker'] })); }

// Poll any product the websocket has not updated recently (also the full fallback when WS is down).
let pollBusy = false;
async function poll() {
  if (pollBusy || document.hidden) return; pollBusy = true;
  const now = Date.now(), wsLive = S.wsOpen && now - S.wsLast < 30e3;
  if (!wsLive && S.feed === 'ws') setFeed('rest');
  let ok = 0, fail = 0;
  for (const p of S.watch) {
    const m = md(p);
    if (now - m.lastTick < (wsLive ? 60e3 : 7e3)) continue;
    try { await loadTicker(p); ok++; } catch (e) { fail++; }
  }
  if (!wsLive) { if (ok) setFeed('rest'); else if (fail) setFeed('down'); }
  pollBusy = false;
}

/* ---------------------------------------------------------------- rendering */
const dirtySet = new Set(); let rafPending = false, lastRender = 0;
function dirty(p) { dirtySet.add(p); if (!rafPending) { rafPending = true; setTimeout(() => requestAnimationFrame(render), Math.max(0, 350 - (Date.now() - lastRender))); } }
function render() {
  rafPending = false; lastRender = Date.now();
  for (const p of dirtySet) renderCard(p);
  dirtySet.clear();
  renderPosition(); evalAll();
  $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if (!$('#sheet').hidden) drawChart();
}
function buildCards() {
  const box = $('#cards'); box.innerHTML = '';
  for (const p of S.watch) {
    const el = document.createElement('div'); el.className = 'card coin'; el.dataset.p = p;
    el.innerHTML = `<div class="sym">${esc(sym(p))}<small>${esc(p.split('-')[1] || '')}</small></div><div class="px">—</div>
      <div class="meta"><span class="c24">24h —</span><span class="c1">1h —</span><span class="bd"></span></div><div class="meta rsi"></div>
      <canvas height="46"></canvas>
      <div class="acts"><button class="btn gold" type="button" data-buy="${esc(p)}">BUY</button><button class="btn crim" type="button" data-sell="${esc(p)}">SELL</button></div>
      <button class="rm" type="button" aria-label="Remove ${esc(p)}">Remove</button>`;
    box.appendChild(el); renderCard(p);
  }
  box.classList.toggle('edit', S.edit);
  fillProductSelects();
}
function renderCard(p) {
  const el = $(`.coin[data-p="${CSS.escape(p)}"]`); if (!el) return;
  const m = md(p), px = $('.px', el);
  px.textContent = fp(m.price);
  px.className = 'px ' + (m.dir > 0 ? 'flash-up' : m.dir < 0 ? 'flash-dn' : '');
  clearTimeout(el._t); el._t = setTimeout(() => { px.className = 'px'; }, 600);
  const c24 = $('.c24', el); c24.textContent = '24h ' + fpct(m.ch24); c24.className = 'c24 ' + cls(m.ch24);
  const c1 = $('.c1', el); c1.textContent = '1h ' + fpct(m.ch1h); c1.className = 'c1 ' + cls(m.ch1h);
  const th = S.spikeTh, bd = $('.bd', el); let b = '';
  if (m.ch1h >= th) b = `<span class="badge spike">SPIKE</span>`; else if (m.ch1h <= -th) b = `<span class="badge dip">DIP</span>`;
  if (m.signal) b += ` <span class="badge sig">SIGNAL</span>`;
  bd.innerHTML = b;
  $('.rsi', el).textContent = `RSI(1h) ${Number.isFinite(m.rsi1h) ? m.rsi1h.toFixed(0) : '—'} · bid ${fp(m.bid)} · ask ${fp(m.ask)}`;
  spark($('canvas', el), m);
}
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300, h = cv.clientHeight || +cv.getAttribute('height');
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h); return [x, w, h];
}
function spark(cv, m) {
  const pts = m.c5.slice(-288).map(c => c.c); if (pts.length < 2) return;
  const [x, w, h] = fitCanvas(cv), lo = Math.min(...pts), hi = Math.max(...pts), rng = hi - lo || 1;
  const X = i => (i / (pts.length - 1)) * w, Y = v => h - 3 - ((v - lo) / rng) * (h - 6);
  const up = pts[pts.length - 1] >= pts[0], col = up ? '#D4AF37' : '#E0283E';
  if (Number.isFinite(m.open24) && m.open24 > lo && m.open24 < hi) { x.strokeStyle = 'rgba(168,168,168,.35)'; x.setLineDash([3, 4]); x.beginPath(); x.moveTo(0, Y(m.open24)); x.lineTo(w, Y(m.open24)); x.stroke(); x.setLineDash([]); }
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, up ? 'rgba(212,175,55,.28)' : 'rgba(177,18,38,.32)'); g.addColorStop(1, 'rgba(10,10,10,0)');
  x.beginPath(); pts.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v)));
  x.lineWidth = 1.6; x.strokeStyle = col; x.stroke();
  x.lineTo(w, h); x.lineTo(0, h); x.closePath(); x.fillStyle = g; x.fill();
  x.fillStyle = col; x.beginPath(); x.arc(X(pts.length - 1) - 2, Y(pts[pts.length - 1]), 2.5, 0, 7); x.fill();
}

/* ---------------------------------------------------------------- position */
function posCalc() {
  const P = S.pos, m = md(P.product), { tk, mk } = feesFrac();
  const px = Number.isFinite(m.bid) ? m.bid : m.price, cost = P.cost || P.qty * P.entry * (1 + tk);
  return { px, last: m.price, cost, val: P.qty * px, net: P.qty * px * (1 - tk) - cost, beT: cost / (P.qty * (1 - tk)), beM: cost / (P.qty * (1 - mk)),
    toTp: (P.tp / px - 1) * 100, toSl: (P.sl / px - 1) * 100, atTp: P.qty * P.tp * (1 - mk) - cost, atSl: P.qty * P.sl * (1 - tk) - cost };
}
function renderPosition() {
  const P = S.pos, c = posCalc();
  $('#posOrder').textContent = P.order ? `Bracket ${P.order}` : '';
  $('#pPrice').textContent = fp(c.last) + ' ' + sym(P.product);
  $('#pPnl').textContent = fsusd(c.net); $('#pPnl').className = 'big ' + cls(c.net);
  $('#pPnlPct').textContent = fpct(c.net / c.cost * 100) + ' vs cost'; $('#pPnlPct').className = 'sm ' + cls(c.net);
  $('#pQty').textContent = `${P.qty} @ ${fp(P.entry)}`; $('#pCost').textContent = fusd(c.cost);
  $('#pBeT').textContent = fp(c.beT); $('#pBeM').textContent = fp(c.beM);
  $('#pToTp').innerHTML = P.tp ? `${fp(P.tp)} <span class="${cls(c.toTp)}">(${fpct(c.toTp)})</span>` : '—';
  $('#pToSl').innerHTML = P.sl ? `${fp(P.sl)} <span class="dn">(${fpct(c.toSl)})</span>` : '—';
  $('#pAtTp').innerHTML = P.tp ? `<span class="${cls(c.atTp)}">${fsusd(c.atTp)}</span> <span class="sm mut">maker</span>` : '—';
  $('#pAtSl').innerHTML = P.sl ? `<span class="${cls(c.atSl)}">${fsusd(c.atSl)}</span> <span class="sm mut">taker</span>` : '—';
  $('#pVal').textContent = fusd(c.val); $('#pCash').textContent = fusd(P.cash) + ` (USD ${fusd(P.usd)} · USDC ${fusd(P.usdc)})`;
  if (S.tab === 'position') gauge(c);
}
function gauge(c) {
  const P = S.pos, cv = $('#gauge'), [x, w, h] = fitCanvas(cv);
  const vals = [P.sl, P.tp, c.px, P.entry, c.beT].filter(Number.isFinite); if (vals.length < 2) return;
  const lo = Math.min(...vals) * 0.996, hi = Math.max(...vals) * 1.004, X = v => 12 + ((v - lo) / (hi - lo)) * (w - 24), y = 44;
  const g = x.createLinearGradient(X(P.sl), 0, X(P.tp), 0);
  g.addColorStop(0, '#7A0C14'); g.addColorStop(Math.max(0, Math.min(1, (c.beT - P.sl) / (P.tp - P.sl))), '#2E2E2E'); g.addColorStop(1, '#D4AF37');
  x.fillStyle = '#1A1A1A'; x.fillRect(12, y - 5, w - 24, 10); x.fillStyle = g; x.fillRect(X(P.sl), y - 5, X(P.tp) - X(P.sl), 10);
  x.font = '600 11px Rajdhani, sans-serif'; x.textAlign = 'center';
  const mark = (v, label, col, up) => { if (!Number.isFinite(v)) return; x.fillStyle = col; x.fillRect(X(v) - 1, y - 11, 2, 22); x.fillText(label, Math.min(w - 20, Math.max(20, X(v))), up ? y - 16 : y + 26); };
  mark(P.sl, 'STOP ' + fp(P.sl), '#E0283E', false); mark(P.tp, 'TP ' + fp(P.tp), '#D4AF37', false);
  mark(P.entry, 'ENTRY', '#A8A8A8', true); mark(c.beT, 'B/E', '#F3D57A', true);
  if (Number.isFinite(c.px)) { const px = X(c.px); x.fillStyle = '#E8E8E8'; x.beginPath(); x.moveTo(px, y + 8); x.lineTo(px - 7, y + 20); x.lineTo(px + 7, y + 20); x.closePath(); x.fill();
    x.font = '700 12px Rajdhani, sans-serif'; x.fillText('NOW ' + fp(c.px), Math.min(w - 30, Math.max(30, px)), y + 40); }
}
function fillPosForm() { const f = $('#posForm'); for (const k of Object.keys(DEFAULT_POS)) if (f[k]) f[k].value = S.pos[k] ?? ''; }

/* ---------------------------------------------------------------- bot rules */
const TRIG = { dip: 'Dip (drop %)', rsi: 'RSI below', band: 'Lower band (mean reversion)', breakout: 'Breakout (high)' };
const STRAT = { dip: 'C', band: 'A', breakout: 'B', rsi: 'R' };
function ruleFields(r) {
  const f = (k, l, step = 'any') => `<label>${l}<input data-k="${k}" type="number" step="${step}" inputmode="decimal" value="${esc(r[k])}"></label>`;
  const tf = `<label>Timeframe<select data-k="tf">${['5m', '15m', '1h'].map(t => `<option${r.tf === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  let s = '';
  if (r.trigger === 'dip') s = f('dip', 'Dip %') + f('bars', 'Within bars', 1) + tf + f('rsi', 'and RSI < (0 off)') + f('vm', 'Vol × avg (0 off)');
  if (r.trigger === 'rsi') s = f('rsi', 'RSI(14) <') + tf;
  if (r.trigger === 'band') s = f('N', 'SMA bars', 1) + f('k', 'k × σ below') + `<label>Trend filter<select data-k="trend"><option value="none"${r.trend === 'none' ? ' selected' : ''}>none</option><option${r.trend === 'close>ema200' ? ' selected' : ''}>close>ema200</option></select></label>` + tf;
  if (r.trigger === 'breakout') s = f('L', 'Lookback bars', 1) + f('m', 'Vol × avg (0 off)') + tf;
  return s + f('tp', 'Take-profit %') + f('sl', 'Stop %') + f('max', 'Max $ / trade') + f('cool', 'Cooldown min', 1) + f('H', 'Max hold h (0 off)', 1);
}
function renderRules() {
  const box = $('#rules');
  box.innerHTML = S.rules.map(r => `<div class="card rule${r.on ? '' : ' off'}" data-id="${r.id}">
    <div class="rhead"><select data-k="product" aria-label="Coin">${[...new Set([...S.watch, r.product])].map(p => `<option${p === r.product ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select data-k="trigger" aria-label="Buy trigger">${Object.entries(TRIG).map(([k, v]) => `<option value="${k}"${r.trigger === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label class="tog" title="On/off"><input type="checkbox" data-k="on"${r.on ? ' checked' : ''} aria-label="Rule on"><span></span></label></div>
    <div class="rgrid">${ruleFields(r)}</div>
    <div class="edge"></div><div class="sm mut live"></div>
    <div class="row between" style="margin-top:8px"><span class="sm mut">backtest_verified: false</span><button class="btn sm" data-del="${r.id}">Delete</button></div></div>`).join('');
  S.rules.forEach(renderEdge);
  $('#rtTxt').innerHTML = (() => { const e = edge(0, 0); return `Round trip at a flat price: <b class="gold">${e.costTp.toFixed(2)}%</b> (limit TP exit) · <b class="dn">${e.costSl.toFixed(2)}%</b> (stop / market exit).`; })();
}
function renderEdge(r) {
  const el = $(`.rule[data-id="${r.id}"] .edge`); if (!el) return;
  const e = edge(r.tp, r.sl);
  el.className = 'edge ' + (e.level === 'ok' ? 'ok' : 'warn');
  const head = e.level === 'fail' ? `⚠ TP ${r.tp}% is below round-trip fees (${e.costTp.toFixed(2)}%): this rule loses money even when it wins.`
    : e.level === 'thin' ? `⚠ TP ${r.tp}% barely clears fees (${e.costTp.toFixed(2)}–${e.costSl.toFixed(2)}%).`
    : `Fee check passes: TP ${r.tp}% is above round-trip fees.`;
  el.innerHTML = `${head}<br>Net if TP: <b class="${cls(e.netTp)}">${fpct(e.netTp)}</b> · net if stop: <b class="dn">${fpct(e.netSl)}</b> · win rate needed to break even: <b>${e.beWin.toFixed(1)}%</b>`;
  const live = $(`.rule[data-id="${r.id}"] .live`); if (live) live.textContent = r._status || 'Waiting for candles…';
}
function ruleText(r) {
  const t = { dip: `drop>=${r.dip}% in ${r.bars} bars${r.rsi ? `, RSI<${r.rsi}` : ''}${r.vm ? `, vol>${r.vm}x` : ''}`, rsi: `RSI(14)<${r.rsi}`,
    band: `N${r.N} k${r.k}${r.trend !== 'none' ? ' ' + r.trend : ''}`, breakout: `L${r.L}${r.m ? ' m' + r.m : ''}` }[r.trigger];
  return `${t} → TP${r.tp}% SL${r.sl}%${r.H ? ' H' + r.H : ''} max$${r.max} cd${r.cool}m (${r.tf})`;
}
function evalRule(r) {
  const m = md(r.product), B = bars(m, r.tf), px = m.price;
  if (!B || B.length < 30 || !Number.isFinite(px)) return { hit: false, status: 'Waiting for candles…' };
  const closes = B.map(c => c.c), last = B.length - 1, R = rsi(closes);
  const volOk = mult => { if (!mult) return true; const v = B.slice(-21, -1).map(c => c.v), avg = v.reduce((a, b) => a + b, 0) / (v.length || 1); return B[last].v > mult * avg; };
  if (r.trigger === 'dip') {
    const ref = closes[Math.max(0, last - r.bars)], drop = (px / ref - 1) * 100;
    const hit = drop <= -r.dip && (!r.rsi || R < r.rsi) && volOk(r.vm);
    return { hit, status: `Now: ${fpct(drop)} over ${r.bars}×${r.tf}, RSI ${R.toFixed(0)} → ${hit ? 'SIGNAL' : 'no signal'}` };
  }
  if (r.trigger === 'rsi') { const hit = R < r.rsi; return { hit, status: `Now: RSI(14, ${r.tf}) ${R.toFixed(1)} → ${hit ? 'SIGNAL' : 'no signal'}` }; }
  if (r.trigger === 'band') {
    const w = closes.slice(-r.N), mean = w.reduce((a, b) => a + b, 0) / w.length, sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length);
    const lower = mean - r.k * sd, trendOk = r.trend === 'none' || closes.length < 200 || px > ema(closes.slice(-200), 200), hit = px < lower && trendOk;
    return { hit, status: `Now: price ${fp(px)} vs lower band ${fp(lower)}${r.trend !== 'none' ? (trendOk ? ', trend ok' : ', below EMA200') : ''} → ${hit ? 'SIGNAL' : 'no signal'}` };
  }
  if (r.trigger === 'breakout') {
    const hiL = Math.max(...B.slice(Math.max(0, last - r.L), last).map(c => c.h)), hit = px > hiL && volOk(r.m);
    return { hit, status: `Now: price ${fp(px)} vs ${r.L}-bar high ${fp(hiL)} → ${hit ? 'SIGNAL' : 'no signal'}` };
  }
  return { hit: false, status: '' };
}
function previewText(r, px) {
  const e = edge(r.tp, r.sl), tp = px * (1 + r.tp / 100), sl = px * (1 - r.sl / 100);
  return `PREVIEW ONLY: BUY $${r.max} ${r.product} at market (~${fp(px)}), TP limit ${fp(tp)}, stop ${fp(sl)}. Net if TP ${fpct(e.netTp)}, if stop ${fpct(e.netSl)}. ` +
    (e.clears ? '' : 'FEE CHECK FAILS. ') + 'Backtest: no rule cleared Intro fees. Ask Grok Bot to preview; nothing is placed without your approval.';
}

/* ---------------------------------------------------------------- alerts */
function evalAll() {
  const now = Date.now();
  for (const p of S.watch) md(p).signal = false;
  for (const r of S.rules) {
    const res = evalRule(r); r._status = res.status;
    if (r.on && res.hit) {
      md(r.product).signal = true;
      const k = 'rule:' + r.id;
      if (now - (S.fired[k] || 0) > r.cool * 60e3) { S.fired[k] = now; save(); fire(`${sym(r.product)} buy signal (${TRIG[r.trigger]})`, ruleText(r), 'up', previewText(r, md(r.product).price)); }
    }
    if (S.tab === 'bot') { const live = $(`.rule[data-id="${r.id}"] .live`); if (live) live.textContent = r._status; }
  }
  for (const a of S.alerts) {
    if (!a.on) continue;
    const m = md(a.product), v = a.cond === 'move' ? Math.abs(m.ch1h) : m.price; if (!Number.isFinite(v)) continue;
    const hit = a.cond === 'above' ? v >= a.value : a.cond === 'below' ? v <= a.value : v >= a.value;
    const rearm = a.cond === 'above' ? v < a.value * 0.998 : a.cond === 'below' ? v > a.value * 1.002 : v < a.value * 0.8;
    if (hit && a.armed !== false) {
      a.armed = false; save();
      const title = a.cond === 'move' ? `${sym(a.product)} moved ${fpct(m.ch1h)} in 1h` : `${sym(a.product)} ${a.cond} ${fp(a.value)}: now ${fp(m.price)}`;
      fire(title, alertText(a), a.cond === 'below' || (a.cond === 'move' && m.ch1h < 0) ? 'dn' : 'up');
    } else if (rearm && a.armed === false) { a.armed = true; save(); }
  }
  // built-in position proximity alerts
  const P = S.pos, c = posCalc();
  if (Number.isFinite(c.px)) for (const [k, lvl, near, txt] of [['pos:tp', P.tp, Math.abs(c.toTp) <= 0.5, 'within 0.5% of take-profit'], ['pos:sl', P.sl, Math.abs(c.toSl) <= 0.5, 'within 0.5% of stop']]) {
    if (lvl && near && now - (S.fired[k] || 0) > 30 * 60e3) { S.fired[k] = now; save(); fire(`${sym(P.product)} ${txt}`, `Price ${fp(c.px)} · level ${fp(lvl)} · net now ${fsusd(c.net)}`, k === 'pos:sl' ? 'dn' : 'up'); }
  }
}
const alertText = a => `${a.product} ${a.cond === 'move' ? '1h move ≥ ' + a.value + '%' : 'price ' + a.cond + ' ' + fp(a.value)}`;
function fire(title, body, dir, preview) {
  const item = { t: Date.now(), title, body, dir, preview };
  S.log.unshift(item); S.log = S.log.slice(0, 100); LS.set('log', S.log); renderLog();
  toast(title + (body ? `<br><span class="sm mut">${esc(body)}</span>` : ''), dir);
  if (S.tab !== 'alerts') { S.unread++; const b = $('#alertBadge'); b.hidden = false; b.textContent = S.unread; }
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body: body + (preview ? '\n' + preview : ''), icon: 'img/crest.png', tag: title };
    (navigator.serviceWorker && navigator.serviceWorker.controller ? navigator.serviceWorker.ready.then(r => r.showNotification('HYDRA · ' + title, opts)) : Promise.reject())
      .catch(() => { try { new Notification('HYDRA · ' + title, opts); } catch (e) {} });
  }
  if (canBuzz()) try { navigator.vibrate(120); } catch (e) {}
}
function toast(html, dir) {
  const t = document.createElement('div'); t.className = 'toast ' + (dir || ''); t.innerHTML = html.replace(/^([^<]*)/, m => esc(m));
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 6000); t.onclick = () => t.remove();
}
function renderLog() {
  $('#log').innerHTML = S.log.length ? S.log.map(i => `<div class="it ${i.dir === 'dn' ? 'dn' : ''}"><time>${new Date(i.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><b>${esc(i.title)}</b><br><span class="sm mut">${esc(i.body || '')}</span>${i.preview ? `<span class="pv">${esc(i.preview)}</span><button class="btn sm" data-copy="${esc(i.preview)}">Copy preview for chat</button>` : ''}</div>`).join('')
    : '<div class="sm mut">No alerts yet.</div>';
}
function renderAlertRules() {
  $('#alertRules').innerHTML = S.alerts.map(a => `<div class="card arule" data-id="${a.id}"><span class="txt">${esc(alertText(a))}</span>
    <span class="row gap"><label class="tog"><input type="checkbox" data-a="on"${a.on ? ' checked' : ''} aria-label="Alert on"><span></span></label><button class="btn sm" data-adel="${a.id}">✕</button></span></div>`).join('') || '<div class="sm mut">No alerts set.</div>';
}
function fillProductSelects() { const s = $('#alertProduct'); if (s) s.innerHTML = S.watch.map(p => `<option>${esc(p)}</option>`).join(''); }

/* ---------------------------------------------------------------- export / import (scanner_rules.json schema, extended) */
function ruleToSchema(r) {
  const s = STRAT[r.trigger], e = edge(r.tp, r.sl), p = { strat: s };
  if (r.trigger === 'dip') Object.assign(p, { d: r.dip / 100, M: r.bars, r: r.rsi || null, vm: r.vm || null });
  if (r.trigger === 'rsi') Object.assign(p, { r: r.rsi });
  if (r.trigger === 'band') Object.assign(p, { N: r.N, k: r.k, trend: r.trend === 'none' ? null : r.trend });
  if (r.trigger === 'breakout') Object.assign(p, { L: r.L, m: r.m || null });
  Object.assign(p, { tp: r.tp / 100, sl: r.sl / 100, trail: false, H: r.H || null, max_usd: r.max, cooldown_min: r.cool });
  return { id: r.id, coin: r.product, strategy: s, trigger: r.trigger, timeframe: r.tf, enabled: !!r.on, params: p, params_text: ruleText(r),
    edge_check: { round_trip_cost_tp_pct: r3(e.costTp), round_trip_cost_stop_pct: r3(e.costSl), net_if_tp_pct: r3(e.netTp), net_if_stop_pct: r3(e.netSl),
      breakeven_win_rate_pct: r3(e.beWin), tp_clears_fees: e.clears, level: e.level },
    backtest_verified: false, source: 'hydra-market-dashboard' };
}
function buildExport() {
  const { tk, mk, s } = feesFrac(), e = edge(0, 0);
  return {
    generated_by: `HYDRA Market Dashboard v${VERSION} (alerts + order previews only; places no orders)`,
    schema_version: 'scanner_rules.v1+dashboard.1',
    exported_at: new Date().toISOString(),
    fee_model: { source: 'dashboard settings (Intro tier read via coinbase_fees, 2026-10-08)', tier: 'Intro', taker: tk, maker: mk, slippage_per_side: s,
      entry: 'market (taker)', tp_exit: 'limit (maker)', stop_time_exit: 'market (taker)', round_trip_cost_tp_pct: r3(e.costTp), round_trip_cost_stop_pct: r3(e.costSl) },
    pass_criteria: { min_trades: 20, min_profit_factor: 1.2, max_p_random: 0.1, also: 'OOS total>0, avg net>0, and total>0 at 0.10% slippage' },
    params_note: 'rules = user-set dashboard alert rules (not backtested by the dashboard; backtest_verified=false).',
    no_rules_pass: true,
    backtest_ref: { report: 'cb-backtest/REPORT.md', date: '2026-10-08', verdict: 'none of 32 strategy/coin/timeframe combinations cleared Intro-tier fees out-of-sample' },
    governance: { mode: 'confirm_and_send_is_approval', places_orders: false, holds_api_keys: false, approval: 'Confirm & send copies an APPROVED BY DARYELL order request; Grok Bot previews then places if preview matches' },
    rules: S.rules.map(ruleToSchema),
    near_miss: [],
    dashboard: { watchlist: S.watch.slice(), spike_threshold_pct: S.spikeTh, position: Object.assign({}, S.pos),
      alerts: S.alerts.map(a => ({ product: a.product, cond: a.cond, value: a.value, on: a.on })) }
  };
}
function schemaToRule(x, forceOff) {
  const p = x.params || {}, s = (p.strat || x.strategy || 'C').toUpperCase();
  const trig = x.trigger || { C: 'dip', A: 'band', B: 'breakout', R: 'rsi' }[s] || 'dip';
  const r = mkRule(String(x.coin || x.product || 'ATOM-USD').toUpperCase(), { trigger: trig, tf: ['5m', '15m', '1h'].includes(x.timeframe) ? x.timeframe : '1h', on: forceOff ? false : !!x.enabled });
  if (p.d != null) r.dip = r3(p.d * 100); if (p.M != null) r.bars = p.M; if (p.r != null) r.rsi = p.r; if (p.vm != null) r.vm = p.vm;
  if (p.N != null) r.N = p.N; if (p.k != null) r.k = p.k; if (p.trend) r.trend = p.trend; if (p.L != null) r.L = p.L; if (p.m != null) r.m = p.m;
  if (p.tp != null) r.tp = r3(p.tp * 100); if (p.sl != null) r.sl = r3(p.sl * 100); if (p.H != null) r.H = p.H;
  if (p.max_usd != null) r.max = p.max_usd; if (p.cooldown_min != null) r.cool = p.cooldown_min;
  return r;
}
function importJSON(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not a JSON object');
  let rules = Array.isArray(obj.rules) ? obj.rules : [], note = '';
  if (!rules.length && Array.isArray(obj.near_miss) && obj.near_miss.length) { rules = obj.near_miss; note = ' (near_miss imported switched OFF: none cleared fees)'; }
  const fromNear = !!note;
  if (rules.length) S.rules = rules.map(x => schemaToRule(x, fromNear));
  if (obj.fee_model) { const f = obj.fee_model; if (f.taker != null) S.fees.taker = r3(f.taker * 100); if (f.maker != null) S.fees.maker = r3(f.maker * 100); if (f.slippage_per_side != null) S.fees.slip = r3(f.slippage_per_side * 100); }
  const d = obj.dashboard || {};
  if (Array.isArray(d.watchlist) && d.watchlist.length) S.watch = d.watchlist.map(String);
  if (d.position) S.pos = Object.assign({}, DEFAULT_POS, d.position);
  if (Array.isArray(d.alerts)) S.alerts = d.alerts.map(a => ({ id: uid(), product: a.product, cond: a.cond, value: num(a.value), on: !!a.on }));
  if (d.spike_threshold_pct) S.spikeTh = num(d.spike_threshold_pct, 3);
  save(); boot(true);
  toast(`Imported ${rules.length} rule(s)${note}`);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length); let ok = false; try { ok = document.execCommand('copy'); } catch (x) {} ta.remove(); return ok;
  }
}

/* ---------------------------------------------------------------- chart sheet */
let sheetP = null, sheetG = 3600, sheetData = { k: '', c: [], t: 0 };
async function openSheet(p) {
  sheetP = p; $('#sheet').hidden = false;
  $('#shTitle').innerHTML = `${esc(p)} <span class="row gap" style="display:inline-flex;margin-left:8px"><button class="btn sm gold" type="button" data-buy="${esc(p)}">BUY</button><button class="btn sm crim" type="button" data-sell="${esc(p)}">SELL</button></span>`;
  $('#shStats').innerHTML = '<div class="sm mut">Loading candles…</div>';
  await loadSheet(); drawChart();
}
async function loadSheet() {
  const k = sheetP + ':' + sheetG;
  if (sheetData.k !== k || Date.now() - sheetData.t > 60e3) { try { sheetData = { k, c: await loadCandles(sheetP, sheetG), t: Date.now() }; } catch (e) { toast('Could not load candles: ' + e.message, 'dn'); } }
}
function drawChart() {
  if (!sheetP) return;
  const m = md(sheetP), all = sheetData.c.slice(); if (!all.length) return;
  const last = all[all.length - 1];
  if (Number.isFinite(m.price)) { last.c = m.price; last.h = Math.max(last.h, m.price); last.l = Math.min(last.l, m.price); }
  const cv = $('#chart'), [x, w, h] = fitCanvas(cv), n = Math.min(all.length, Math.max(24, Math.floor((w - 50) / 5))), C = all.slice(-n);
  const lines = [];
  if (sheetP === S.pos.product) { const pc = posCalc(); lines.push([S.pos.tp, 'TP', '#D4AF37'], [S.pos.sl, 'STOP', '#E0283E'], [pc.beT, 'B/E', '#F3D57A'], [S.pos.entry, 'ENTRY', '#A8A8A8']); }
  let lo = Math.min(...C.map(c => c.l)), hi = Math.max(...C.map(c => c.h));
  lines.forEach(([v]) => { if (Number.isFinite(v) && v > lo * 0.97 && v < hi * 1.03) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
  const pad = (hi - lo) * 0.06 || hi * 0.01; lo -= pad; hi += pad;
  const pw = w - 52, Y = v => 8 + (1 - (v - lo) / (hi - lo)) * (h - 24), bw = pw / C.length;
  x.font = '600 10px Rajdhani, sans-serif'; x.textAlign = 'left';
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, y = Y(v); x.strokeStyle = 'rgba(46,46,46,.9)'; x.beginPath(); x.moveTo(0, y); x.lineTo(pw, y); x.stroke(); x.fillStyle = '#A8A8A8'; x.fillText(fp(v), pw + 4, y + 3); }
  C.forEach((c, i) => { const cx = i * bw + bw / 2, up = c.c >= c.o, col = up ? '#D4AF37' : '#B11226';
    x.strokeStyle = '#A8A8A8'; x.beginPath(); x.moveTo(cx, Y(c.h)); x.lineTo(cx, Y(c.l)); x.stroke();
    x.fillStyle = col; const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c)); x.fillRect(cx - Math.max(1, bw * 0.35), y1, Math.max(2, bw * 0.7), Math.max(1, y2 - y1)); });
  lines.forEach(([v, l, col]) => { if (!Number.isFinite(v) || v < lo || v > hi) return; const y = Y(v); x.strokeStyle = col; x.setLineDash([4, 4]); x.beginPath(); x.moveTo(0, y); x.lineTo(pw, y); x.stroke(); x.setLineDash([]); x.fillStyle = col; x.fillText(l, 4, y - 3); });
  if (Number.isFinite(m.price)) { const y = Y(m.price); x.fillStyle = '#B11226'; x.fillRect(pw + 1, y - 7, 51, 14); x.fillStyle = '#fff'; x.font = '700 10px Rajdhani, sans-serif'; x.fillText(fp(m.price), pw + 4, y + 3); }
  const lbl = { 300: '5m', 3600: '1h', 86400: '1d' }[sheetG];
  $('#shStats').innerHTML = [['Bid', fp(m.bid)], ['Ask', fp(m.ask)], ['Spread', Number.isFinite(m.ask) ? fpct((m.ask / m.bid - 1) * 100, 3).replace('+', '') : '—'],
    ['24h', fpct(m.ch24)], ['1h', fpct(m.ch1h)], ['RSI 1h', Number.isFinite(m.rsi1h) ? m.rsi1h.toFixed(1) : '—'], ['24h high', fp(m.high24)], ['24h low', fp(m.low24)],
    [`Bars (${lbl})`, C.length]].map(([a, b]) => `<div><div class="lbl">${a}</div><div class="val">${b}</div></div>`).join('');
}

/* ---------------------------------------------------------------- watchlist management */
function normProduct(s) { s = String(s || '').trim().toUpperCase().replace(/[\/\s]+/g, '-'); if (!s) return ''; if (!s.includes('-')) s += '-USD'; return s; }
async function addProduct(raw) {
  const p = normProduct(raw); if (!p) return;
  if (S.watch.includes(p)) return toast(p + ' is already on the watchlist');
  try { const d = await api('/products/' + p); if (d.status && d.status !== 'online') return toast(`${p} is ${d.status} on Coinbase`, 'dn'); }
  catch (e) { return toast(`${p} not found on Coinbase Exchange`, 'dn'); }
  S.watch.push(p); save(); buildCards(); wsSub('subscribe', p);
  loadStats(p).catch(() => {}); refreshCandles(p, true); toast('Added ' + p);
}
function removeProduct(p) { S.watch = S.watch.filter(x => x !== p); save(); wsSub('unsubscribe', p); buildCards(); }
async function validateWatch() { // drop defaults that do not exist (e.g. MET-USD if delisted)
  for (const p of S.watch.slice()) { try { await api('/products/' + p); } catch (e) { if (e.status === 404 || e.status === 400) { removeProduct(p); toast(`${p} does not exist on Coinbase; removed`, 'dn'); } } }
}


/* ---------------------------------------------------------------- top gainers / losers (public /products + /products/stats) */
async function refreshGainers() {
  try {
    let prods;
    if (S.productsAt && Date.now() - S.productsAt < PRODUCT_TTL && Object.keys(S.products).length) {
      prods = null; // reuse S.products
    } else {
      prods = await api('/products');
    }
    const stats = await api('/products/stats');
    const map = S.products && !prods ? S.products : {};
    if (prods) {
      for (const x of prods) {
        if (x.quote_currency !== 'USD' || x.status !== 'online' || x.trading_disabled || x.cancel_only || x.auction_mode) continue;
        map[x.id] = x;
      }
      S.products = map; S.productsAt = Date.now();
    }
    const rows = [];
    for (const id of Object.keys(map)) {
      const st = (stats[id] && stats[id].stats_24hour) || null; if (!st) continue;
      const open = num(st.open, NaN), last = num(st.last, NaN), high = num(st.high, NaN), low = num(st.low, NaN), vol = num(st.volume, 0);
      if (!(open > 0) || !(last > 0)) continue;
      const ch = (last / open - 1) * 100, volUsd = vol * last;
      const m = md(id);
      if (!m.lastTick) { m.price = last; m.open24 = open; m.high24 = high; m.low24 = low; m.vol24 = vol; m.ch24 = ch; m.lastTick = Date.now(); m.src = 'rest'; }
      else { m.open24 = open; m.high24 = high; m.low24 = low; m.vol24 = vol; m.ch24 = Number.isFinite(m.price) ? (m.price / open - 1) * 100 : ch; }
      rows.push({ id, ch, volUsd, open, last, high, low, vol, minFunds: num(map[id].min_market_funds, 1) });
    }

    // annotate with thin/volSpike defaults; deeper signals filled for visible set
    for (const r of rows) { r.thin = false; r.volSpike = false; r.imbalance = NaN; r.trend = '—'; r.signal = 'neutral'; r.score = scoreRow(r); }
    S.gainers = rows; S.gainUpdated = Date.now();
    const top = [...rows].sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch)).slice(0, 30).map(r => r.id);
    const need = top.filter(p => !S.watch.includes(p));
    if (need.length && S.ws && S.wsOpen) S.ws.send(JSON.stringify({ type: 'subscribe', product_ids: need, channels: ['ticker'] }));
    const vis = rankedGainers().slice(0, 15);
    for (const r of vis) loadTicker(r.id).catch(() => {});
    await enrichVisible(vis.map(r => r.id));
    renderGainers();
    const meta = $('#gainMeta'); if (meta) meta.textContent = `${rows.filter(r => r.volUsd >= S.minVol).length} liquid USD pairs · updated ${new Date(S.gainUpdated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  } catch (e) { console.warn('gainers', e); toast('Could not load gainers: ' + e.message, 'dn'); }
}
function feeHurdle() { return edge(0, 0).costTp; } // ~1.49% Intro TP round-trip
function scoreRow(r) {
  // momentum vs fee: reward move above fee hurdle, penalize extension past 20%, boost volume
  const hurdle = feeHurdle();
  const mag = Math.abs(r.ch);
  const edgePts = mag - hurdle;
  const extendPen = mag > 20 ? (mag - 20) * 0.8 : 0;
  const volBoost = Math.min(2, Math.log10(Math.max(r.volUsd, 1) / 1e6 + 1));
  const thinPen = r.thin ? 3 : 0;
  return edgePts - extendPen + volBoost - thinPen;
}
function classifyRow(r, m) {
  const hurdle = feeHurdle();
  const ch = Number.isFinite(m && m.open24) && m.open24 > 0 && Number.isFinite(m.price) ? (m.price / m.open24 - 1) * 100 : r.ch;
  const nearHigh = Number.isFinite(m && m.high24) && Number.isFinite(m.price) && m.price >= m.high24 * 0.98;
  if (ch >= 30 || (ch >= 20 && nearHigh)) return 'chasing';
  // fee-clearing: dip-like (negative short) or calm uptrend with room, and |move| not already past fees on a chase
  if (r.signal === 'fee-clear' || (r.volSpike && ch > hurdle && ch < 15 && !nearHigh)) return 'fee-clear';
  if (ch > hurdle && ch < 20 && !nearHigh && !r.thin) return 'fee-clear';
  return 'neutral';
}
function rankedGainers() {
  const floor = S.minVol, mode = S.gainMode;
  let rows = S.gainers.filter(r => r.volUsd >= floor);
  if (S.exHot && mode === 'gain') rows = rows.filter(r => r.ch <= 30);
  rows = rows.slice().map(r => Object.assign({}, r, { score: scoreRow(r) }));
  if (mode === 'lose') rows.sort((a, b) => a.ch - b.ch);
  else if (S.rankBy === 'ch24') rows.sort((a, b) => b.ch - a.ch);
  else rows.sort((a, b) => b.score - a.score);
  return rows;
}
function renderGainers() {
  const box = $('#gainers'); if (!box) return;
  const rows = rankedGainers().slice(0, 15);
  const title = $('#gainTitle'); if (title) title.textContent = S.gainMode === 'lose' ? 'Top losers' : 'Top gainers';
  box.innerHTML = rows.length ? rows.map((r, i) => {
    const m = md(r.id), px = Number.isFinite(m.price) ? m.price : r.last;
    const ch = Number.isFinite(m.open24) && m.open24 > 0 && Number.isFinite(m.price) ? (m.price / m.open24 - 1) * 100 : r.ch;
    const spread = (Number.isFinite(m.bid) && Number.isFinite(m.ask) && m.bid > 0) ? (m.ask / m.bid - 1) * 100 : NaN;
    const on = S.watch.includes(r.id);
    const label = r.signal === 'fee-clear' ? '<span class="badge sig">FEE-CLEAR</span>' : r.signal === 'chasing' ? '<span class="badge spike">CHASING</span>' : '<span class="badge neutral">NEUTRAL</span>';
    const thin = r.thin ? '<span class="badge thin">THIN BOOK</span>' : '';
    const volb = r.volSpike ? `<span class="badge spike">VOL×${Number.isFinite(r.volMult) ? r.volMult.toFixed(1) : '2+'}</span>` : '';
    const imb = Number.isFinite(r.imbalance) ? `<span>Book ${r.imbalance >= 0 ? 'bid' : 'ask'} ${(Math.abs(r.imbalance) * 100).toFixed(0)}%</span>` : '';
    return `<div class="card gainer" data-p="${esc(r.id)}">
      <div class="sym"><span class="rank">#${i + 1}</span>${esc(sym(r.id))}<small>USD</small></div>
      <div class="px ${cls(ch)}">${fp(px)}</div>
      <div class="meta"><span class="${cls(ch)}">24h ${fpct(ch)}</span><span>Vol ${fum(r.volUsd)}</span><span>Spread ${Number.isFinite(spread) ? fpct(spread, 3).replace('+','') : '—'}</span><span class="sm">score ${r.score != null ? r.score.toFixed(1) : '—'}</span></div>
      <div class="sigrow">${label}${thin}${volb}<span class="sm mut">MTF ${esc(r.trend || '—')}</span>${imb}</div>
      <div class="acts">
        <button class="btn gold" type="button" data-buy="${esc(r.id)}">BUY</button>
        <button class="btn crim" type="button" data-sell="${esc(r.id)}">SELL</button>
        <button class="btn" type="button" data-add="${esc(r.id)}" ${on ? 'disabled' : ''}>${on ? 'On list' : 'Add to watchlist'}</button>
      </div></div>`;
  }).join('') : '<div class="sm mut">No pairs clear the volume floor. Lower Min 24h USD vol, or wait for the next refresh.</div>';
  requestAnimationFrame(() => observeGainers());
}
const _dirtyOrig = dirty;
dirty = function (p) {
  _dirtyOrig(p);
  if (S.tab === 'gainers' && S.gainers.some(r => r.id === p)) {
    const el = $(`.gainer[data-p="${CSS.escape(p)}"]`);
    if (el) {
      const m = md(p), ch = Number.isFinite(m.open24) && m.open24 > 0 ? (m.price / m.open24 - 1) * 100 : m.ch24;
      const px = $('.px', el); if (px) { px.textContent = fp(m.price); px.className = 'px ' + cls(ch); }
    }
  }
  if (S.order && S.order.product === p && !$('#order').hidden) paintOrder();
};


async function loadBook(p) {
  try {
    const d = await api(`/products/${p}/book?level=2`);
    const bids = (d.bids || []).slice(0, 20).map(x => ({ px: num(x[0]), sz: num(x[1]) }));
    const asks = (d.asks || []).slice(0, 20).map(x => ({ px: num(x[0]), sz: num(x[1]) }));
    const bidDepth = bids.reduce((a, b) => a + b.sz * b.px, 0), askDepth = asks.reduce((a, b) => a + b.sz * b.px, 0);
    const tot = bidDepth + askDepth;
    const imbalance = tot > 0 ? (bidDepth - askDepth) / tot : NaN;
    const m = md(p); m.book = { bidDepth, askDepth, imbalance, topBid: bids[0] && bids[0].px, topAsk: asks[0] && asks[0].px, at: Date.now() };
    return m.book;
  } catch (e) { return null; }
}
async function enrichVisible(ids) {
  const hurdle = feeHurdle();
  for (const id of ids) {
    const r = S.gainers.find(x => x.id === id); if (!r) continue;
    const m = md(id);
    // candles for vol spike + MTF trend (reuse cache)
    try {
      if (!m.c5.length || Date.now() - m.lastC5 > 10 * 60e3) await refreshCandles(id, false);
    } catch (e) {}
    const closes = (m.c5.length ? m.c5 : m.c1h).map(c => c.c);
    const vols = (m.c5.length ? m.c5 : m.c1h).map(c => c.v);
    const ind = await callWorker(closes, vols);
    if (ind && ind.vol) { r.volSpike = !!ind.vol.spike; r.volMult = ind.vol.mult; }
    if (ind && Number.isFinite(ind.rsi14)) m.rsi5 = ind.rsi14;
    // MTF trend: 5m ema20 vs ema50, 1h close vs ema200-ish, 1d from last 24 1h bars slope
    const c5 = m.c5.map(c => c.c), c1 = m.c1h.map(c => c.c);
    let t5 = 'flat', t1 = 'flat', tD = 'flat';
    if (c5.length >= 50) { const e20 = ind.ema20, e50 = ind.ema50; t5 = e20 > e50 ? 'up' : e20 < e50 ? 'down' : 'flat'; }
    if (c1.length >= 30) { const last = c1[c1.length - 1], ago = c1[c1.length - 24] || c1[0]; t1 = last > ago * 1.005 ? 'up' : last < ago * 0.995 ? 'down' : 'flat'; }
    if (c1.length >= 24) { const day = c1.slice(-24); tD = day[day.length - 1] > day[0] * 1.01 ? 'up' : day[day.length - 1] < day[0] * 0.99 ? 'down' : 'flat'; }
    r.trend = `${t5}/${t1}/${tD}`;
    // order book
    const book = (!m.book || Date.now() - m.book.at > 60e3) ? await loadBook(id) : m.book;
    if (book) {
      r.imbalance = book.imbalance;
      r.thin = book.bidDepth + book.askDepth < 25000; // <$25k top-20 depth each side combined
    }
    // label
    const nearHigh = Number.isFinite(m.high24) && Number.isFinite(m.price) && m.price >= m.high24 * 0.98;
    if (r.ch >= 30 || (r.ch >= 20 && nearHigh)) r.signal = 'chasing';
    else if (r.volSpike && r.ch > hurdle && r.ch < 15 && !nearHigh && !r.thin && (t5 === 'up' || t1 === 'up')) r.signal = 'fee-clear';
    else if (r.ch > hurdle && r.ch < 18 && !nearHigh && !r.thin && t1 !== 'down') r.signal = 'fee-clear';
    else r.signal = 'neutral';
    r.score = scoreRow(r);
  }
}

/* ---------------------------------------------------------------- order sheet + Confirm & send (= Daryell approval) */
function availableCash() { const P = S.pos; return r3((num(P.usd) || 0) + (num(P.usdc) || 0) || num(P.cash)); }
function openOrder(product, side, role) {
  const m = md(product);
  S.order = {
    product, side: side || 'BUY', type: 'MARKET', role: ROLES[role] ? role : 'manual',
    amount: side === 'SELL' ? (product === S.pos.product ? S.pos.qty : 0) : Math.max(1, Math.min(5, availableCash() || 1)),
    limit: side === 'SELL' ? (m.bid || m.price) : (m.ask || m.price),
    bracket: false, tp: '', sl: ''
  };
  if (product === S.pos.product && side === 'SELL') { S.order.bracket = true; S.order.tp = S.pos.tp; S.order.sl = S.pos.sl; }
  $('#order').hidden = false; $('#confirm').hidden = true;
  paintOrder(); buzz(10);
}
function paintOrder() {
  const o = S.order; if (!o) return;
  const m = md(o.product), P = S.pos;
  $('#orTitle').textContent = `${o.side} ${o.product}`;
  $$('#orSide button').forEach(b => b.classList.toggle('on', b.dataset.side === o.side));
  $$('#orType button').forEach(b => b.classList.toggle('on', b.dataset.type === o.type));
  const f = $('#orForm');
  // label first text node
  const amtL = $('#orAmtL'); if (amtL) { const tn = [...amtL.childNodes].find(n => n.nodeType === 3); if (tn) tn.textContent = o.side === 'BUY' ? 'Amount (USD)' : `Size (${sym(o.product)})`; }
  f.amount.value = o.amount; f.limit.value = o.limit; f.bracket.checked = !!o.bracket;
  $('#orLimL').hidden = o.type !== 'LIMIT'; $('#orBrackets').hidden = !o.bracket;
  f.tp.value = o.tp; f.sl.value = o.sl;
  const est = orderEstimate(o);
  $('#orEstGrid').innerHTML = [
    ['Live mid', fp(m.price)], ['Bid / ask', `${fp(m.bid)} / ${fp(m.ask)}`],
    ['Est. fill', fp(est.fill)], ['Est. base size', est.base.toFixed(6)],
    ['Fee (this leg)', fusd(est.fee) + ` (${(est.feePct * 100).toFixed(2)}%)`],
    ['Net cost / proceeds', fusd(est.net)],
    ['Available cash', fusd(guardCash())],
    ['Break-even (round trip)', o.side === 'BUY' && Number.isFinite(est.be) ? fp(est.be) : '—'],
    ['If TP fills (net)', o.bracket && o.tp ? fsusd(est.atTp) : '—'],
    ['If stop fills (net)', o.bracket && o.sl ? fsusd(est.atSl) : '—']
  ].map(([a, b]) => `<div><div class="lbl">${a}</div><div class="val">${b}</div></div>`).join('');
  const warns = [];
  if (o.side === 'BUY' && est.notional < 1) warns.push(`Size $${est.notional.toFixed(2)} is under Coinbase’s $1 minimum market order.`);
  if (o.side === 'BUY' && est.notional > guardCash() + 1e-9) warns.push(`Size exceeds available cash (${fusd(guardCash())}). Edit free USD/USDC on the Position tab or the cash field on Confirm, or lower the amount.`);
  if (o.side === 'SELL' && o.product === P.product && o.amount > P.qty + 1e-9) warns.push(`Sell size ${o.amount} exceeds your holding of ${P.qty} ${sym(o.product)}.`);
  const ch24 = Number.isFinite(m.open24) && m.open24 > 0 && Number.isFinite(m.price) ? (m.price / m.open24 - 1) * 100 : m.ch24;
  if (Number.isFinite(ch24) && ch24 >= 20 && Number.isFinite(m.high24) && m.price >= m.high24 * 0.98)
    warns.push(`Spike already run: +${ch24.toFixed(1)}% in 24h and within 2% of the 24h high (${fp(m.high24)}). Buying here is chasing.`);
  if (o.bracket && o.tp && o.side === 'BUY' && est.fill > 0) {
    const tpPct = (num(o.tp) / est.fill - 1) * 100, slPct = o.sl ? (1 - num(o.sl) / est.fill) * 100 : 2, e = edge(tpPct, slPct);
    if (!e.clears) warns.push(`TP ${fp(num(o.tp))} (${fpct(tpPct)}) is below round-trip fees (~${e.costTp.toFixed(2)}%). This bracket loses money even when it wins.`);
  }
  const w = $('#orWarn'); if (warns.length) { w.hidden = false; w.innerHTML = warns.map(t => '⚠ ' + esc(t)).join('<br>'); } else { w.hidden = true; w.innerHTML = ''; }
  const a = $('#orCb'); a.href = cbTradeUrl(o.product); a.textContent = 'Open in Coinbase';
}
function orderEstimate(o) {
  const m = md(o.product), { tk, mk } = feesFrac();
  const feePct = o.type === 'LIMIT' ? mk : tk;
  let fill = o.type === 'LIMIT' && num(o.limit) > 0 ? num(o.limit) : (o.side === 'BUY' ? (m.ask || m.price) : (m.bid || m.price));
  if (!(fill > 0)) fill = m.price || 0;
  let notional, base;
  if (o.side === 'BUY') { notional = num(o.amount); base = fill > 0 ? notional * (1 - feePct) / fill : 0; }
  else { base = num(o.amount); notional = base * fill; }
  const fee = notional * feePct;
  const net = o.side === 'BUY' ? notional : notional * (1 - feePct);
  const be = o.side === 'BUY' && base > 0 ? notional / (base * (1 - mk)) : NaN;
  const atTp = o.bracket && o.tp ? base * num(o.tp) * (1 - mk) - (o.side === 'BUY' ? notional : 0) : NaN;
  const atSl = o.bracket && o.sl ? base * num(o.sl) * (1 - tk) - (o.side === 'BUY' ? notional : 0) : NaN;
  return { fill, base, notional, fee, feePct, net, be, atTp, atSl };
}
function orderRequestText(o) {
  const amt = o.side === 'BUY' ? `$${num(o.amount).toFixed(2)}` : `${num(o.amount)} ${sym(o.product)}`;
  const lim = o.type === 'LIMIT' ? ` @ ${fp(num(o.limit))}` : '';
  const br = o.bracket && (o.tp || o.sl) ? ` (bracket TP ${o.tp || '—'} / SL ${o.sl || '—'})` : '';
  const fe = feeEdge(o);
  return `HYDRA ORDER REQUEST (APPROVED BY DARYELL): ${o.side} ${o.product} ${amt} ${o.type}${lim}${br}. Preview, then place if the preview matches.` +
    ` [proposed_by: ${o.role || 'manual'} · authorized_by: daryell · fee_edge: ${feeEdgeLabel(fe)}]`;
}
function readOrderForm() {
  const o = S.order, f = $('#orForm'); if (!o || !f) return;
  o.amount = num(f.amount.value); o.limit = num(f.limit.value); o.bracket = !!f.bracket.checked; o.tp = f.tp.value; o.sl = f.sl.value;
}
function openConfirm() {
  readOrderForm(); paintOrder();
  const o = S.order, est = orderEstimate(o), req = orderRequestText(o);
  $('#cfSummary').innerHTML = [
    ['Side', o.side], ['Product', o.product], ['Type', o.type + (o.type === 'LIMIT' ? ` @ ${fp(o.limit)}` : '')],
    ['Amount', o.side === 'BUY' ? fusd(o.amount) : `${o.amount} ${sym(o.product)}`],
    ['Est. fill', fp(est.fill)], ['Est. fee', fusd(est.fee) + ` (${(est.feePct * 100).toFixed(2)}%)`],
    ['Est. base', est.base.toFixed(6)],
    ['Bracket', o.bracket ? `TP ${o.tp || '—'} / SL ${o.sl || '—'}` : 'none'],
    ['Available cash', fusd(guardCash()) + (guardCashEntered() ? ' (entered)' : ' (last known)')],
    ['Proposed by', ROLES[o.role] || o.role || 'manual']
  ].map(([a, b]) => `<div class="line"><span>${esc(a)}</span><b>${esc(String(b))}</b></div>`).join('') +
    `<div class="req">${esc(req)}</div>`;
  if ($('#cfRole')) $('#cfRole').value = o.role || 'manual';
  $('#cfHint').hidden = true; $('#order').hidden = true; $('#confirm').hidden = false;
  applyRiskUI();
}
async function confirmAndSend() {
  const o = S.order; if (!o) return;
  const risk = riskCheck(o);
  if (!risk.ok) { applyRiskUI(); toast(risk.reasons[0], 'dn'); return; }
  const req = orderRequestText(o);
  const ok = await copyText(req);
  S.cooldowns[o.product] = Date.now(); save();   // v3.1 cooldown starts once a request is copied
  logJournal(o, req);
  buzz([20, 40, 20]);
  $('#cfHint').hidden = false;
  $('#cfHint').textContent = ok
    ? 'Copied. Paste it into your Grok Bot chat now. That paste is your approval for this exact order; Grok Bot will preview, then place if the preview matches.'
    : 'Copy blocked. Select the request text above and copy it, then paste into the Grok Bot chat.';
  fire(`${o.side} ${o.product} approved for Grok Bot`, req, o.side === 'SELL' ? 'dn' : 'up', req);
  toast(ok ? 'Approved request copied — paste into Grok Bot chat' : 'Select & copy the request, then paste into chat');
  applyRiskUI();   // shows the new cooldown and disables a duplicate send
}


/* ---------------------------------------------------------------- v3.1 guards (clean-room patterns; see README "Repo integrations")
 * cooldown lock + pre-trade balance check: pattern noted in Solrikk/Cripto-Boats (MIT); reimplemented, no code copied.
 * Cripto-Boats sized every trade at 30% of free balance (risk_percentage=0.3); HYDRA defaults to 10% of portfolio and blocks above it.
 * Evidence tags + proposer/authorizer attribution mirror the CSM-Omega ledger (PREDICTION -> VERIFIED/DISPROVEN). */
const EDGE_GATE_DEFAULT = 2.0;
const ROLES = { manual: 'manual (Daryell)', gainers_scanner: 'gainers scanner', bot_rule: 'bot rule alert', grok_bot: 'Grok Bot suggestion' };
const tfmt = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function guardCashEntered() { const o = S.risk.cashOverride; return o !== null && o !== undefined && o !== '' && Number.isFinite(+o) && +o >= 0; }
function guardCash() { return guardCashEntered() ? r3(+S.risk.cashOverride) : availableCash(); }
function portfolioValue() {
  const P = S.pos, m = md(P.product), px = Number.isFinite(m.bid) ? m.bid : Number.isFinite(m.price) ? m.price : num(P.entry);
  return guardCash() + num(P.qty) * (px || 0);
}
function cooldownState(product, now = Date.now()) {
  const mins = Math.max(0, num(S.risk.cooldownMin, 30)), t = num(S.cooldowns[product], 0);
  if (!mins || !t) return { active: false, mins };
  const until = t + mins * 60e3;
  return { active: now < until, mins, since: t, until, leftMin: Math.max(1, Math.ceil((until - now) / 60e3)) };
}
function feeEdge(o) {
  const { tk, mk, s } = feesFrac(), entry = o.type === 'LIMIT' ? mk : tk, buy = (1 + s) * (1 + entry);
  const rtTp = (1 - (1 - s) * (1 - mk) / buy) * 100, rtSl = (1 - (1 - s) * (1 - tk) / buy) * 100;
  const gate = Math.max(0, num(S.risk.edgeGate, EDGE_GATE_DEFAULT));
  const est = orderEstimate(o);
  const tpPct = o.side === 'BUY' && o.bracket && num(o.tp) > 0 && est.fill > 0 ? (num(o.tp) / est.fill - 1) * 100 : NaN;
  const netTp = Number.isFinite(tpPct) ? ((1 + tpPct / 100) * (1 - s) * (1 - mk) / buy - 1) * 100 : NaN;
  const status = o.side !== 'BUY' ? 'n/a' : !Number.isFinite(tpPct) ? 'no-tp' : tpPct < gate ? 'below' : 'ok';
  return { entryPct: entry * 100, entryKind: o.type === 'LIMIT' ? 'maker' : 'taker', makerPct: mk * 100, takerPct: tk * 100, slipPct: s * 100,
    rtTp, rtSl, gate, tpPct, netTp, status, below: status === 'below' };
}
function feeEdgeLabel(fe) {
  if (fe.status === 'below') return `BELOW FEE EDGE (TP ${fpct(fe.tpPct)} < ${fe.gate.toFixed(2)}% gate; round trip ${fe.rtTp.toFixed(2)}%)`;
  if (fe.status === 'ok') return `OK (TP ${fpct(fe.tpPct)} >= ${fe.gate.toFixed(2)}% gate)`;
  if (fe.status === 'no-tp') return `UNVERIFIED (no TP set; gate ${fe.gate.toFixed(2)}%)`;
  return 'n/a (sell)';
}
function sizeCheck(o) {
  const reasons = [], est = orderEstimate(o), cash = guardCash(), pv = portfolioValue(), pct = Math.max(0, num(S.risk.maxPortfolioPct, 10)), cap = pv * pct / 100;
  if (o.side === 'BUY') {
    if (est.notional > cash + 1e-9) reasons.push(`CASH · Order ${fusd(est.notional)} exceeds available cash ${fusd(cash)}${guardCashEntered() ? ' (entered)' : ' (last known)'}.`);
    if (pct > 0 && est.notional > cap + 1e-9) reasons.push(pv > 0
      ? `SIZE · Order ${fusd(est.notional)} is ${(est.notional / pv * 100).toFixed(1)}% of your ${fusd(pv)} portfolio; max ${pct}% per trade = ${fusd(cap)}.`
      : `SIZE · Portfolio value is unknown or $0, so ${pct}% per trade cannot be met.`);
  } else if (o.product === S.pos.product && num(o.amount) > num(S.pos.qty) + 1e-9) {
    reasons.push(`SIZE · Sell ${num(o.amount)} exceeds your holding of ${S.pos.qty} ${sym(o.product)}.`);
  }
  return { reasons, cash, pv, pct, cap, notional: est.notional };
}
function renderGuard() {
  const o = S.order; if (!o || !$('#edgeBox')) return;
  const fe = feeEdge(o), sc = sizeCheck(o), cd = cooldownState(o.product);
  const box = $('#edgeBox');
  box.className = 'card edgebox ' + (fe.status === 'below' || fe.status === 'no-tp' ? 'warn' : fe.status === 'ok' ? 'ok' : '');
  box.dataset.status = fe.status;
  const head = fe.status === 'below' ? `<b class="dn">BELOW FEE EDGE</b> · TP ${fpct(fe.tpPct)} is under the ${fe.gate.toFixed(2)}% edge gate (round trip ${fe.rtTp.toFixed(2)}%). Net if TP fills ≈ <b class="${cls(fe.netTp)}">${fpct(fe.netTp)}</b>.`
    : fe.status === 'ok' ? `<b class="up">Clears the fee edge</b> · TP ${fpct(fe.tpPct)} ≥ ${fe.gate.toFixed(2)}% gate. Net if TP fills ≈ <b class="${cls(fe.netTp)}">${fpct(fe.netTp)}</b>.`
    : fe.status === 'no-tp' ? `<b class="dn">Fee edge UNVERIFIED</b> · no take-profit set. Add a bracket TP at least ${fe.gate.toFixed(2)}% above the fill.`
    : `Sell leg · exit fee ${fe.takerPct.toFixed(2)}% (${o.type === 'LIMIT' ? 'maker ' + fe.makerPct.toFixed(2) + '% if limit' : 'taker'}). The edge gate applies to buys.`;
  box.innerHTML = `<div class="lbl">Fee edge · Intro tier</div>
    <div class="sm">Entry ${fe.entryKind} ${fe.entryPct.toFixed(2)}% · TP exit maker ${fe.makerPct.toFixed(2)}% · stop exit taker ${fe.takerPct.toFixed(2)}% · slippage ${fe.slipPct.toFixed(2)}%/side</div>
    <div class="sm">Round trip: <b class="gold">${fe.rtTp.toFixed(2)}%</b> if TP fills · <b class="dn">${fe.rtSl.toFixed(2)}%</b> if stopped · edge gate <b>${fe.gate.toFixed(2)}%</b></div>
    <div class="sm" id="edgeVerdict">${head}</div>`;
  $('#guardInfo').innerHTML = `Cash ${fusd(sc.cash)} ${guardCashEntered() ? '(entered)' : '(last known)'} · portfolio ${fusd(sc.pv)} · max ${sc.pct}% = ${fusd(sc.cap)} per trade · cooldown ${cd.mins} min${cd.active ? ` · <b class="dn">ACTIVE until ${tfmt(cd.until)}</b>` : ''}`;
}
function jEvidence(j) { return ['PREDICTION', 'VERIFIED', 'DISPROVEN'].includes(j.evidence) ? j.evidence : 'PREDICTION'; }
function journalPrediction(o) {
  const fe = feeEdge(o);
  if (o.side === 'BUY') return `PREDICTION: this ${o.product} buy closes net-positive after Intro fees${Number.isFinite(fe.tpPct) ? ` (TP ${fpct(fe.tpPct)}, fee edge ${fe.status})` : ' (no TP set)'}.`;
  return `PREDICTION: this ${o.product} sell is the better exit after fees.`;
}
function markOutcome(j, ev) {
  if (!['PREDICTION', 'VERIFIED', 'DISPROVEN'].includes(ev)) return { ok: false, reason: 'unknown evidence status' };
  if (ev !== 'PREDICTION' && (j.fill === '' || j.fill == null || j.exit === '' || j.exit == null))
    return { ok: false, reason: 'Enter the fill and exit prices first: VERIFIED/DISPROVEN needs evidence.' };
  j.evidence = ev; j.evidence_at = Date.now(); j.evidence_by = 'daryell';
  save(); renderJournal(); applyRiskUI();
  return { ok: true };
}
Object.assign(window.HMD, { feeEdge, sizeCheck, cooldownState, portfolioValue, guardCash, markOutcome, riskCheck: o => riskCheck(o) });

/* ---------------------------------------------------------------- trade journal + risk limits */
function journalStats() {
  const closed = S.journal.filter(j => j.fill != null && j.exit != null && j.fill !== '' && j.exit !== '');
  let wins = 0, pnl = 0;
  for (const j of closed) { const n = journalNet(j); if (Number.isFinite(n)) { pnl += n; if (n > 0) wins++; } }
  return { n: S.journal.length, closed: closed.length, wins, winRate: closed.length ? wins / closed.length * 100 : NaN, pnl };
}
function journalNet(j) {
  const { tk, mk } = feesFrac();
  const fill = num(j.fill), exit = num(j.exit), amt = num(j.amount);
  if (!(fill > 0) || !(exit > 0) || !(amt > 0)) return NaN;
  if (j.side === 'BUY') {
    // bought notional amt USD (taker), sold at exit (maker if limit else taker) — assume exit type from j.exitType or maker
    const feeIn = j.type === 'LIMIT' ? mk : tk;
    const feeOut = (j.exitType === 'MARKET' || j.exitType === 'STOP') ? tk : mk;
    const base = amt * (1 - feeIn) / fill;
    return base * exit * (1 - feeOut) - amt;
  } else {
    // sold base amt at fill, optional buyback at exit ignored unless exit set as cover
    const feeOut = j.type === 'LIMIT' ? mk : tk;
    return amt * fill * (1 - feeOut) - (j.costBasis != null ? num(j.costBasis) : amt * fill); // without cost basis, mark proceeds only after fee vs fill notional = -fee
  }
}
function renderJournal() {
  const st = journalStats();
  $('#jCount').textContent = `${st.closed}/${st.n}`;
  $('#jWin').textContent = Number.isFinite(st.winRate) ? st.winRate.toFixed(0) + '%' : '—';
  $('#jPnl').textContent = fsusd(st.pnl); $('#jPnl').className = 'val ' + cls(st.pnl);
  if ($('#jEv')) { const c = { PREDICTION: 0, VERIFIED: 0, DISPROVEN: 0 }; S.journal.forEach(j => { c[jEvidence(j)] = (c[jEvidence(j)] || 0) + 1; });
    $('#jEv').textContent = `Evidence: ${c.PREDICTION} PREDICTION · ${c.VERIFIED} VERIFIED · ${c.DISPROVEN} DISPROVEN`; }
  const box = $('#journal');
  box.innerHTML = S.journal.length ? S.journal.map(j => {
    const net = journalNet(j);
    return `<div class="it ${j.side === 'SELL' ? 'dn' : ''}" data-jid="${j.id}">
      <time>${new Date(j.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
      <b>${esc(j.side)} ${esc(j.product)}</b> ${j.side === 'BUY' ? fusd(j.amount) : j.amount + ' ' + sym(j.product)} ${esc(j.type)}
      <div class="jtags"><span class="badge ev ev-${esc(jEvidence(j).toLowerCase())}" data-ev="${esc(jEvidence(j))}">${esc(jEvidence(j))}</span><span class="badge neutral">role: ${esc(j.proposed_by_role || 'unknown (pre-v3.1)')}</span>${j.fee_edge === 'below' ? '<span class="badge thin">BELOW FEE EDGE</span>' : ''}</div>
      <div class="sm mut">${esc(j.prediction || '')}</div>
      <div class="sm mut">${esc(j.req || '')}</div>
      <div class="jedit">
        <label>Fill px<input data-jk="fill" type="number" step="any" inputmode="decimal" value="${j.fill != null ? esc(j.fill) : ''}"></label>
        <label>Exit px<input data-jk="exit" type="number" step="any" inputmode="decimal" value="${j.exit != null ? esc(j.exit) : ''}"></label>
        <label>Exit type<select data-jk="exitType"><option value="LIMIT"${j.exitType === 'LIMIT' || !j.exitType ? ' selected' : ''}>Limit (maker)</option><option value="MARKET"${j.exitType === 'MARKET' ? ' selected' : ''}>Market (taker)</option><option value="STOP"${j.exitType === 'STOP' ? ' selected' : ''}>Stop (taker)</option></select></label>
        <div><div class="lbl">Net after fees</div><div class="val ${Number.isFinite(net) ? cls(net) : ''}">${Number.isFinite(net) ? fsusd(net) : '—'}</div></div>
      </div>
      <div class="row gap wrap jout"><span class="sm mut">Outcome:</span><button class="btn sm gold" data-jev="VERIFIED" type="button">Mark VERIFIED</button><button class="btn sm crim" data-jev="DISPROVEN" type="button">Mark DISPROVEN</button><button class="btn sm" data-jev="PREDICTION" type="button">Reset</button></div>
      <button class="btn sm" data-jdel="${j.id}" type="button">Delete</button>
    </div>`;
  }).join('') : '<div class="sm mut">No sent requests yet. Confirm &amp; send on an order to start the journal.</div>';
}
function logJournal(o, req) {
  S.journal.unshift({
    id: uid(), t: Date.now(), side: o.side, product: o.product, type: o.type, amount: o.amount,
    limit: o.limit, bracket: o.bracket, tp: o.tp, sl: o.sl, req,
    fill: '', exit: '', exitType: 'LIMIT', status: 'sent',
    evidence: 'PREDICTION', proposed_by_role: o.role || 'manual', authorized_by: 'daryell',
    fee_edge: feeEdge(o).status, prediction: journalPrediction(o)
  });
  S.journal = S.journal.slice(0, 200); save(); renderJournal();
}
function consecutiveLosses() {
  const closed = S.journal.filter(j => j.fill !== '' && j.fill != null && j.exit !== '' && j.exit != null);
  let n = 0;
  for (const j of closed) { const net = journalNet(j); if (!Number.isFinite(net)) continue; if (net < 0) n++; else break; }
  return n;
}
function dayPnl() {
  const start = new Date(); start.setHours(0, 0, 0, 0); const t0 = start.getTime();
  let pnl = 0;
  for (const j of S.journal) {
    if (j.t < t0) continue;
    if (j.fill === '' || j.fill == null || j.exit === '' || j.exit == null) continue;
    const n = journalNet(j); if (Number.isFinite(n)) pnl += n;
  }
  return pnl;
}
function riskCheck(o) {
  const reasons = [];
  const est = orderEstimate(o);
  const notional = o.side === 'BUY' ? est.notional : est.notional;
  if (S.risk.maxPos > 0 && notional > S.risk.maxPos) reasons.push(`Size ${fusd(notional)} exceeds max position $${S.risk.maxPos}.`);
  const dp = dayPnl();
  if (S.risk.dailyCap > 0 && dp <= -Math.abs(S.risk.dailyCap)) reasons.push(`Daily loss ${fsusd(dp)} has hit the −$${S.risk.dailyCap} cap.`);
  const streak = consecutiveLosses();
  if (S.risk.streakBlock > 0 && streak >= S.risk.streakBlock) reasons.push(`${streak} consecutive losses — confirm is blocked until you edit a win or raise the streak limit.`);
  const cd = cooldownState(o.product);
  if (cd.active) reasons.push(`COOLDOWN · A request for ${o.product} was copied at ${tfmt(cd.since)}. Next request allowed at ${tfmt(cd.until)} (${cd.mins}-min cooldown, ${cd.leftMin} min left). Set Cooldown to 0 to turn it off.`);
  const sc = sizeCheck(o); reasons.push(...sc.reasons);
  return { ok: !reasons.length, reasons, notional, dayPnl: dp, streak, cooldown: cd, size: sc, edge: feeEdge(o) };
}
function applyRiskUI() {
  if (!$('#riskBox')) return;
  $('#riskDaily').value = S.risk.dailyCap;
  $('#riskMax').value = S.risk.maxPos;
  $('#riskStreak').value = S.risk.streakBlock;
  if ($('#guardCool')) { $('#guardCool').value = S.risk.cooldownMin; $('#guardPct').value = S.risk.maxPortfolioPct; $('#guardCash').value = guardCashEntered() ? S.risk.cashOverride : ''; $('#guardCash').placeholder = fusd(availableCash()) + ' last'; }
  if (!S.order) return;
  renderGuard();
  const r = riskCheck(S.order);
  const w = $('#riskWarn'), btn = $('#cfSend');
  if (!r.ok) { w.hidden = false; w.innerHTML = r.reasons.map(t => '⛔ ' + esc(t)).join('<br>'); if (btn) { btn.disabled = true; btn.title = r.reasons[0]; } }
  else { w.hidden = true; w.innerHTML = ''; if (btn) { btn.disabled = false; btn.title = ''; } }
}
function exportJournalCSV() {
  const head = ['id', 'time', 'side', 'product', 'type', 'amount', 'fill', 'exit', 'exitType', 'net_pnl', 'evidence', 'proposed_by_role', 'authorized_by', 'fee_edge', 'request'];
  const lines = [head.join(',')];
  for (const j of S.journal) {
    const net = journalNet(j);
    const row = [j.id, new Date(j.t).toISOString(), j.side, j.product, j.type, j.amount, j.fill, j.exit, j.exitType || '', Number.isFinite(net) ? net.toFixed(4) : '', jEvidence(j), j.proposed_by_role || 'unknown (pre-v3.1)', j.authorized_by || 'daryell', j.fee_edge || '', JSON.stringify(j.req || '')];
    lines.push(row.map(x => `"${String(x).replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `hydra_journal_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}


let _gObs = null;
function observeGainers() {
  if (!('IntersectionObserver' in window)) return;
  if (_gObs) _gObs.disconnect();
  _gObs = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const p = en.target.dataset.p; if (!p) continue;
      const m = md(p);
      if (!m.lastTick || Date.now() - m.lastTick > 15e3) loadTicker(p).catch(() => {});
      if (!m.book || Date.now() - m.book.at > 90e3) loadBook(p).then(() => { const r = S.gainers.find(x => x.id === p); if (r && m.book) { r.thin = m.book.bidDepth + m.book.askDepth < 25000; r.imbalance = m.book.imbalance; renderGainers(); } }).catch(() => {});
    }
  }, { root: null, rootMargin: '80px', threshold: 0.15 });
  $$('#gainers .gainer').forEach(el => _gObs.observe(el));
}
/* ---------------------------------------------------------------- events */
function showTab(t) {
  S.tab = t; $$('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + t)); $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (t === 'alerts') { S.unread = 0; $('#alertBadge').hidden = true; }
  if (t === 'bot') renderRules();
  if (t === 'position') renderPosition();
  if (t === 'gainers') { renderGainers(); if (!S.gainUpdated) refreshGainers(); observeGainers(); }
  if (t === 'journal') renderJournal();
  window.scrollTo({ top: 0 });
}
function wire() {
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('#cards').addEventListener('click', e => {
    const buy = e.target.closest('[data-buy]'), sell = e.target.closest('[data-sell]');
    if (buy) { e.stopPropagation(); return openOrder(buy.dataset.buy, 'BUY', 'manual'); }
    if (sell) { e.stopPropagation(); return openOrder(sell.dataset.sell, 'SELL', 'manual'); }
    const rm = e.target.closest('.rm'); const c = e.target.closest('.coin'); if (!c) return;
    if (rm) { e.stopPropagation(); removeProduct(c.dataset.p); } else openSheet(c.dataset.p);
  });
  const eb = document.createElement('button'); eb.className = 'btn sm'; eb.textContent = 'Edit'; eb.type = 'button';
  eb.onclick = () => { S.edit = !S.edit; eb.textContent = S.edit ? 'Done' : 'Edit'; $('#cards').classList.toggle('edit', S.edit); };
  $('#updated').after(eb);
  $('#addForm').addEventListener('submit', e => { e.preventDefault(); addProduct($('#addInput').value); $('#addInput').value = ''; });
  $('#spikeTh').value = S.spikeTh; $('#spikeTh').addEventListener('change', e => { S.spikeTh = Math.max(0.1, num(e.target.value, 3)); save(); S.watch.forEach(dirty); });
  $('#shClose').onclick = () => { $('#sheet').hidden = true; sheetP = null; };
  $('#shTitle').addEventListener('click', e => { const buy=e.target.closest('[data-buy]'), sell=e.target.closest('[data-sell]'); if (buy) openOrder(buy.dataset.buy,'BUY'); if (sell) openOrder(sell.dataset.sell,'SELL'); });
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('#shClose').click(); });
  $('#shTf').addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; sheetG = +b.dataset.g; $$('#shTf button').forEach(x => x.classList.toggle('on', x === b)); await loadSheet(); drawChart(); });
  // position
  $('#posForm').addEventListener('submit', e => { e.preventDefault(); const f = e.target;
    const usd=num(f.usd.value), usdc=num(f.usdc.value); S.pos = { product: normProduct(f.product.value), qty: num(f.qty.value), entry: num(f.entry.value), cost: num(f.cost.value), tp: num(f.tp.value), sl: num(f.sl.value), order: f.order.value.trim(), usd, usdc, cash: r3(usd+usdc) }; if (f.cash) f.cash.value = S.pos.cash;
    save(); if (!S.watch.includes(S.pos.product)) addProduct(S.pos.product); renderPosition(); toast('Position saved'); $('#posEdit').open = false; });
  $('#posCalcCost').onclick = () => { const f = $('#posForm'); f.cost.value = (num(f.qty.value) * num(f.entry.value) * (1 + S.fees.taker / 100)).toFixed(4); };
  // fees
  for (const [id, k] of [['feeTaker', 'taker'], ['feeMaker', 'maker'], ['feeSlip', 'slip']]) { const el = $('#' + id); el.value = S.fees[k];
    el.addEventListener('change', () => { S.fees[k] = Math.max(0, num(el.value, DEFAULT_FEES[k])); save(); renderRules(); renderPosition(); }); }
  // rules
  $('#rules').addEventListener('change', e => {
    const card = e.target.closest('.rule'), k = e.target.dataset.k; if (!card || !k) return;
    const r = S.rules.find(x => x.id === card.dataset.id); if (!r) return;
    r[k] = e.target.type === 'checkbox' ? e.target.checked : ['product', 'trigger', 'tf', 'trend'].includes(k) ? e.target.value : num(e.target.value, r[k]);
    if (k === 'trigger') r.tf = r.trigger === 'dip' ? '5m' : '1h';
    if (k === 'on' && r.on && !edge(r.tp, r.sl).clears) toast(`${r.product}: TP is below round-trip fees. Alerts will fire, but this rule loses money even when it wins.`, 'dn');
    save(); if (['trigger', 'on', 'product'].includes(k)) renderRules(); else renderEdge(r); evalAll();
  });
  $('#rules').addEventListener('click', e => { const d = e.target.closest('[data-del]'); if (d) { S.rules = S.rules.filter(r => r.id !== d.dataset.del); save(); renderRules(); } });
  $('#addRule').onclick = () => { S.rules.push(mkRule(S.watch[0] || 'ATOM-USD')); save(); renderRules(); };
  $('#copyBot').onclick = async () => { const t = JSON.stringify(buildExport(), null, 2); $('#jsonBox').value = t;
    toast(await copyText(t) ? 'Copied. Paste it into chat with Grok Bot to review rules or request order previews.' : 'Copy blocked: select the JSON box text and copy it manually.', ''); };
  $('#exportBtn').onclick = async () => {
    const t = JSON.stringify(buildExport(), null, 2), name = `hydra_scanner_rules_${new Date().toISOString().slice(0, 10)}.json`; $('#jsonBox').value = t;
    const file = new File([t], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  $('#importFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { importJSON(JSON.parse(await f.text())); } catch (x) { toast('Import failed: ' + x.message, 'dn'); } e.target.value = ''; });
  $('#jsonApply').onclick = () => { try { importJSON(JSON.parse($('#jsonBox').value)); } catch (x) { toast('Invalid JSON: ' + x.message, 'dn'); } };
  // alerts
  $('#alertForm').addEventListener('submit', e => { e.preventDefault(); const f = e.target; S.alerts.push({ id: uid(), product: f.product.value, cond: f.cond.value, value: num(f.value.value), on: true }); f.value.value = ''; save(); renderAlertRules(); evalAll(); });
  $('#alertRules').addEventListener('change', e => { const c = e.target.closest('.arule'); const a = c && S.alerts.find(x => x.id === c.dataset.id); if (a) { a.on = e.target.checked; a.armed = true; save(); } });
  $('#alertRules').addEventListener('click', e => { const d = e.target.closest('[data-adel]'); if (d) { S.alerts = S.alerts.filter(a => a.id !== d.dataset.adel); save(); renderAlertRules(); } });
  $('#clearLog').onclick = () => { S.log = []; LS.set('log', []); renderLog(); };
  $('#log').addEventListener('click', async e => { const b = e.target.closest('[data-copy]'); if (b) toast(await copyText(b.dataset.copy) ? 'Preview copied for chat' : 'Copy blocked', ''); });
  const nb = $('#notifBtn');
  const nbState = () => { if (!('Notification' in window)) { nb.textContent = 'Notifications: install to Home Screen'; nb.disabled = true; } else nb.textContent = Notification.permission === 'granted' ? 'Notifications on' : Notification.permission === 'denied' ? 'Notifications blocked' : 'Enable notifications'; };
  nbState(); nb.onclick = async () => { if ('Notification' in window) { try { await Notification.requestPermission(); } catch (e) {} nbState(); } };


  // v3 gainers filters
  if ($('#exHot')) { $('#exHot').checked = !!S.exHot; $('#exHot').addEventListener('change', e => { S.exHot = e.target.checked; save(); renderGainers(); buzz(8); }); }
  if ($('#rankBy')) { $('#rankBy').value = S.rankBy; $('#rankBy').addEventListener('change', e => { S.rankBy = e.target.value; save(); renderGainers(); }); }
  // journal
  if ($('#jExport')) $('#jExport').onclick = () => exportJournalCSV();
  if ($('#jClear')) $('#jClear').onclick = () => { if (confirm('Clear the entire trade journal on this device?')) { S.journal = []; save(); renderJournal(); } };
  if ($('#journal')) {
    $('#journal').addEventListener('change', e => {
      const row = e.target.closest('[data-jid]'); const jk = e.target.dataset.jk; if (!row || !jk) return;
      const j = S.journal.find(x => x.id === row.dataset.jid); if (!j) return;
      j[jk] = e.target.type === 'number' ? e.target.value : e.target.value; save(); renderJournal(); applyRiskUI();
    });
    $('#journal').addEventListener('click', e => { const ev = e.target.closest('[data-jev]'); if (ev) { const row = ev.closest('[data-jid]'); const j = row && S.journal.find(x => x.id === row.dataset.jid); if (j) { const r = markOutcome(j, ev.dataset.jev); if (!r.ok) toast(r.reason, 'dn'); } return; }
      const d = e.target.closest('[data-jdel]'); if (!d) return; S.journal = S.journal.filter(j => j.id !== d.dataset.jdel); save(); renderJournal(); });
  }
  // risk inputs
  for (const [id, k] of [['riskDaily', 'dailyCap'], ['riskMax', 'maxPos'], ['riskStreak', 'streakBlock']]) {
    const el = $('#' + id); if (!el) continue;
    el.value = S.risk[k];
    el.addEventListener('change', () => { S.risk[k] = Math.max(0, num(el.value, S.risk[k])); save(); applyRiskUI(); });
  }
  // v3.1 guard inputs (cooldown, max % of portfolio, cash override)
  for (const [id, k] of [['guardCool', 'cooldownMin'], ['guardPct', 'maxPortfolioPct']]) {
    const el = $('#' + id); if (!el) continue;
    el.addEventListener('change', () => { S.risk[k] = Math.max(0, num(el.value, S.risk[k])); save(); applyRiskUI(); });
  }
  if ($('#guardCash')) $('#guardCash').addEventListener('change', e => { const v = String(e.target.value).trim(); S.risk.cashOverride = v === '' ? null : Math.max(0, num(v, 0)); save(); applyRiskUI(); if (S.order) paintOrder(); });
  if ($('#cfRole')) $('#cfRole').addEventListener('change', e => { if (!S.order) return; S.order.role = ROLES[e.target.value] ? e.target.value : 'manual'; openConfirm(); });
  // swipe between tabs
  let tx0 = 0, ty0 = 0;
  document.addEventListener('touchstart', e => { const t = e.changedTouches[0]; tx0 = t.clientX; ty0 = t.clientY; }, { passive: true });
  document.addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - tx0, dy = t.clientY - ty0;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (!$('#order').hidden || !$('#confirm').hidden || !$('#sheet').hidden) return;
    const order = ['market', 'gainers', 'position', 'bot', 'journal', 'alerts'];
    const i = order.indexOf(S.tab); if (i < 0) return;
    const ni = dx < 0 ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
    if (ni !== i) { showTab(order[ni]); buzz(10); }
  }, { passive: true });

  // gainers
  if ($('#minVol')) { $('#minVol').value = S.minVol; $('#minVol').addEventListener('change', e => { S.minVol = Math.max(0, num(e.target.value, 1e6)); save(); renderGainers(); }); }
  if ($('#gainMode')) $('#gainMode').addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (!b) return; S.gainMode = b.dataset.mode; save(); $$('#gainMode button').forEach(x => x.classList.toggle('on', x === b)); renderGainers(); });
  if ($('#gainers')) $('#gainers').addEventListener('click', e => {
    const buy = e.target.closest('[data-buy]'), sell = e.target.closest('[data-sell]'), add = e.target.closest('[data-add]');
    if (buy) { e.stopPropagation(); return openOrder(buy.dataset.buy, 'BUY', 'gainers_scanner'); }
    if (sell) { e.stopPropagation(); return openOrder(sell.dataset.sell, 'SELL', 'gainers_scanner'); }
    if (add) { e.stopPropagation(); return addProduct(add.dataset.add); }
    const g = e.target.closest('.gainer'); if (g) openSheet(g.dataset.p);
  });
  // order sheet
  if ($('#orClose')) $('#orClose').onclick = () => { $('#order').hidden = true; S.order = null; };
  if ($('#order')) $('#order').addEventListener('click', e => { if (e.target.id === 'order') $('#orClose').click(); });
  if ($('#orSide')) $('#orSide').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !S.order) return; S.order.side = b.dataset.side; if (S.order.side === 'BUY') S.order.amount = Math.max(1, Math.min(5, availableCash() || 1)); else if (S.order.product === S.pos.product) S.order.amount = S.pos.qty; paintOrder(); });
  if ($('#orType')) $('#orType').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !S.order) return; S.order.type = b.dataset.type; paintOrder(); });
  if ($('#orForm')) { $('#orForm').addEventListener('input', () => { readOrderForm(); paintOrder(); }); $('#orForm').addEventListener('change', () => { readOrderForm(); paintOrder(); }); }
  if ($('#orConfirm')) $('#orConfirm').onclick = () => { readOrderForm(); openConfirm(); };
  if ($('#cfClose')) $('#cfClose').onclick = () => { $('#confirm').hidden = true; };
  if ($('#cfBack')) $('#cfBack').onclick = () => { $('#confirm').hidden = true; $('#order').hidden = false; };
  if ($('#cfSend')) $('#cfSend').onclick = () => confirmAndSend();
  // buy/sell on chart sheet header

  window.addEventListener('pwa:action', e => { const a = e.detail && (e.detail.action || e.detail); if (['market', 'gainers', 'position', 'bot', 'journal', 'alerts'].includes(a)) showTab(a); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { connectWS(); poll(); S.watch.forEach(p => refreshCandles(p)); } });
  window.addEventListener('online', () => { connectWS(); poll(); });
  window.addEventListener('offline', () => setFeed('down'));
  window.addEventListener('resize', () => { S.watch.forEach(dirty); });
}

/* ---------------------------------------------------------------- boot */
async function boot(re) {
  buildCards(); fillPosForm(); renderAlertRules(); renderLog(); renderRules(); renderPosition();
  $('#feeTaker').value = S.fees.taker; $('#feeMaker').value = S.fees.maker; $('#feeSlip').value = S.fees.slip; $('#spikeTh').value = S.spikeTh;
  if ($('#minVol')) $('#minVol').value = S.minVol;
  if ($('#gainMode')) $$('#gainMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.gainMode));
  if ($('#exHot')) $('#exHot').checked = !!S.exHot;
  if ($('#rankBy')) $('#rankBy').value = S.rankBy;
  // sync cash total field
  const pf=$('#posForm'); if (pf && pf.usd) { pf.usd.value=S.pos.usd; pf.usdc.value=S.pos.usdc; pf.cash.value=S.pos.cash; pf.usd.addEventListener('input',()=>{pf.cash.value=r3(num(pf.usd.value)+num(pf.usdc.value));}); pf.usdc.addEventListener('input',()=>{pf.cash.value=r3(num(pf.usd.value)+num(pf.usdc.value));}); }
  if (re) { if (S.ws) try { S.ws.close(); } catch (e) {} }
  connectWS();
  for (const p of S.watch) loadStats(p).catch(e => console.warn('stats', p, e));
  for (const p of S.watch) refreshCandles(p, true);
  if (!re) validateWatch();
  refreshGainers();
}
wire(); boot();
setInterval(poll, 8000); setTimeout(poll, 4000);
setInterval(() => { if (!document.hidden) S.watch.forEach(p => refreshCandles(p)); }, 60e3);
setInterval(() => { if (!document.hidden) S.watch.forEach(p => loadStats(p).catch(() => {})); }, 5 * 60e3);
setInterval(() => { if (!document.hidden) refreshGainers(); }, 60e3);
const a0 = new URLSearchParams(location.search).get('action'); if (['market', 'gainers', 'position', 'bot', 'journal', 'alerts'].includes(a0)) showTab(a0);
})();
