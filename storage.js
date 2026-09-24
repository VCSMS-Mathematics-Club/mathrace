/*
 * Storage for Math Blitz.
 *
 * Two backends with the same interface:
 *   - FileStore:    a JSON file on disk. Good for local and LAN play.
 *   - UpstashStore: Upstash Redis over its REST API. Use this when hosting on
 *                   Render's free tier, whose disk is wiped on every restart.
 *
 * Upstash is picked automatically when UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN are set. No npm packages are needed for either.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SEEN_CAP = 5000; // problems remembered per player to avoid repeats

/* ------------------------------------------------------------ file store */
class FileStore {
  constructor(dir) {
    this.kind = 'file';
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.db = { meta: {}, users: {}, boards: {}, seen: {} };
    if (fs.existsSync(this.file)) {
      try { Object.assign(this.db, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch (e) { console.error('Could not read ' + this.file + ', starting empty:', e.message); }
    }
    this.timer = null;
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db));
      fs.renameSync(tmp, this.file);
    }, 250);
  }
  flushSync() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.writeFileSync(this.file, JSON.stringify(this.db));
  }
  async getSecret(fresh) {
    if (!this.db.meta.secret) { this.db.meta.secret = fresh; this.save(); }
    return this.db.meta.secret;
  }
  async getUser(id) { return this.db.users[id] || null; }
  async getUsers(ids) { return ids.map((id) => this.db.users[id] || null); }
  async createUser(id, rec) {
    if (this.db.users[id]) return false;
    this.db.users[id] = rec; this.save(); return true;
  }
  async putUser(id, rec) { this.db.users[id] = rec; this.save(); }
  async deleteUser(id) {
    delete this.db.users[id]; delete this.db.seen[id];
    await this.removeScores(id);
  }
  async submitScore(boards, id, score) {
    for (const b of boards) {
      const board = this.db.boards[b] || (this.db.boards[b] = {});
      if (!(id in board) || score > board[id]) board[id] = score;
    }
    this.save();
  }
  async removeScores(id) {
    for (const b of Object.keys(this.db.boards)) delete this.db.boards[b][id];
    this.save();
  }
  sorted(board) {
    const b = this.db.boards[board] || {};
    return Object.keys(b).map((id) => [id, b[id]])
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  }
  async top(board, n) { return this.sorted(board).slice(0, n).map(([id, score]) => ({ id, score })); }
  async rankOf(board, id) {
    const list = this.sorted(board);
    const i = list.findIndex((x) => x[0] === id);
    return i === -1 ? null : { rank: i + 1, score: list[i][1] };
  }
  async getSeen(id) { return this.db.seen[id] || []; }
  async addSeen(id, keys) {
    const list = (this.db.seen[id] || []).filter((k) => !keys.includes(k)).concat(keys);
    this.db.seen[id] = list.slice(-SEEN_CAP);
    this.save();
  }
}

/* --------------------------------------------------------- upstash store */
class UpstashStore {
  constructor(url, token) {
    this.kind = 'upstash';
    this.url = url.replace(/\/+$/, '');
    this.token = token;
  }
  async req(pathPart, body) {
    const res = await fetch(this.url + pathPart, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error('Upstash request failed (' + res.status + '): ' + JSON.stringify(data));
    return data;
  }
  async cmd(...args) {
    const data = await this.req('', args.map(String));
    if (data.error) throw new Error('Upstash: ' + data.error);
    return data.result;
  }
  async pipe(cmds) {
    if (!cmds.length) return [];
    const data = await this.req('/pipeline', cmds.map((c) => c.map(String)));
    return data.map((d) => { if (d.error) throw new Error('Upstash: ' + d.error); return d.result; });
  }
  async getSecret(fresh) {
    await this.cmd('SET', 'mb:secret', fresh, 'NX');
    return this.cmd('GET', 'mb:secret');
  }
  async getUser(id) {
    const raw = await this.cmd('HGET', 'mb:users', id);
    return raw ? JSON.parse(raw) : null;
  }
  async getUsers(ids) {
    if (!ids.length) return [];
    const raw = await this.cmd('HMGET', 'mb:users', ...ids);
    return raw.map((r) => (r ? JSON.parse(r) : null));
  }
  async createUser(id, rec) {
    return (await this.cmd('HSETNX', 'mb:users', id, JSON.stringify(rec))) === 1;
  }
  async putUser(id, rec) { await this.cmd('HSET', 'mb:users', id, JSON.stringify(rec)); }
  async deleteUser(id) {
    await this.removeScores(id);
    await this.pipe([['HDEL', 'mb:users', id], ['DEL', 'mb:seen:' + id]]);
  }
  async submitScore(boards, id, score) {
    await this.pipe(boards.flatMap((b) => [
      ['ZADD', 'mb:lb:' + b, 'GT', score, id],
      ['SADD', 'mb:boards', b]
    ]));
  }
  async removeScores(id) {
    const boards = (await this.cmd('SMEMBERS', 'mb:boards')) || [];
    await this.pipe(boards.map((b) => ['ZREM', 'mb:lb:' + b, id]));
  }
  async top(board, n) {
    const flat = await this.cmd('ZRANGE', 'mb:lb:' + board, 0, n - 1, 'REV', 'WITHSCORES');
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ id: flat[i], score: Number(flat[i + 1]) });
    return out;
  }
  async rankOf(board, id) {
    const [rank, score] = await this.pipe([
      ['ZREVRANK', 'mb:lb:' + board, id],
      ['ZSCORE', 'mb:lb:' + board, id]
    ]);
    return rank === null || rank === undefined ? null : { rank: Number(rank) + 1, score: Number(score) };
  }
  async getSeen(id) { return (await this.cmd('ZRANGE', 'mb:seen:' + id, 0, -1)) || []; }
  async addSeen(id, keys) {
    if (!keys.length) return;
    const now = Date.now();
    const zadd = ['ZADD', 'mb:seen:' + id];
    keys.forEach((k, i) => zadd.push(now + i, k));
    await this.pipe([zadd, ['ZREMRANGEBYRANK', 'mb:seen:' + id, 0, -(SEEN_CAP + 1)]]);
  }
}

function createStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  return new FileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}

module.exports = { createStore, FileStore, UpstashStore, SEEN_CAP };
