/*
 * Math Blitz server. No npm packages needed: Node 18 or newer.
 *
 *   node server.js
 *
 * Environment variables (all optional):
 *   PORT                       port to listen on (default 3000)
 *   UPSTASH_REDIS_REST_URL     use Upstash Redis for storage (needed on Render)
 *   UPSTASH_REDIS_REST_TOKEN
 *   DATA_DIR                   folder for the local data file (default ./data)
 *   ADMIN_KEY                  turns on the admin page at /admin.html
 *   TIMEZONE                   decides when the monthly board rolls over
 *                              (default Asia/Manila)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createStore } = require('./storage');
const Gen = require('./public/generator');

const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Manila';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Game rules. The client reads these from /api/config.
const GAME_MS = 60000;          // length of a ranked game
const COUNTDOWN_MS = 3000;      // 3-2-1 before the clock starts
const SKIP_PENALTY_MS = 2000;   // a skip freezes the player for this long
const MIN_GAP_MS = 100;         // faster than this between answers is not human
const SESSION_TTL_MS = 5 * 60000;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

const store = createStore();
let SECRET = '';

/* ---------------------------------------------------------------- helpers */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}
function monthKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(date || new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return y + '-' + m;
}

/* -------------------------------------------------------------- passwords */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}

/* ----------------------------------------------------------------- tokens */
// token = base64url(userId.expiry.passwordVersion).signature
function makeToken(id, pwv) {
  const payload = Buffer.from(id + '.' + (Date.now() + TOKEN_TTL_MS) + '.' + pwv).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
async function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const [id, exp, pwv] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!id || Number(exp) < Date.now()) return null;
  const user = await store.getUser(id);
  // Changing a password (e.g. an admin reset) logs out old sessions.
  if (!user || String(user.pwv || 0) !== pwv) return null;
  return { id, user };
}

/* ------------------------------------------------------ login rate limits */
const attempts = new Map(); // ip -> { n, until }
function limited(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now() && a.n >= 10;
}
function noteFailure(ip) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 10 * 60000 });
  else a.n++;
}

/* ------------------------------------------------------------ validation */
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
function validName(n) { return typeof n === 'string' && NAME_RE.test(n); }
function validPassword(p) { return typeof p === 'string' && p.length >= 6 && p.length <= 72; }

/* --------------------------------------------------------- game sessions */
const sessions = new Map(); // sessionId -> { userId, pools, startedAt, done }
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.startedAt > SESSION_TTL_MS) sessions.delete(sid);
}, 60000).unref();

/*
 * Replays a submitted game against the server's own copy of the problems.
 * answers: [{ v: number | null, t: ms since the clock started }]
 * v === null means the player skipped that problem.
 */
function scoreGame(session, answers, serverElapsed) {
  if (!Array.isArray(answers) || answers.length > 400) return { error: 'Game data is malformed.' };
  const ptr = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const shown = [];
  let solved = 0, points = 0, skips = 0, lastT = 0, lastWasSkip = false;
  for (const a of answers) {
    if (!a || typeof a.t !== 'number' || !(a.v === null || Number.isInteger(a.v))) return { error: 'Game data is malformed.' };
    const tier = Gen.tierForSolved(solved);
    const pool = session.pools[tier.tier];
    const p = pool[ptr[tier.tier]++];
    if (!p) return { error: 'Game data is malformed.' };
    shown.push(p.key);
    if (a.t < lastT || a.t > GAME_MS + 500) return { error: 'Answer times are out of order.' };
    const gap = a.t - lastT;
    if (lastWasSkip && gap < SKIP_PENALTY_MS - 150) return { error: 'Answer came in during a skip penalty.' };
    if (a.v === null) { skips++; lastWasSkip = true; lastT = a.t; continue; }
    if (a.v !== p.answer) return { error: 'An answer did not match its problem.' };
    if (gap < MIN_GAP_MS) return { error: 'Answers came in faster than anyone can type.' };
    solved++; points += tier.points; lastT = a.t; lastWasSkip = false;
  }
  // The clock only starts after the countdown, so the real time spent must
  // cover the last answer. A second of slack covers timer jitter.
  if (serverElapsed + 1000 < lastT) return { error: 'The game finished faster than its own clock.' };
  // The problem left on screen when time ran out also counts as seen.
  const tier = Gen.tierForSolved(solved);
  const next = session.pools[tier.tier][ptr[tier.tier]];
  if (next) shown.push(next.key);
  return { solved, points, skips, shown };
}

