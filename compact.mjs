// Compact the crawler output into "ASIN,LETTER" lines so it can be read back
// through the PC channel without uploading a file anywhere.
import fs from 'node:fs';

const file = process.argv[2];
const map = { in_stock: 'I', out_of_stock: 'O', other_sellers: 'S', unclear: 'U', unknown: 'X', blocked: 'B' };
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const counts = {};
const out = [];
for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const code = map[r.status] || 'X';
  counts[code] = (counts[code] || 0) + 1;
  out.push(`${r.asin},${code}`);
}
console.log(`COUNT ${JSON.stringify(counts)} N=${out.length}`);
console.log(out.join('\n'));
