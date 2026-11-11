'use strict';
/*
 * Same Letter, Different Words — live multiplayer quiz server.
 * Zero dependencies. Needs Node 18+.   Run:  node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const RESULTS_DIR = path.join(__dirname, 'results');
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8'));
const LETTERS = [...new Set(QUESTIONS.map(q => q.letter))];

const games = new Map();

/* ---------- helpers ---------- */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const token = () => crypto.randomBytes(12).toString('hex');
function newCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
    if (!games.has(c)) return c;
  }
}
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function isCorrect(q, guess, fuzzy) {
  const g = norm(guess);
  if (!g) return false;
  const targets = [q.answer, ...(q.alt || [])].map(norm);
  if (targets.includes(g)) return true;
  if (fuzzy) return targets.some(t => t.length >= 7 && lev(t, g) <= 1);
  return false;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const cleanName = s => String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };

/* ---------- game logic ---------- */
function createGame(opts) {
  let letters = Array.isArray(opts.letters) ? opts.letters.map(x => String(x).toUpperCase()).filter(x => LETTERS.includes(x)) : [];
  letters = [...new Set(letters)];
  if (!letters.length) letters = LETTERS.slice();
  if (opts.shuffleLetters) shuffle(letters); else letters.sort();
  const queue = [];
  for (const L of letters) for (const q of QUESTIONS.filter(x => x.letter === L)) queue.push(q);
  const g = {
    code: newCode(), hostToken: token(), created: Date.now(), last: Date.now(),
    settings: {
      letters,
      clueSeconds: clamp(opts.clueSeconds, 5, 60, 10),
      revealSeconds: clamp(opts.revealSeconds, 3, 20, 6),
      autoAdvance: opts.autoAdvance !== false,
      scoring: opts.scoring === 'classic' ? 'classic' : 'speed',
      fuzzy: !!opts.fuzzy,
    },
    phase: 'lobby', queue, idx: -1,
    players: new Map(), clients: new Set(),
    clueStart: 0, endsAt: 0, solved: [], timer: null, log: [],
  };
  games.set(g.code, g);
  return g;
}
const cur = g => g.queue[g.idx];
const connectedPlayers = g => [...g.players.values()].filter(p => p.connected);

function leaderboard(g) {
  return [...g.players.values()]
    .sort((a, b) => b.score - a.score || b.correct - a.correct || a.totalMs - b.totalMs || a.name.localeCompare(b.name))
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, correct: p.correct, avgMs: p.correct ? Math.round(p.totalMs / p.correct) : null, rank: i + 1, connected: p.connected }));
}
function pointsFor(g, q, rank, elapsedMs) {
  if (g.settings.scoring === 'classic') return ['X', 'Y', 'Z'].includes(q.letter) ? 2 : 1;
  const total = g.settings.clueSeconds * 1000;
  const frac = Math.max(0, total - elapsedMs) / total;
  const bonus = [30, 20, 10][rank - 1] || 0;
  return 100 + Math.round(100 * frac) + bonus;
}

function startClue(g) {
  clearTimeout(g.timer);
  g.idx++;
  if (g.idx >= g.queue.length) return finish(g);
  g.phase = 'clue';
  g.solved = [];
  g.clueStart = Date.now();
  g.endsAt = g.clueStart + g.settings.clueSeconds * 1000;
  g.timer = setTimeout(() => endClue(g), g.settings.clueSeconds * 1000 + 50);
  broadcast(g);
}
function endClue(g) {
  if (g.phase !== 'clue') return;
  clearTimeout(g.timer);
  g.phase = 'reveal';
  g.log.push({ letter: cur(g).letter, n: cur(g).n, answer: cur(g).answer, solved: g.solved.map(s => ({ name: g.players.get(s.id)?.name, ms: s.ms, points: s.points })) });
  const isLast = g.idx >= g.queue.length - 1;
  g.revealEndsAt = Date.now() + g.settings.revealSeconds * 1000;
  if (g.settings.autoAdvance) g.timer = setTimeout(() => (isLast ? finish(g) : startClue(g)), g.settings.revealSeconds * 1000);
  broadcast(g);
}
function finish(g) {
  clearTimeout(g.timer);
  g.phase = 'finished';
  broadcast(g);
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(RESULTS_DIR, `game-${g.code}-${stamp}.json`), JSON.stringify({ code: g.code, finishedAt: new Date().toISOString(), settings: g.settings, leaderboard: leaderboard(g), rounds: g.log }, null, 2));
  } catch (e) { /* read-only disk is fine; host can still download CSV */ }
}