/* --------------------------------------------------------------- routes */
async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const route = req.method + ' ' + url.pathname;

  if (route === 'GET /api/config') {
    return send(res, 200, { gameMs: GAME_MS, countdownMs: COUNTDOWN_MS, skipPenaltyMs: SKIP_PENALTY_MS,
      month: monthKey(), tiers: Gen.TIERS.map((t) => ({ tier: t.tier, points: t.points, from: t.from })) });
  }

  if (route === 'POST /api/register' || route === 'POST /api/login') {
    if (limited(ip)) return send(res, 429, { error: 'Too many tries. Wait 10 minutes and try again.' });
    const body = await readBody(req);
    const name = String(body.username || '').trim();
    const pw = body.password;
    if (!validName(name)) return send(res, 400, { error: 'Usernames are 3 to 16 letters, numbers or underscores.' });
    if (!validPassword(pw)) return send(res, 400, { error: 'Passwords need at least 6 characters.' });
    const id = name.toLowerCase();

    if (route === 'POST /api/register') {
      const rec = { name, pw: hashPassword(pw), pwv: 0, created: Date.now(), games: 0, best: 0, solvedTotal: 0 };
      const ok = await store.createUser(id, rec);
      if (!ok) { noteFailure(ip); return send(res, 409, { error: 'That username is taken. Pick another one.' }); }
      return send(res, 200, { token: makeToken(id, 0), user: publicUser(rec) });
    }
    const user = await store.getUser(id);
    if (!user || !checkPassword(pw, user.pw)) {
      noteFailure(ip);
      return send(res, 401, { error: 'Wrong username or password.' });
    }
    return send(res, 200, { token: makeToken(id, user.pwv || 0), user: publicUser(user) });
  }

  if (route === 'GET /api/leaderboard') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'month';
    const board = period === 'all' ? 'all' : monthKey();
    const rows = await store.top(board, 50);
    const users = await store.getUsers(rows.map((r) => r.id));
    const out = rows.map((r, i) => ({ rank: i + 1, name: users[i] ? users[i].name : r.id, score: r.score, id: r.id }));
    const me = await authUser(req);
    let mine = null;
    if (me) {
      const r = await store.rankOf(board, me.id);
      if (r) mine = { rank: r.rank, score: r.score, name: me.user.name, id: me.id };
    }
    return send(res, 200, { period, board, rows: out, me: mine });
  }

  if (route === 'POST /api/admin') {
    if (!ADMIN_KEY) return send(res, 404, { error: 'The admin page is off. Set ADMIN_KEY to turn it on.' });
    if (limited(ip)) return send(res, 429, { error: 'Too many tries. Wait 10 minutes and try again.' });
    const body = await readBody(req);
    const given = Buffer.from(String(body.key || ''));
    const want = Buffer.from(ADMIN_KEY);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      noteFailure(ip); return send(res, 403, { error: 'Wrong admin key.' });
    }
    const id = String(body.username || '').trim().toLowerCase();
    const user = await store.getUser(id);
    if (!user) return send(res, 404, { error: 'No player named "' + body.username + '".' });
    if (body.action === 'reset-password') {
      if (!validPassword(body.newPassword)) return send(res, 400, { error: 'New passwords need at least 6 characters.' });
      user.pw = hashPassword(body.newPassword); user.pwv = (user.pwv || 0) + 1;
      await store.putUser(id, user);
      return send(res, 200, { ok: true, message: 'Password reset for ' + user.name + '. They have been signed out everywhere.' });
    }
    if (body.action === 'remove-scores') {
      await store.removeScores(id);
      user.best = 0; await store.putUser(id, user);
      return send(res, 200, { ok: true, message: user.name + ' was removed from every leaderboard.' });
    }
    if (body.action === 'delete-user') {
      await store.deleteUser(id);
      return send(res, 200, { ok: true, message: user.name + ' was deleted. The name is free again.' });
    }
    return send(res, 400, { error: 'Unknown action.' });
  }

  // Everything below needs a signed-in player.
  const me = await authUser(req);
  if (!me) return send(res, 401, { error: 'Sign in to continue.' });

  if (route === 'GET /api/me') return send(res, 200, { user: publicUser(me.user) });

  if (route === 'POST /api/game/start') {
    for (const [sid, s] of sessions) if (s.userId === me.id) sessions.delete(sid); // one game at a time
    const seen = await store.getSeen(me.id);
    const pools = Gen.buildRankedPools(seen);
    const sid = crypto.randomBytes(12).toString('base64url');
    sessions.set(sid, { userId: me.id, pools, startedAt: Date.now(), done: false });
    const clientPools = {};
    for (const k of Object.keys(pools)) clientPools[k] = pools[k].map((p) => ({ text: p.text, answer: p.answer }));
    return send(res, 200, { sessionId: sid, pools: clientPools });
  }

  if (route === 'POST /api/game/submit') {
    const body = await readBody(req);
    const s = sessions.get(body.sessionId);
    if (!s || s.userId !== me.id) return send(res, 404, { error: 'This game expired. Start a new one.' });
    if (s.done) return send(res, 409, { error: 'This game was already submitted.' });
    s.done = true;
    const elapsed = Date.now() - s.startedAt - COUNTDOWN_MS;
    if (elapsed > GAME_MS + 60000) return send(res, 400, { error: 'This game took too long to submit.' });
    const result = scoreGame(s, body.answers, elapsed);
    if (result.error) return send(res, 400, { error: result.error });

    const month = monthKey();
    const prevMonth = await store.rankOf(month, me.id);
    const user = me.user;
    const newBest = result.points > (user.best || 0);
    user.games = (user.games || 0) + 1;
    user.solvedTotal = (user.solvedTotal || 0) + result.solved;
    if (newBest) user.best = result.points;
    await store.putUser(me.id, user);
    await store.submitScore(['all', month], me.id, result.points);
    await store.addSeen(me.id, result.shown);
    const monthRank = await store.rankOf(month, me.id);
    sessions.delete(body.sessionId);
    return send(res, 200, {
      points: result.points, solved: result.solved, skips: result.skips,
      newBest, newMonthBest: !prevMonth || result.points > prevMonth.score,
      monthRank: monthRank && monthRank.rank, user: publicUser(user)
    });
  }

  return send(res, 404, { error: 'Not found.' });
}

