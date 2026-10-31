// Amazon dp availability via a real headless Chrome (CDP).
// The same requests over plain HTTP get Amazon's bot page; a real Chrome gets
// the product page, so this drives Chrome instead of fetching.
//
// Usage: node amz_cdp.mjs <workdir> [tabs]
//   <workdir>/asins.txt  input
//   <workdir>/av.jsonl   append-only output (resume-safe)
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const TABS = Number(process.argv[3] || 2);
const PORT = process.env.CDP_PORT || 9224;
const BASE = `http://127.0.0.1:${PORT}`;

const asinFile = path.join(dir, 'asins.txt');
const outFile = path.join(dir, 'av.jsonl');
const logFile = path.join(dir, 'av.log');
const log = (m) => { const s = `${new Date().toISOString()} ${m}`; fs.appendFileSync(logFile, s + '\n'); console.log(s); };

const all = fs.readFileSync(asinFile, 'utf8').split(/\s+/).filter(Boolean);
const done = new Set();
if (fs.existsSync(outFile)) {
  for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).asin); } catch { /* torn */ }
  }
}
const todo = all.filter((a) => !done.has(a));
log(`todo ${todo.length} (already ${done.size}) tabs=${TABS}`);

const ver = await (await fetch(`${BASE}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
  }
};
function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 40000);
  });
}

async function newTab() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  // Images/fonts/media dominate page weight and carry no availability signal.
  await send('Network.setBlockedURLs', { urls: [
    '*.jpg*', '*.jpeg*', '*.png*', '*.gif*', '*.webp*', '*.svg*', '*.woff*', '*.woff2*', '*.ttf*',
    '*.mp4*', '*.webm*', '*doubleclick.net*', '*googlesyndication*', '*google-analytics*', '*amazon-adsystem*'
  ] }, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  if (process.env.JS_OFF === '1') {
    await send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
  }
  return { targetId, sessionId };
}

const EXPR = `(() => {
  const av = document.querySelector('#availability');
  const oos = document.querySelector('#outOfStock');
  const buy = document.querySelector('#add-to-cart-button, #buy-now-button');
  return JSON.stringify({
    title: document.title,
    av: av ? av.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    oos: oos ? oos.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    buy: !!buy,
    len: document.documentElement.outerHTML.length,
    ready: document.readyState,
    body: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 300)
  });
})()`;

function classify(d) {
  const title = (d.title || '').toLowerCase();
  const body = (d.body || '').toLowerCase();
  if (body.includes('automated access') || body.includes('enter the characters you see below') || title.includes('robot check')) {
    return ['blocked', null];
  }
  if (title.includes('page not found') || body.includes('looking for something?') || body.includes("we couldn't find that page")) {
    return ['no_longer_available', d.title];
  }
  const t = `${d.av || ''} ${d.oos || ''}`.toLowerCase();
  if (t.includes('currently unavailable') || t.includes('out of stock') || body.includes('currently unavailable')) return ['out_of_stock', d.av || d.oos];
  if (/\bin stock\b/.test(t) || t.includes('left in stock')) return ['in_stock', d.av];
  if (t.includes('buying options') || t.includes('other sellers')) return ['other_sellers', d.av];
  if (d.buy) return ['in_stock', d.av || 'add-to-cart present'];
  if (d.len < 6000) return ['blocked', 'stub page (rate limited)'];
  return ['unclear', d.av];
}

let stats = { in_stock: 0, out_of_stock: 0, other_sellers: 0, unclear: 0, blocked: 0, fail: 0, no_longer_available: 0 };
const t0 = Date.now();
let stop = false;
const retries = new Map();
const queue = todo.slice();
let cursor = 0;
let blockedHits = 0;

const SLEEP_LO = Number(process.env.SLEEP_LO || 2500);
const SLEEP_HI = Number(process.env.SLEEP_HI || 6000);
const sleepRand = (lo, hi) => new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));

async function lane(id) {
  const tab = await newTab();
  while (!stop) {
    if (cursor >= queue.length) break;
    const asin = queue[cursor++];
    let rec;
    try {
      await send('Page.navigate', { url: `https://www.amazon.com/dp/${asin}` }, tab.sessionId);
      let data = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true }, tab.sessionId);
        const v = r?.result?.value;
        if (!v) continue;
        data = JSON.parse(v);
        const bodyLow = (data.body || '').toLowerCase();
        const settled = Boolean(data.av || data.oos) || data.len < 6000 ||
          (data.ready === 'complete' &&
           (data.len > 20000 || bodyLow.includes('automated access') || bodyLow.includes('enter the characters') ||
            (data.title || '').toLowerCase().includes('page not found')));
        if (settled) break;
      }
      if (!data) throw new Error('no data');
      const [status, note] = classify(data);
      rec = { asin, status, message: note, len: data.len, title: data.title, ts: new Date().toISOString() };
      if (status === 'blocked') {
        stats.blocked++;
        blockedHits++;
        const n = retries.get(asin) || 0;
        if (n < 2) { retries.set(asin, n + 1); queue.push(asin); }
        log(`blocked on ${asin}; cooling down 240s (hits=${blockedHits})`);
        await sleepRand(200000, 260000);
        continue;
      }
      stats[status] = (stats[status] || 0) + 1;
    } catch (e) {
      rec = { asin, status: 'unknown', error: String(e).slice(0, 120), ts: new Date().toISOString() };
      stats.fail++;
    }
    fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
    if (cursor % 25 === 0) log(`progress ${cursor}/${queue.length} ${JSON.stringify(stats)} ${(cursor / ((Date.now() - t0) / 1000)).toFixed(2)}/s`);
    await sleepRand(SLEEP_LO, SLEEP_HI);
  }
}

await Promise.all(Array.from({ length: TABS }, (_, i) => lane(i)));
log(`final ${JSON.stringify(stats)} elapsed_s=${((Date.now() - t0) / 1000).toFixed(0)}`);
ws.close();
