// Amazon dp availability crawler (residential IP side).
// Usage: node amz_av.mjs <workdir>
//   <workdir>/asins.txt   one ASIN per line
//   <workdir>/av.jsonl    append-only output (resume-safe)
//   <workdir>/av.log      progress
// Stops by itself after ~52 min so the caller's window is never exceeded.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('need workdir'); process.exit(2); }
const asinFile = path.join(dir, 'asins.txt');
const outFile = path.join(dir, 'av.jsonl');
const logFile = path.join(dir, 'av.log');

const log = (m) => { const s = `${new Date().toISOString()} ${m}`; fs.appendFileSync(logFile, s + '\n'); console.log(s); };

const all = fs.readFileSync(asinFile, 'utf8').split(/\s+/).filter(Boolean);
const done = new Set();
if (fs.existsSync(outFile)) {
  for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).asin); } catch { /* ignore torn line */ }
  }
}
const todo = all.filter((a) => !done.has(a));
log(`todo ${todo.length} (already ${done.size})`);
fs.writeFileSync(path.join(dir, 'run_status.txt'), `running todo=${todo.length}\n`);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const START = Date.now();
const DEADLINE = START + 52 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(html) {
  const i = html.indexOf('id="availability"');
  if (i < 0) {
    if (/Currently unavailable/.test(html)) return ['out_of_stock', 'Currently unavailable (page-level)'];
    return ['unknown', null];
  }
  let chunk = html.slice(i, i + 6000);
  const cut = chunk.indexOf('</div>\n</div>');
  if (cut > 0) chunk = chunk.slice(0, cut);
  const text = chunk.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const low = text.toLowerCase();
  if (low.includes('currently unavailable') || low.includes('out of stock')) return ['out_of_stock', text];
  if (/\bin stock\b/.test(low) || low.includes('left in stock')) return ['in_stock', text];
  if (low.includes('buying options') || low.includes('other sellers')) return ['other_sellers', text];
  return ['unclear', text];
}

let stats = { in_stock: 0, out_of_stock: 0, other_sellers: 0, unclear: 0, unknown: 0, blocked: 0, fail: 0 };
let idx = 0;
let blockedStreak = 0;
let stop = false;

async function lane() {
  while (!stop) {
    const k = idx++;
    if (k >= todo.length) return;
    if (Date.now() > DEADLINE) { stop = true; log('deadline reached'); return; }
    const asin = todo[k];
    let rec;
    try {
      const r = await fetch(`https://www.amazon.com/dp/${asin}`, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
      });
      const html = await r.text();
      const ts = new Date().toISOString();
      if (html.length < 20000 || html.includes('To discuss automated access')) {
        rec = { asin, http_status: r.status, bytes: html.length, status: 'blocked', ts };
        stats.blocked++; blockedStreak++;
        if (blockedStreak >= 4) { stop = true; log('4 consecutive blocks, stopping'); }
        await sleep(60000);
      } else {
        blockedStreak = 0;
        const [st, msg] = classify(html);
        rec = { asin, http_status: r.status, bytes: html.length, status: st, message: msg, ts };
        stats[st] = (stats[st] || 0) + 1;
      }
    } catch (e) {
      rec = { asin, status: 'unknown', error: String(e).slice(0, 120), ts: new Date().toISOString() };
      stats.fail++;
    }
    fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
    if ((stats.in_stock + stats.out_of_stock + stats.blocked + stats.fail) % 50 === 0) {
      const el = (Date.now() - START) / 1000;
      log(`progress ${done.size + k + 1}/${all.length} ${JSON.stringify(stats)} ${((k + 1) / el).toFixed(2)}/s`);
    }
    await sleep(800 + Math.floor(Math.random() * 400));
  }
}

await Promise.all([lane(), lane()]);
fs.writeFileSync(path.join(dir, 'run_status.txt'), `stopped todo=${todo.length} done=${idx}\n`);
log(`final ${JSON.stringify(stats)} elapsed_s=${((Date.now() - START) / 1000).toFixed(0)}`);