function publicUser(u) {
  return { name: u.name, games: u.games || 0, best: u.best || 0, solvedTotal: u.solvedTotal || 0 };
}

/* ----------------------------------------------------------- static files */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) {
      if (e.message === 'bad_json' || e.message === 'too_large') return send(res, 400, { error: 'Bad request.' });
      console.error(e);
      send(res, 500, { error: 'The server hit an error. Try again in a moment.' });
    }
    return;
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  serveStatic(req, res, url);
});

async function main() {
  SECRET = await store.getSecret(crypto.randomBytes(32).toString('hex'));
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  MATH BLITZ is running!\n');
    console.log('  This computer:   http://localhost:' + PORT);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log('  Same Wi-Fi:      http://' + n.address + ':' + PORT);
      }
    }
    console.log('\n  Storage: ' + (store.kind === 'upstash' ? 'Upstash Redis' : 'local file in ' + (process.env.DATA_DIR || 'data/')));
    if (store.kind === 'file' && process.env.RENDER) {
      console.log('  WARNING: Render wipes local files on restart. Accounts and scores will be');
      console.log('  lost. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (see RENDER-DEPLOY.md).');
    }
    console.log('  Admin page: ' + (ADMIN_KEY ? '/admin.html' : 'off (set ADMIN_KEY to turn it on)') + '\n');
  });
}
function shutdown() { if (store.flushSync) store.flushSync(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) main();
module.exports = { scoreGame, monthKey };
