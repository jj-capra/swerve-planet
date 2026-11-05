// Swerve Planet leaderboards: one board per planet for today, this week and all time.
//
//   GET  /api/scores?mode=hoops&period=day     -> { mode, period, key, resetsIn, entries: [{ n, s, h }] }
//   POST /api/scores  { mode, score, name, pid, dur }
//                                              -> { ok, ranks: { day, week, all } }
//
// Scores live in Netlify Blobs (store "swerve-scores"), one JSON list per board, e.g.
//   day/hoops/2026-11-04   week/hoops/2026-11-02   all/hoops
// Each board keeps one best score per player. Writes are conditional on the board's ETag and retried,
// so two players finishing at the same moment can't erase each other's scores.
import { getStore } from '@netlify/blobs';

const MODES = ['car', 'hoops', 'football'];
const PERIODS = ['day', 'week', 'all'];
const KEEP = 100;                 // entries stored per board
const SHOW = 50;                  // entries returned per board
const MAX_SCORE = 100_000_000;
const MAX_RATE = 60_000;          // points per second of play: anything faster than this isn't a real run
const TZ = process.env.LEADERBOARD_TZ || 'America/Los_Angeles';   // when "today" and "this week" roll over

const BLOCK = ['FUCK', 'SHIT', 'CUNT', 'NIGG', 'FAG', 'BITCH', 'DICK', 'PUSSY', 'SLUT', 'WHORE', 'RAPE', 'NAZI', 'KKK', 'ASSHOLE', 'COCK', 'RETARD'];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// calendar parts of an instant, in the leaderboard's time zone
function parts(now) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(now)) o[p.type] = p.value;
  return o;
}
function boardKey(mode, period, now) {
  if (period === 'all') return 'all/' + mode;
  const p = parts(now);
  const day = Date.UTC(+p.year, +p.month - 1, +p.day);
  if (period === 'day') return 'day/' + mode + '/' + p.year + '-' + p.month + '-' + p.day;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);   // weeks start on Monday
  const mon = new Date(day - dow * 86400000).toISOString().slice(0, 10);
  return 'week/' + mode + '/' + mon;
}
// seconds until this board rolls over (approximate across DST changes, which is fine for a countdown)
function resetsIn(period, now) {
  if (period === 'all') return null;
  const p = parts(now);
  const left = 86400 - (+p.hour * 3600 + +p.minute * 60 + +p.second);
  if (period === 'day') return left;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return left + (6 - dow) * 86400;
}
function cleanName(raw) {
  let n = String(raw || '').toUpperCase().replace(/[^A-Z0-9 ._!-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  const squash = n.replace(/0/g, 'O').replace(/[1!]/g, 'I').replace(/3/g, 'E').replace(/4/g, 'A').replace(/5/g, 'S').replace(/[^A-Z]/g, '');
  if (!n || BLOCK.some((w) => squash.includes(w))) n = 'PLAYER';
  return n;
}
async function hashId(pid) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('swerve:' + pid));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The board's current contents and the ETag they were read at. If a read doesn't report an ETag, look the ETag up
// first and read the data after it: anything written in between makes the ETag stale, so the write fails and retries.
async function readBoard(store, key) {
  const cur = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (!cur || cur.etag) return cur;
  const { blobs } = await store.list({ prefix: key });
  const hit = blobs.find((b) => b.key === key);
  if (!hit) return null;
  const data = await store.get(key, { type: 'json', consistency: 'strong' });
  return data == null ? null : { data, etag: hit.etag };
}
// read-modify-write one board, conditional on its ETag so concurrent posts don't clobber each other
async function upsert(store, key, entry) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await readBoard(store, key);
    const list = (cur && Array.isArray(cur.data)) ? cur.data : [];
    const i = list.findIndex((e) => e.h === entry.h);
    if (i >= 0 && list[i].s >= entry.s) {                       // already holds a better score: just report the rank
      return list.findIndex((e) => e.h === entry.h) + 1;
    }
    if (i >= 0) list.splice(i, 1);
    list.push(entry);
    list.sort((a, b) => b.s - a.s || a.t - b.t);
    list.length = Math.min(list.length, KEEP);
    const rank = list.findIndex((e) => e.h === entry.h) + 1;   // 0 if it didn't make the cut
    if (!rank) return null;
    const res = await store.setJSON(key, list, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return rank;
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 60 * (attempt + 1)));
  }
  throw new Error('board busy');
}

export async function handle(req, { store, now = new Date() }) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const mode = url.searchParams.get('mode'), period = url.searchParams.get('period') || 'all';
    if (!MODES.includes(mode) || !PERIODS.includes(period)) return json({ error: 'bad mode or period' }, 400);
    const key = boardKey(mode, period, now);
    const list = (await store.get(key, { type: 'json' })) || [];
    return json({ mode, period, key, tz: TZ, resetsIn: resetsIn(period, now), entries: list.slice(0, SHOW).map(({ n, s, h }) => ({ n, s, h })) });
  }
  if (req.method === 'POST') {
    let b;
    try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const mode = b && b.mode, score = Math.floor(Number(b && b.score)), dur = Number(b && b.dur);
    const pid = String((b && b.pid) || '');
    if (!MODES.includes(mode)) return json({ error: 'bad mode' }, 400);
    if (!Number.isFinite(score) || score <= 0 || score > MAX_SCORE) return json({ error: 'bad score' }, 400);
    if (!/^[a-z0-9]{12,40}$/i.test(pid)) return json({ error: 'bad player id' }, 400);
    if (!Number.isFinite(dur) || dur < 5 || score / dur > MAX_RATE) return json({ error: 'that run does not add up' }, 422);
    const entry = { n: cleanName(b.name), s: score, h: await hashId(pid), t: now.getTime() };
    const ranks = {};
    for (const period of PERIODS) ranks[period] = await upsert(store, boardKey(mode, period, now), entry);
    return json({ ok: true, name: entry.n, h: entry.h, ranks });
  }
  return json({ error: 'method not allowed' }, 405);
}

export default async (req) => {
  try {
    return await handle(req, { store: getStore({ name: 'swerve-scores', consistency: 'strong' }) });
  } catch (e) {
    console.error(e);
    return json({ error: 'leaderboard unavailable' }, 503);
  }
};

export const config = {
  path: '/api/scores',
  // per visitor: plenty for browsing boards and posting runs, not enough to flood them
  rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
