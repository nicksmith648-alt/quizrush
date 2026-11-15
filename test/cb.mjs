import WebSocket from 'ws';
import fs from 'node:fs';
setTimeout(() => { console.log('TIMEOUT - test hung'); process.exit(2); }, 40000);
const PORT = process.env.PORT || 3055;
const open = () => new Promise((res) => { const w = new WebSocket(`ws://localhost:${PORT}/ws`); w.msgs = []; w.waiters = [];
  w.on('message', (d) => { const m = JSON.parse(d); w.msgs.push(m); w.waiters = w.waiters.filter((f) => f(m)); });
  w.on('open', () => res(w)); });
const waitFor = (w, t) => new Promise((res) => { const hit = w.msgs.find((m) => m.t === t && !m._seen); if (hit) { hit._seen = 1; return res(hit); }
  w.waiters.push((m) => { if (m.t === t && !m._seen) { m._seen = 1; res(m); return false; } return true; }); });
const send = (w, o) => w.send(JSON.stringify(o));
let fails = 0; const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };

// answer key from the quiz file
const key = {}; for (const block of fs.readFileSync('quizzes/english-warmup.txt', 'utf8').split(/\n\s*\n/).slice(1)) {
  const lines = block.trim().split('\n').filter((l) => !/^time:/i.test(l)); const opts = lines.slice(1);
  key[lines[0]] = opts.findIndex((o) => o.startsWith('*')); }
const right = (q) => key[q.q];
const wrong = (q) => (key[q.q] + 1) % q.options.length;

const host = await open(); send(host, { t: 'host', file: 'english-warmup.txt', mode: 'codebreaker', minutes: 1 });
const h = await waitFor(host, 'hosted'); check(h.mode === 'codebreaker' && h.minutes === 1, 'hosted in codebreaker mode');
const [a, b, c] = await Promise.all([open(), open(), open()]);
for (const [w, n] of [[a, 'Ana'], [b, 'Ben'], [c, 'Cy']]) { send(w, { t: 'join', pin: h.pin, name: n }); await waitFor(w, 'joined'); }
send(host, { t: 'start' });
await waitFor(host, 'cb_start');
const qa = await waitFor(a, 'cb_q'), qb = await waitFor(b, 'cb_q'); await waitFor(c, 'cb_q');
check(!!qa.q && qa.options.length >= 2 && !('correct' in qa), 'question sent without answer key');

// wrong answer: no coins, next question available
send(c, { t: 'cb_answer', choice: wrong(await Promise.resolve(c.msgs.find((m) => m.t === 'cb_q'))) });
const rc = await waitFor(c, 'cb_result'); check(rc.right === false && rc.coins === 0, 'wrong answer gives nothing and reveals the answer');
send(c, { t: 'cb_next' }); const qc2 = await waitFor(c, 'cb_q'); check(!!qc2.q, 'next question after wrong answer');

// first correct answer: nobody has coins to steal, so bonus
send(a, { t: 'cb_answer', choice: right(qa) });
const ra = await waitFor(a, 'cb_result'); check(ra.right && ra.crack === null && ra.coins === 200, `no rivals with coins -> bonus (coins=${ra.coins})`);
// double-answer ignored
send(a, { t: 'cb_answer', choice: 0 }); await new Promise((r) => setTimeout(r, 150));
check(a.msgs.filter((m) => m.t === 'cb_result').length === 1, 'duplicate answer ignored');
send(a, { t: 'cb_next' }); let qaN = await waitFor(a, 'cb_q');

// Ben answers right: Ana has coins -> crack offered with 3 codes; learn the real code from repeats
const seen = {}; let success = null, rounds = 0, qB = qb, hacked = null;
while (!success && rounds < 40) {
  rounds++;
  send(b, { t: 'cb_answer', choice: right(qB) });
  const r = await waitFor(b, 'cb_result');
  if (rounds === 1) check(r.crack && r.crack.codes.length === 3 && r.crack.target === 'Ana' && !('correctIdx' in r.crack), 'crack offers 3 codes for a rich rival, no answer leaked');
  if (!r.crack) { send(b, { t: 'cb_next' }); qB = await waitFor(b, 'cb_q'); continue; }
  const t = r.crack.target; seen[t] = seen[t] || [];
  seen[t].push(r.crack.codes);
  let pick = 0;
  if (seen[t].length >= 2) { const common = seen[t][0].filter((x) => seen[t].every((s) => s.includes(x))); if (common.length === 1) pick = r.crack.codes.indexOf(common[0]); }
  send(b, { t: 'cb_crack', pick });
  const cr = await waitFor(b, 'cb_crack_result');
  if (cr.success) { success = { cr, target: t, pickedFromRepeats: seen[t].length >= 2 }; break; }
  send(b, { t: 'cb_next' }); qB = await waitFor(b, 'cb_q');
}
check(!!success, `Ben cracked a vault by spotting the repeated code (rounds=${rounds})`);
if (success) {
  check(success.cr.stolen >= 50, `stole ${success.cr.stolen} coins from ${success.target}`);
  const victim = success.target === 'Ana' ? a : c;
  hacked = await waitFor(victim, 'cb_hacked'); check(hacked.by === 'Ben' && hacked.lost === success.cr.stolen, 'victim notified of the hack');
  const ev = await waitFor(host, 'cb_event'); check(/Ben cracked/.test(ev.text), 'host feed shows the hack');
}
const board = await waitFor(host, 'cb_board'); check(board.board.length === 3 && board.board[0].score >= board.board[1].score, 'host live leaderboard sorted');
const me = await waitFor(a, 'cb_me'); check(me.of === 3 && me.rank >= 1, 'player rank updates');

// late joiner gets the game in progress
const d = await open(); send(d, { t: 'join', pin: h.pin, name: 'Dee' }); await waitFor(d, 'joined');
check(!!(await waitFor(d, 'cb_start')).endAt && !!(await waitFor(d, 'cb_q')).q, 'late joiner is dropped into the running game');

// host ends the game
send(host, { t: 'finish' }); const end = await waitFor(host, 'end'); check(end.board.length === 4, 'host can end early; final board has all players');
const ea = await waitFor(a, 'end'); check(ea.of === 4 && ea.podium.length === 3, 'players receive final results');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
