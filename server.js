// QuizRush - original classroom quiz game server.
// Host opens /host on the big screen; students open the site on phones and enter the PIN.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const QUIZZES = path.join(__dirname, 'quizzes');
const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 200;
// Set HOST_PASSWORD when the site is public so only the teacher can start games.
const HOST_PASSWORD = process.env.HOST_PASSWORD || '';
const passwordOk = (given) => {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(HOST_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

/* ---------- quiz parsing ---------- */
// Accepts JSON {title, questions:[{q, options, correct, time}]} or simple text:
//   # Title
//   Question?            (blank line between questions)
//   time: 20             (optional)
//   * correct answer
//   wrong answer
function parseText(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  let title = 'Untitled quiz';
  const questions = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines[0].startsWith('# ')) { title = lines.shift().slice(2).trim() || title; if (!lines.length) continue; }
    const q = lines.shift();
    let time = 20;
    const options = [];
    let correct = -1;
    for (const line of lines) {
      const t = line.match(/^time:\s*(\d+)/i);
      if (t) { time = Number(t[1]); continue; }
      if (line.startsWith('*')) { correct = options.length; options.push(line.slice(1).trim()); } else options.push(line);
    }
    questions.push({ q, options, correct, time });
  }
  return { title, questions };
}

function normalizeQuiz(input) {
  let quiz = input;
  if (typeof input === 'string') {
    const s = input.trim();
    quiz = s.startsWith('{') ? JSON.parse(s) : parseText(s);
  }
  if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) throw new Error('Quiz has no questions');
  if (quiz.questions.length > 100) throw new Error('Too many questions (max 100)');
  const questions = quiz.questions.map((raw, i) => {
    const n = i + 1;
    const q = String(raw.q ?? '').trim().slice(0, 300);
    const options = (raw.options ?? []).map((o) => String(o).trim().slice(0, 120)).filter(Boolean);
    const correct = Number(raw.correct);
    const time = Math.min(120, Math.max(5, Number(raw.time) || 20));
    if (!q) throw new Error(`Question ${n} has no text`);
    if (options.length < 2 || options.length > 4) throw new Error(`Question ${n} needs 2-4 answers`);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length)
      throw new Error(`Question ${n} needs one correct answer (start it with *)`);
    return { q, options, correct, time };
  });
  return { title: String(quiz.title || 'Untitled quiz').slice(0, 100), questions };
}

function listQuizzes() {
  const out = [];
  for (const file of fs.readdirSync(QUIZZES)) {
    if (!/\.(json|txt)$/i.test(file)) continue;
    try {
      const quiz = normalizeQuiz(fs.readFileSync(path.join(QUIZZES, file), 'utf8'));
      out.push({ file, title: quiz.title, count: quiz.questions.length });
    } catch (e) {
      out.push({ file, title: `${file} (invalid: ${e.message})`, count: 0, invalid: true });
    }
  }
  return out;
}

/* ---------- game state ---------- */
const games = new Map();
let nextId = 1;