/* ---------- views & SSE ---------- */
function baseView(g) {
  const q = g.phase === 'clue' || g.phase === 'reveal' ? cur(g) : null;
  return {
    code: g.code, phase: g.phase, serverNow: Date.now(), settings: g.settings,
    progress: { index: Math.max(0, g.idx), total: g.queue.length },
    clue: q ? { letter: q.letter, n: q.n, text: q.clue, endsAt: g.endsAt, startedAt: g.clueStart, seconds: g.settings.clueSeconds } : null,
    reveal: g.phase === 'reveal' ? { answer: q.answer, endsAt: g.revealEndsAt, auto: g.settings.autoAdvance, last: g.idx >= g.queue.length - 1 } : null,
    leaderboard: leaderboard(g),
    playerCount: g.players.size,
    answeredCount: g.solved.length,
    activeCount: connectedPlayers(g).length,
  };
}
function hostView(g) {
  const v = baseView(g);
  v.role = 'host';
  v.solved = g.solved.map(s => ({ name: g.players.get(s.id)?.name, ms: s.ms, points: s.points }));
  v.players = [...g.players.values()].map(p => ({ id: p.id, name: p.name, connected: p.connected, solved: g.solved.some(s => s.id === p.id) }));
  return v;
}
function playerView(g, p) {
  const v = baseView(g);
  v.role = 'player';
  const mine = g.solved.find(s => s.id === p.id);
  const lb = v.leaderboard;
  v.you = { id: p.id, name: p.name, score: p.score, correct: p.correct, rank: lb.find(x => x.id === p.id)?.rank, solved: !!mine, points: mine?.points || 0, ms: mine?.ms || 0, place: mine ? g.solved.indexOf(mine) + 1 : 0 };
  v.leaderboard = lb.slice(0, 10);
  if (g.phase === 'reveal') v.solved = g.solved.slice(0, 5).map(s => ({ name: g.players.get(s.id)?.name, ms: s.ms, points: s.points }));
  return v;
}
function send(res, v) { res.write(`data: ${JSON.stringify(v)}\n\n`); }
function broadcast(g) {
  g.last = Date.now();
  for (const c of g.clients) {
    try {
      if (c.role === 'host') send(c.res, hostView(g));
      else { const p = g.players.get(c.pid); if (p) send(c.res, playerView(g, p)); }
    } catch (e) { g.clients.delete(c); }
  }
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
const hostGame = (code, t) => { const g = games.get(String(code || '').toUpperCase()); return g && g.hostToken === t ? g : null; };

async function api(req, res, url) {
  const route = url.pathname;
  const q = url.searchParams;

  if (route === '/api/check') {
    const g = games.get(String(q.get('code') || '').toUpperCase());
    if (!g) return json(res, 404, { error: 'Game not found' });
    const ok = q.get('role') === 'host' ? g.hostToken === q.get('token') : [...g.players.values()].some(x => x.token === q.get('token'));
    return json(res, ok ? 200 : 403, { ok });
  }

  if (route === '/api/events') {
    const g = games.get(String(q.get('code') || '').toUpperCase());
    if (!g) return json(res, 404, { error: 'Game not found' });
    let client;
    if (q.get('role') === 'host') {
      if (g.hostToken !== q.get('token')) return json(res, 403, { error: 'Bad host key' });
      client = { role: 'host', res };
    } else {
      const p = [...g.players.values()].find(x => x.token === q.get('token'));
      if (!p) return json(res, 403, { error: 'Not in this game' });
      client = { role: 'player', res, pid: p.id };
      p.connected = true;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    g.clients.add(client);
    send(res, client.role === 'host' ? hostView(g) : playerView(g, g.players.get(client.pid)));
    if (client.role === 'player') broadcastSoon(g);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb); g.clients.delete(client);
      if (client.role === 'player') {
        const p = g.players.get(client.pid);
        if (p && ![...g.clients].some(c => c.pid === p.id)) { p.connected = false; broadcastSoon(g); maybeEarlyEnd(g); }
      }
    });
    return;
  }

  if (route === '/api/letters') return json(res, 200, { letters: LETTERS.slice().sort() });

  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const b = await body(req);

  if (route === '/api/create') {
    const g = createGame(b);
    return json(res, 200, { code: g.code, hostToken: g.hostToken, total: g.queue.length });
  }

  if (route === '/api/join') {
    const g = games.get(String(b.code || '').toUpperCase());
    if (!g) return json(res, 404, { error: 'No game with that code. Check the code and try again.' });
    if (g.phase === 'finished') return json(res, 400, { error: 'That game has already finished.' });
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'Please enter a name.' });
    // rejoin with a saved token
    const existing = [...g.players.values()].find(p => p.token === b.token);
    if (existing) return json(res, 200, { token: existing.token, name: existing.name, code: g.code });
    if (g.players.size >= 200) return json(res, 400, { error: 'Game is full.' });
    if ([...g.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) return json(res, 400, { error: 'That name is taken. Pick another.' });
    const p = { id: token().slice(0, 8), token: token(), name, score: 0, correct: 0, totalMs: 0, connected: false };
    g.players.set(p.id, p);
    broadcast(g);
    return json(res, 200, { token: p.token, name: p.name, code: g.code });
  }

  if (route === '/api/guess') {
    const now = Date.now();
    const g = games.get(String(b.code || '').toUpperCase());
    const p = g && [...g.players.values()].find(x => x.token === b.token);
    if (!p) return json(res, 403, { error: 'Not in game' });
    if (g.phase !== 'clue' || now > g.endsAt) return json(res, 200, { status: 'closed' });
    if (g.solved.some(s => s.id === p.id)) return json(res, 200, { status: 'already' });
    const q = cur(g);
    if (!isCorrect(q, b.text, g.settings.fuzzy)) return json(res, 200, { status: 'wrong' });
    const elapsed = now - g.clueStart;
    const rank = g.solved.length + 1;
    const points = pointsFor(g, q, rank, elapsed);
    g.solved.push({ id: p.id, ms: elapsed, points });
    p.score += points; p.correct++; p.totalMs += elapsed;
    broadcast(g);
    maybeEarlyEnd(g);
    return json(res, 200, { status: 'correct', points, place: rank, ms: elapsed });
  }

  if (route === '/api/host') {
    const g = hostGame(b.code, b.token);
    if (!g) return json(res, 403, { error: 'Not the host' });
    switch (b.action) {
      case 'start':
        if (g.phase !== 'lobby') break;
        if (!g.players.size) return json(res, 400, { error: 'Wait for at least one player to join.' });
        startClue(g); break;
      case 'next':
        if (g.phase === 'reveal') { g.idx >= g.queue.length - 1 ? finish(g) : startClue(g); }
        break;
      case 'reveal': endClue(g); break;
      case 'end': if (g.phase !== 'lobby' && g.phase !== 'finished') { clearTimeout(g.timer); if (g.phase === 'clue') endClue(g), clearTimeout(g.timer); finish(g); } break;
      case 'kick': {
        const p = g.players.get(b.id);
        if (p) {
          for (const c of g.clients) if (c.pid === p.id) { try { c.res.end(); } catch {} g.clients.delete(c); }
          g.players.delete(p.id); g.solved = g.solved.filter(s => s.id !== p.id); broadcast(g);
        }
        break;
      }
    }
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Unknown route' });
}
let soon = new Map();
function broadcastSoon(g) { if (soon.has(g)) return; soon.set(g, setTimeout(() => { soon.delete(g); broadcast(g); }, 150)); }
function maybeEarlyEnd(g) {
  if (g.phase !== 'clue') return;
  const active = connectedPlayers(g);
  if (active.length && active.every(p => g.solved.some(s => s.id === p.id))) setTimeout(() => endClue(g), 700);
}

