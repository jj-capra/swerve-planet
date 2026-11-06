// Runs the real function code against Netlify's local Blobs server.
import { BlobsServer } from '@netlify/blobs/server';
import { getStore } from '@netlify/blobs';
import { handle } from '../netlify/functions/scores.mjs';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import assert from 'node:assert/strict';

const token = 'test-token';
const server = new BlobsServer({ directory: mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'blobs-')), token });
const { port } = await server.start();
const opts = { name: 'swerve-scores', siteID: 'site', token, edgeURL: `http://localhost:${port}`, consistency: 'strong', uncachedEdgeURL: `http://localhost:${port}` };
const store = getStore(opts);
const T = (iso) => new Date(iso);
const post = (body, now) => handle(new Request('http://x/api/scores', { method: 'POST', body: JSON.stringify(body) }), { store, now });
const get = (q, now) => handle(new Request('http://x/api/scores?' + q), { store, now });
const pid = (n) => ('player' + n).padEnd(16, 'x');
let r, j;

// a first score lands at #1 everywhere
r = await post({ mode: 'hoops', score: 5000, name: 'jc', pid: pid(1), dur: 60 }, T('2026-11-04T20:00:00Z')); j = await r.json();
assert.equal(r.status, 200); assert.deepEqual(j.ranks, { day: 1, week: 1, all: 1 }); assert.equal(j.name, 'JC');
// a better player goes to #1, JC drops to #2
j = await (await post({ mode: 'hoops', score: 9000, name: 'Swish Queen!!', pid: pid(2), dur: 90 }, T('2026-11-04T21:00:00Z'))).json();
assert.deepEqual(j.ranks, { day: 1, week: 1, all: 1 }); assert.equal(j.name, 'SWISH QUEEN!');
// JC's worse run doesn't replace his best; a better one does
j = await (await post({ mode: 'hoops', score: 3000, name: 'jc', pid: pid(1), dur: 60 }, T('2026-11-04T22:00:00Z'))).json();
assert.equal(j.ranks.day, 2);
j = await (await post({ mode: 'hoops', score: 12000, name: 'jc', pid: pid(1), dur: 60 }, T('2026-11-04T22:30:00Z'))).json();
assert.deepEqual(j.ranks, { day: 1, week: 1, all: 1 });
// one row per player
j = await (await get('mode=hoops&period=day', T('2026-11-04T23:00:00Z'))).json();
assert.equal(j.entries.length, 2); assert.deepEqual(j.entries.map((e) => e.s), [12000, 9000]); assert.ok(!('t' in j.entries[0]));
// the day rolls over at midnight Pacific (08:00 UTC), the week keeps going
j = await (await get('mode=hoops&period=day', T('2026-11-05T09:00:00Z'))).json(); assert.equal(j.entries.length, 0);
j = await (await get('mode=hoops&period=week', T('2026-11-05T09:00:00Z'))).json(); assert.equal(j.entries.length, 2);
assert.equal(j.key, 's2/week/hoops/2026-11-02');
// ...and the week rolls over on Monday
j = await (await get('mode=hoops&period=week', T('2026-11-10T09:00:00Z'))).json(); assert.equal(j.entries.length, 0);
j = await (await get('mode=hoops&period=all', T('2026-11-10T09:00:00Z'))).json(); assert.equal(j.entries.length, 2);
// planets don't mix
j = await (await get('mode=football&period=all', T('2026-11-10T09:00:00Z'))).json(); assert.equal(j.entries.length, 0);
// junk is rejected
assert.equal((await post({ mode: 'golf', score: 5, pid: pid(3), dur: 60 })).status, 400);
assert.equal((await post({ mode: 'car', score: -5, pid: pid(3), dur: 60 })).status, 400);
assert.equal((await post({ mode: 'car', score: 5000, pid: 'x', dur: 60 })).status, 400);
assert.equal((await post({ mode: 'car', score: 9e6, pid: pid(3), dur: 6000 })).status, 400);   // over the cap
assert.equal((await post({ mode: 'car', score: 50000, pid: pid(3), dur: 10 })).status, 422);  // too fast to be real
assert.equal((await handle(new Request('http://x/api/scores', { method: 'POST', body: 'nope' }), { store })).status, 400);
assert.equal((await get('mode=car&period=year')).status, 400);
// names are cleaned up and filtered
j = await (await post({ mode: 'car', score: 100, name: '<b>sh1t</b>', pid: pid(4), dur: 60 })).json(); assert.equal(j.name, 'PLAYER');
j = await (await post({ mode: 'car', score: 100, name: '  a   b  ', pid: pid(5), dur: 60 })).json(); assert.equal(j.name, 'A B');
// boards keep the top 100, and a low score doesn't make it once they're full
const now = T('2026-11-06T18:00:00Z');
for (let i = 0; i < 110; i++) await post({ mode: 'car', score: 5000 + i * 10, name: 'c' + i, pid: pid(300 + i), dur: 60 }, now);
j = await (await post({ mode: 'car', score: 50, name: 'late', pid: pid(999), dur: 60 }, now)).json();
assert.equal(j.ranks.all, null);
j = await (await get('mode=car&period=all', now)).json(); assert.equal(j.entries.length, 50);
await server.stop();
console.log('API tests passed against the local Netlify Blobs server');

// Concurrency. The local dev server doesn't apply If-Match atomically, so this part uses an in-memory store that does
// (as hosted Netlify Blobs does), with random latency so requests interleave. Run with and without ETags on reads.
function atomicStore(etagOnRead) {
  const m = new Map(); let v = 0; const lag = () => new Promise((r) => setTimeout(r, Math.random() * 8));
  return {
    async getWithMetadata(k) { await lag(); const e = m.get(k); return e ? { data: structuredClone(e.data), etag: etagOnRead ? e.etag : undefined, metadata: {} } : null; },
    async get(k) { await lag(); const e = m.get(k); return e ? structuredClone(e.data) : null; },
    async list({ prefix }) { await lag(); return { blobs: [...m].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, etag: e.etag })), directories: [] }; },
    async setJSON(k, data, o = {}) {
      await lag(); const e = m.get(k);
      if (o.onlyIfNew && e) return { modified: false };
      if (o.onlyIfMatch !== undefined && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = '"' + (++v) + '"'; m.set(k, { data: structuredClone(data), etag }); return { modified: true, etag };
    },
  };
}
for (const etagOnRead of [true, false]) {
  const s2 = atomicStore(etagOnRead), when = T('2026-11-06T18:00:00Z');
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => handle(new Request('http://x/api/scores', { method: 'POST', body: JSON.stringify({ mode: 'football', score: 1000 + i, name: 'p' + i, pid: pid(100 + i), dur: 60 }) }), { store: s2, now: when })));
  assert.ok(res.every((r) => r.status === 200), 'every post succeeded');
  const b = await (await handle(new Request('http://x/api/scores?mode=football&period=day'), { store: s2, now: when })).json();
  assert.equal(b.entries.length, 30); assert.equal(b.entries[0].s, 1029); assert.equal(b.entries[29].s, 1000);
  console.log('30 simultaneous posts all landed (ETag on reads: ' + etagOnRead + ')');
}
console.log('all leaderboard tests passed');