const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const connected = (g) => [...g.players.values()].filter((p) => p.ws);
const board = (g) => [...g.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const lobbyList = (g) => [...g.players.values()].map((p) => ({ id: p.id, name: p.name, online: !!p.ws, ready: !!p.code }));

function newPin() {
  let pin;
  do pin = String(Math.floor(100000 + Math.random() * 900000)); while (games.has(pin));
  return pin;
}

function nextQuestion(g) {
  g.qi++;
  if (g.qi >= g.quiz.questions.length) return endGame(g);
  const q = g.quiz.questions[g.qi];
  g.state = 'question';
  g.qStart = Date.now();
  for (const p of g.players.values()) { p.answered = false; p.choice = null; p.answeredAt = 0; }
  const base = { t: 'question', index: g.qi, total: g.quiz.questions.length, q: q.q, options: q.options, time: q.time };
  send(g.host, base);
  for (const p of connected(g)) send(p.ws, base);
  clearTimeout(g.timer);
  g.timer = setTimeout(() => reveal(g), q.time * 1000 + 400);
}

function reveal(g) {
  if (g.state !== 'question') return;
  clearTimeout(g.timer);
  g.state = 'reveal';
  const q = g.quiz.questions[g.qi];
  const counts = q.options.map(() => 0);
  const gained = new Map();
  for (const p of g.players.values()) {
    let points = 0;
    if (p.answered) {
      counts[p.choice]++;
      if (p.choice === q.correct) {
        const elapsed = Math.min(q.time, Math.max(0, (p.answeredAt - g.qStart) / 1000));
        p.streak++;
        points = Math.round(1000 * (1 - elapsed / q.time / 2)) + Math.min(p.streak - 1, 5) * 100;
        p.score += points;
      } else p.streak = 0;
    } else p.streak = 0;
    gained.set(p.id, points);
  }
  const sorted = board(g);
  const last = g.qi === g.quiz.questions.length - 1;
  send(g.host, {
    t: 'reveal', index: g.qi, correct: q.correct, counts, last,
    top: sorted.slice(0, 5).map((p) => ({ name: p.name, score: p.score, gained: gained.get(p.id) })),
  });
  sorted.forEach((p, i) => send(p.ws, {
    t: 'result', answered: p.answered, right: p.answered && p.choice === q.correct,
    correct: q.correct, points: gained.get(p.id), score: p.score, rank: i + 1, of: sorted.length, streak: p.streak, last,
  }));
}

/* ---------- Code Breaker mode ----------
   Self-paced race against the clock.
   - Every player chooses their own 4-digit vault code before the game and keeps it until a rival cracks it.
   - A correct answer earns coins and lets you decrypt 1 of 3 hidden packets: bonus coins, a x2 multiplier,
     or a HACK on a random rival.
   - A hack shows 3 codes for the rival, one of which is their real code. Right pick = steal 25% of their coins.
     Because codes stay fixed, remembering earlier guesses (and what was wrong) makes later hacks easier. */
const newCode = () => String(Math.floor(1000 + Math.random() * 9000));
const shuffled = (n) => {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const CB_BASE = 100, CB_STREAK = 20, CB_MULTI_ANSWERS = 3;
const rollPacket = () => {
  const r = Math.random();
  if (r < 0.5) return { type: 'coins', amount: [100, 150, 200, 250, 300][Math.floor(Math.random() * 5)] };
  if (r < 0.65) return { type: 'multi' };
  return { type: 'hack' };
};
const cbBusy = (p) => p.cbq != null || p.pack || p.crack || p.needCode;

function cbNextQuestion(g, p) {
  if (!p.order || p.pos >= p.order.length) { p.order = shuffled(g.quiz.questions.length); p.pos = 0; }
  p.cbq = p.order[p.pos++];
  p.pack = null; p.crack = null;
  const q = g.quiz.questions[p.cbq];
  send(p.ws, { t: 'cb_q', q: q.q, options: q.options, coins: p.score, streak: p.streak, mult: p.mult });
}

function cbBoard(g) {
  const sorted = board(g);
  send(g.host, {
    t: 'cb_board', left: Math.max(0, g.endAt - Date.now()), players: g.players.size,
    board: sorted.slice(0, 10).map((p) => ({ name: p.name, score: p.score })),
  });
  sorted.forEach((p, i) => send(p.ws, { t: 'cb_me', rank: i + 1, of: sorted.length, coins: p.score }));
}

function cbStart(g) {
  g.state = 'running';
  g.endAt = Date.now() + g.minutes * 60000;
  const msg = { t: 'cb_start', endAt: g.endAt };
  send(g.host, msg);
  for (const p of g.players.values()) {
    p.score = 0; p.streak = 0; p.mult = 0;
    if (!p.code) p.code = newCode(); // anyone who skipped the portal gets a random code
    if (p.ws) { send(p.ws, msg); cbNextQuestion(g, p); }
  }
  g.tick = setInterval(() => cbBoard(g), 1500);
  clearTimeout(g.timer);
  g.timer = setTimeout(() => endGame(g), g.minutes * 60000);
  cbBoard(g);
}

function cbSetCode(g, p, ws, codeRaw) {
  if (g.mode !== 'codebreaker' || (g.state !== 'lobby' && g.state !== 'running')) return;
  const code = String(codeRaw ?? '');
  if (!/^\d{4}$/.test(code)) return send(ws, { t: 'cb_code_error', msg: 'Use exactly 4 digits.' });
  if (p.mustReset && code === p.lastCracked) return send(ws, { t: 'cb_code_error', msg: 'That code was cracked. Pick a new one.' });
  p.code = code; p.mustReset = false;
  send(ws, { t: 'cb_code_ok' });
  if (g.state === 'lobby') send(g.host, { t: 'players', list: lobbyList(g) });
  if (g.state === 'running' && p.needCode) { p.needCode = false; cbNextQuestion(g, p); }
}

function cbAnswer(g, p, ws, choiceRaw) {
  if (g.state !== 'running' || p.cbq == null || p.pack || p.crack || p.needCode) return;
  const q = g.quiz.questions[p.cbq];
  const choice = Number(choiceRaw);
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
  p.cbq = null;
  if (choice !== q.correct) {
    p.streak = 0;
    return send(ws, { t: 'cb_result', right: false, correct: q.correct, coins: p.score });
  }
  p.streak++;
  let gain = CB_BASE + Math.min(p.streak - 1, 5) * CB_STREAK;
  const boosted = p.mult > 0;
  if (boosted) { gain *= 2; p.mult--; }
  p.score += gain;
  p.pack = [rollPacket(), rollPacket(), rollPacket()];
  send(ws, { t: 'cb_result', right: true, gain, boosted, coins: p.score, streak: p.streak, mult: p.mult, packets: 3 });
}

function cbPick(g, p, ws, idxRaw) {
  if (g.state !== 'running' || !p.pack) return;
  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0 || idx > 2) return;
  const all = p.pack.map((o) => o.type);
  let o = p.pack[idx];
  p.pack = null;
  if (o.type === 'hack') {
    const rivals = [...g.players.values()].filter((x) => x !== p && x.score > 0);
    if (!rivals.length) o = { type: 'coins', amount: 200, fallback: true }; // nobody to hack yet
    else {
      const target = rivals[Math.floor(Math.random() * rivals.length)];
      const correctIdx = Math.floor(Math.random() * 3);
      const codes = [];
      while (codes.length < 2) { const c = newCode(); if (c !== target.code && !codes.includes(c)) codes.push(c); }
      codes.splice(correctIdx, 0, target.code);
      p.crack = { targetId: target.id, correctIdx };
      return send(ws, { t: 'cb_pick_result', type: 'hack', idx, all, coins: p.score,
        crack: { target: target.name, targetCoins: target.score, codes } });
    }
  }
  if (o.type === 'coins') {
    p.score += o.amount;
    return send(ws, { t: 'cb_pick_result', type: 'coins', amount: o.amount, fallback: !!o.fallback, idx, all, coins: p.score });
  }
  p.mult = CB_MULTI_ANSWERS;
  send(ws, { t: 'cb_pick_result', type: 'multi', left: p.mult, idx, all, coins: p.score });
  send(g.host, { t: 'cb_event', kind: 'multi', text: `${p.name} unlocked a x2 multiplier` });
}

function cbCrack(g, p, ws, pickRaw) {
  if (g.state !== 'running' || !p.crack) return;
  const pick = Number(pickRaw);
  if (!Number.isInteger(pick) || pick < 0 || pick > 2) return;
  const { targetId, correctIdx } = p.crack;
  p.crack = null;
  const target = g.players.get(targetId);
  if (target && pick === correctIdx) {
    const stolen = Math.min(target.score, Math.max(50, Math.floor(target.score * 0.25)));
    target.score -= stolen; p.score += stolen;
    target.lastCracked = target.code; target.code = newCode(); target.mustReset = true; // rotated; they must choose a new one
    send(ws, { t: 'cb_crack_result', success: true, stolen, coins: p.score, target: target.name });
    send(target.ws, { t: 'cb_hacked', by: p.name, lost: stolen, coins: target.score });
    send(g.host, { t: 'cb_event', kind: 'hack', text: `${p.name} breached ${target.name}'s vault: -${stolen}` });
  } else {
    send(ws, { t: 'cb_crack_result', success: false, coins: p.score, target: target ? target.name : '' });
    send(g.host, { t: 'cb_event', kind: 'fail', text: `${p.name} failed to breach ${target ? target.name : 'a vault'}` });
  }
}

function endGame(g) {
  clearTimeout(g.timer);
  clearInterval(g.tick);
  g.state = 'ended';
  const sorted = board(g);
  send(g.host, { t: 'end', board: sorted.slice(0, 10).map((p) => ({ name: p.name, score: p.score })) });
  sorted.forEach((p, i) => send(p.ws, {
    t: 'end', rank: i + 1, of: sorted.length, score: p.score,
    podium: sorted.slice(0, 3).map((x) => ({ name: x.name, score: x.score })),
  }));
}

function closeGame(g, reason) {
  clearTimeout(g.timer);
  clearInterval(g.tick);
  for (const p of g.players.values()) send(p.ws, { t: 'closed', reason });
  games.delete(g.pin);
}

/* ---------- websocket handling ---------- */
function handle(ws, m) {
  const ctx = ws.ctx;
  switch (m.t) {
    case 'host': {
      if (ctx.game) return;
      if (HOST_PASSWORD && !passwordOk(m.password)) {
        // slow down guessing
        return setTimeout(() => send(ws, { t: 'error', msg: 'Wrong teacher password.' }), 1000);
      }
      try {
        const load = (f) => {
          const file = path.basename(String(f));
          if (!/\.(json|txt)$/i.test(file)) throw new Error('Unknown quiz');
          return normalizeQuiz(fs.readFileSync(path.join(QUIZZES, file), 'utf8'));
        };
        let quiz;
        if (Array.isArray(m.files) && m.files.length) { // several quizzes combined into one big pool
          const parts = m.files.slice(0, 20).map(load);
          quiz = { title: parts.length === 1 ? parts[0].title : `Mixed quiz (${parts.length} sets)`, questions: parts.flatMap((x) => x.questions) };
          if (quiz.questions.length > 300) throw new Error('Too many questions in total (max 300)');
        } else if (m.file) quiz = load(m.file);
        else quiz = normalizeQuiz(m.text);
        const mode = m.mode === 'codebreaker' ? 'codebreaker' : 'classic';
        const minutes = Math.min(30, Math.max(1, Number(m.minutes) || 5));
        const g = { pin: newPin(), quiz, mode, minutes, host: ws, players: new Map(), state: 'lobby', qi: -1, timer: null, tick: null, qStart: 0 };
        games.set(g.pin, g);
        ctx.role = 'host'; ctx.game = g;
        send(ws, { t: 'hosted', pin: g.pin, title: quiz.title, count: quiz.questions.length, mode, minutes });
      } catch (e) {
        send(ws, { t: 'error', msg: e.message });
      }
      break;
    }
    case 'join': {
      if (ctx.game) return;
      const g = games.get(String(m.pin || '').trim());
      const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
      if (!g) return send(ws, { t: 'error', msg: 'Game not found. Check the PIN.' });
      if (!name) return send(ws, { t: 'error', msg: 'Enter a nickname.' });
      if (g.state === 'ended') return send(ws, { t: 'error', msg: 'This game has finished.' });
      let p = [...g.players.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (p && p.ws) return send(ws, { t: 'error', msg: 'That nickname is taken. Try another.' });
      if (!p) {
        if (g.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Game is full.' });
        p = { id: nextId++, name, score: 0, streak: 0, answered: false, choice: null, answeredAt: 0, ws: null,
          code: null, mustReset: false, mult: 0, needCode: false, order: null, pos: 0, cbq: null, pack: null, crack: null };
        g.players.set(p.id, p);
      }
      p.ws = ws; ctx.role = 'player'; ctx.game = g; ctx.player = p;
      send(ws, { t: 'joined', name: p.name, state: g.state, mode: g.mode, hasCode: !!p.code });
      send(g.host, { t: 'players', list: lobbyList(g) });
      if (g.state === 'running') { // joining or rejoining a Code Breaker game in progress
        send(ws, { t: 'cb_start', endAt: g.endAt });
        if (!p.code) { p.needCode = true; send(ws, { t: 'cb_needcode' }); } // brand-new player: choose a code first
        else cbNextQuestion(g, p);
      }
      if (g.state === 'question') { // rejoining mid-question
        const q = g.quiz.questions[g.qi];
        const left = Math.max(1, Math.round(q.time - (Date.now() - g.qStart) / 1000));
        send(ws, { t: 'question', index: g.qi, total: g.quiz.questions.length, q: q.q, options: q.options, time: left, already: p.answered });
      }
      break;
    }
    case 'start':
      if (ctx.role === 'host' && ctx.game.state === 'lobby' && connected(ctx.game).length) {
        if (ctx.game.mode === 'codebreaker') cbStart(ctx.game); else nextQuestion(ctx.game);
      }
      break;
    case 'cb_setcode':
      if (ctx.role === 'player') cbSetCode(ctx.game, ctx.player, ws, m.code);
      break;
    case 'cb_answer':
      if (ctx.role === 'player') cbAnswer(ctx.game, ctx.player, ws, m.choice);
      break;
    case 'cb_pick':
      if (ctx.role === 'player') cbPick(ctx.game, ctx.player, ws, m.idx);
      break;
    case 'cb_crack':
      if (ctx.role === 'player') cbCrack(ctx.game, ctx.player, ws, m.pick);
      break;
    case 'cb_next': {
      const g = ctx.game, p = ctx.player;
      if (ctx.role === 'player' && g.state === 'running' && !cbBusy(p)) cbNextQuestion(g, p);
      break;
    }
    case 'finish':
      if (ctx.role === 'host' && ctx.game.state === 'running') endGame(ctx.game);
      break;
    case 'answer': {
      const g = ctx.game, p = ctx.player;
      if (ctx.role !== 'player' || g.state !== 'question' || p.answered) return;
      const q = g.quiz.questions[g.qi];
      const choice = Number(m.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
      p.answered = true; p.choice = choice; p.answeredAt = Date.now();
      send(ws, { t: 'ack' });
      const online = connected(g);
      send(g.host, { t: 'count', answered: online.filter((x) => x.answered).length, total: online.length });
      if (online.every((x) => x.answered)) reveal(g);
      break;
    }
    case 'skip':
      if (ctx.role === 'host') reveal(ctx.game);
      break;
    case 'next':
      if (ctx.role === 'host' && ctx.game.state === 'reveal') nextQuestion(ctx.game);
      break;
    case 'kick': {
      if (ctx.role !== 'host') return;
      const p = ctx.game.players.get(Number(m.id));
      if (!p) return;
      send(p.ws, { t: 'closed', reason: 'You were removed from the game.' });
      if (p.ws) { p.ws.ctx = {}; }
      ctx.game.players.delete(p.id);
      send(ctx.game.host, { t: 'players', list: lobbyList(ctx.game) });
      break;
    }
  }
}

function onClose(ws) {
  const { role, game: g, player: p } = ws.ctx;
  if (!g) return;
  if (role === 'host') return closeGame(g, 'The host left, so the game ended.');
  if (role === 'player' && p && p.ws === ws) {
    p.ws = null;
    send(g.host, { t: 'players', list: lobbyList(g) });
    if (g.state === 'question') {
      const online = connected(g);
      send(g.host, { t: 'count', answered: online.filter((x) => x.answered).length, total: online.length });
      if (online.length && online.every((x) => x.answered)) reveal(g);
    }
  }
}

/* ---------- http ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ips, port: PORT, needsPassword: !!HOST_PASSWORD }));
  }
  if (url.pathname === '/api/quizzes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(listQuizzes()));
  }
  let rel = url.pathname === '/' ? '/index.html' : url.pathname === '/host' ? '/host.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 100 * 1024 });
wss.on('connection', (ws) => {
  ws.ctx = {};
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && typeof m === 'object') try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`QuizRush running.\n  Teacher (big screen): http://localhost:${PORT}/host`);
  for (const ip of ips) console.log(`  Students join at:     http://${ip}:${PORT}`);
});

export { normalizeQuiz, parseText };