function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csvFor(g, detail) {
  if (!detail) {
    const rows = [['Rank', 'Name', 'Score', 'Correct answers', 'Avg answer time (s)']];
    for (const p of leaderboard(g)) rows.push([p.rank, p.name, p.score, p.correct, p.avgMs == null ? '' : (p.avgMs / 1000).toFixed(2)]);
    return rows.map(r => r.map(csvCell).join(',')).join('\n');
  }
  const rows = [['Round letter', 'Clue #', 'Answer', 'Player', 'Place', 'Time (s)', 'Points']];
  for (const r of g.log) {
    if (!r.solved.length) rows.push([r.letter, r.n, r.answer, '(nobody)', '', '', 0]);
    r.solved.forEach((s, i) => rows.push([r.letter, r.n, r.answer, s.name, i + 1, (s.ms / 1000).toFixed(2), s.points]));
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/results.csv') {
      const g = hostGame(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!g) return json(res, 403, { error: 'Not the host' });
      const detail = url.searchParams.get('detail') === '1';
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="game-${g.code}-${detail ? 'detail' : 'scores'}.csv"` });
      return res.end('﻿' + csvFor(g, detail));
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    f = path.normalize(path.join(PUBLIC, f));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); try { res.writeHead(500); res.end('Server error'); } catch {} }
});

setInterval(() => { // drop games idle for 8 hours
  for (const [c, g] of games) if (Date.now() - g.last > 8 * 3600e3) { clearTimeout(g.timer); games.delete(c); }
}, 600e3);

server.listen(PORT, '0.0.0.0', () => {
  const nets = Object.values(require('os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`\n  Same Letter, Different Words is running\n`);
  console.log(`  Host a game:   http://localhost:${PORT}/host.html`);
  nets.forEach(n => console.log(`  Same Wi-Fi:    http://${n.address}:${PORT}`));
  console.log('');
});
module.exports = { norm, isCorrect };
