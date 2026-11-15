import WebSocket from 'ws';
import fs from 'node:fs';
setTimeout(() => { console.log('TIMEOUT - test hung'); process.exit(2); }, 60000);
const PORT = process.env.PORT || 3055;
const open = () => new Promise((res) => { const w = new WebSocket(`ws://localhost:${PORT}/ws`); w.msgs = []; w.waiters = [];
  w.on('message', (d) => { const m = JSON.parse(d); w.msgs.push(m); w.waiters = w.waiters.filter((f) => f(m)); });
  w.on('open', () => res(w)); });
const waitFor = (w, t) => new Promise((res) => { const hit = w.msgs.find((m) => m.t === t && !m._seen); if (hit) { hit._seen = 1; return res(hit); }
  w.waiters.push((m) => { if (m.t === t && !m._seen) { m._seen = 1; res(m); return false; } return true; }); });
const send = (w, o) => w.send(JSON.stringify(o));
let fails = 0; const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };

// answer key from both quiz files
const key = {};
for (const f of ['english-warmup.txt', 'romeo-and-juliet.txt']) for (const block of fs.readFileSync('quizzes/' + f, 'utf8').split(/\n\s*\n/).slice(1)) {
  const lines = block.trim().split('\n').filter((l) => !/^time:/i.test(l)); key[lines[0]] = lines.slice(1).findIndex((o) => o.startsWith('*')); }
const right = (q) => key[q.q];

// ---------- game 1: merged quizzes, player-set codes ----------
const host = await open(); send(host, { t: 'host', files: ['english-warmup.txt', 'romeo-and-juliet.txt'], mode: 'codebreaker', minutes: 1 });
const h = await waitFor(host, 'hosted');
check(h.mode === 'codebreaker' && h.count === 19 && /Mixed/.test(h.title), `two quizzes merged into one pool (${h.count} questions)`);
const [a, b, c] = await Promise.all([open(), open(), open()]);
const joined = {};
for (const [w, n] of [[a, 'Ana'], [b, 'Ben'], [c, 'Cy']]) { send(w, { t: 'join', pin: h.pin, name: n }); joined[n] = await waitFor(w, 'joined'); }
check(joined.Ana.mode === 'codebreaker' && joined.Ana.hasCode === false, 'joined in codebreaker mode, no code yet');

send(a, { t: 'cb_setcode', code: 'abc' }); check(!!(await waitFor(a, 'cb_code_error')).msg, 'invalid code rejected');
send(a, { t: 'cb_setcode', code: '4242' }); await waitFor(a, 'cb_code_ok'); check(true, 'Ana locked her own code');
send(b, { t: 'cb_setcode', code: '7777' }); await waitFor(b, 'cb_code_ok');
await new Promise((r) => setTimeout(r, 150));
const lastList = [...host.msgs].reverse().find((m) => m.t === 'players');
check(lastList.list.find((p) => p.name === 'Ana').ready && !lastList.list.find((p) => p.name === 'Cy').ready, 'host sees who has locked a vault');

send(host, { t: 'start' }); await waitFor(host, 'cb_start');
const qa = await waitFor(a, 'cb_q'); let qb = await waitFor(b, 'cb_q'); await waitFor(c, 'cb_q');
check(!!qa.q && !('correct' in qa), 'questions sent without the answer key');

// Ana: right answer -> 3 hidden packets -> pick
send(a, { t: 'cb_answer', choice: right(qa) });
const ra = await waitFor(a, 'cb_result'); check(ra.right && ra.packets === 3 && !('all' in ra), `correct answer earns ${ra.gain} coins and 3 hidden packets`);
send(a, { t: 'cb_answer', choice: 0 }); await new Promise((r) => setTimeout(r, 100));
check(a.msgs.filter((m) => m.t === 'cb_result').length === 1, 'cannot answer again while a packet is waiting');
send(a, { t: 'cb_pick', idx: 0 }); const pa = await waitFor(a, 'cb_pick_result');
check(['coins', 'multi', 'hack'].includes(pa.type) && pa.all.length === 3, `Ana opened a packet (${pa.type})`);

// Ben farms packets until he gets a HACK
async function benUntilHack(avoidCode) {
  for (let i = 0; i < 80; i++) {
    send(b, { t: 'cb_answer', choice: right(qb) });
    const r = await waitFor(b, 'cb_result');
    if (!r.right) throw new Error('unexpected wrong');
    send(b, { t: 'cb_pick', idx: 0 });
    const pr = await waitFor(b, 'cb_pick_result');
    if (pr.type === 'hack') return pr;
    send(b, { t: 'cb_next' }); qb = await waitFor(b, 'cb_q');
  }
  throw new Error('never got a hack packet');
}
const hk = await benUntilHack();
check(hk.crack.target === 'Ana' && hk.crack.codes.length === 3, 'hack packet targets a rival who has coins');
check(hk.crack.codes.includes('4242'), "offered codes include the target's OWN chosen code");
check(!('correctIdx' in hk.crack), 'answer index not leaked');
send(b, { t: 'cb_crack', pick: hk.crack.codes.indexOf('4242') });
const cr = await waitFor(b, 'cb_crack_result');
check(cr.success && cr.stolen >= 50, `Ben cracked Ana's vault using her real code, stole ${cr.stolen}`);
const hacked = await waitFor(a, 'cb_hacked'); check(hacked.by === 'Ben' && hacked.lost === cr.stolen, 'victim notified');
await new Promise((r) => setTimeout(r, 150));
const ev = host.msgs.find((m) => m.t === 'cb_event' && m.kind === 'hack'); check(!!ev && /breached/.test(ev.text), 'host intrusion log shows the hack');

// victim must pick a NEW code
send(a, { t: 'cb_setcode', code: '4242' }); check(/cracked|different|new/i.test((await waitFor(a, 'cb_code_error')).msg), 'cannot reuse the cracked code');
send(a, { t: 'cb_setcode', code: '9999' }); await waitFor(a, 'cb_code_ok'); check(true, 'Ana set a new code after the breach');

// second hack: new code is what the server uses; a wrong pick fails
send(b, { t: 'cb_next' }); qb = await waitFor(b, 'cb_q');
const hk2 = await benUntilHack();
check(hk2.crack.codes.includes('9999') && !hk2.crack.codes.includes('4242'), "second hack uses Ana's NEW code");
const wrongIdx = hk2.crack.codes.indexOf('9999') === 0 ? 1 : 0;
send(b, { t: 'cb_crack', pick: wrongIdx }); check((await waitFor(b, 'cb_crack_result')).success === false, 'wrong code fails');

// late joiner must choose a code before playing
const d = await open(); send(d, { t: 'join', pin: h.pin, name: 'Dee' }); await waitFor(d, 'joined');
await waitFor(d, 'cb_start'); await waitFor(d, 'cb_needcode');
await new Promise((r) => setTimeout(r, 150)); check(!d.msgs.some((m) => m.t === 'cb_q'), 'late joiner gets no question until a code is set');
send(d, { t: 'cb_setcode', code: '1111' }); await waitFor(d, 'cb_code_ok'); check(!!(await waitFor(d, 'cb_q')).q, 'late joiner starts playing after setting a code');

// Cy never set a code: server gave an automatic one, can still play
send(c, { t: 'cb_next' }); // no-op while a question is pending; just checking no crash
await new Promise((r) => setTimeout(r, 1800));
const bd = [...host.msgs].reverse().find((m) => m.t === 'cb_board'); check(bd.board.length === 4 && bd.board.every((p, i, arr) => !i || arr[i - 1].score >= p.score), 'live leaderboard has all players, sorted');

send(host, { t: 'finish' }); const end = await waitFor(host, 'end'); check(end.board.length === 4, 'host ended the game');

// ---------- game 2: nobody to hack -> hack packets become coins ----------
const host2 = await open(); send(host2, { t: 'host', files: ['romeo-and-juliet.txt'], mode: 'codebreaker', minutes: 1 }); const h2 = await waitFor(host2, 'hosted');
const s = await open(); send(s, { t: 'join', pin: h2.pin, name: 'Solo' }); await waitFor(s, 'joined');
send(s, { t: 'cb_setcode', code: '1234' }); await waitFor(s, 'cb_code_ok');
send(host2, { t: 'start' }); let q = await waitFor(s, 'cb_q'); let sawHack = false, fallback = false;
for (let i = 0; i < 30; i++) {
  send(s, { t: 'cb_answer', choice: right(q) }); await waitFor(s, 'cb_result');
  send(s, { t: 'cb_pick', idx: 0 }); const pr = await waitFor(s, 'cb_pick_result');
  if (pr.type === 'hack') sawHack = true; if (pr.fallback) fallback = true;
  send(s, { t: 'cb_next' }); q = await waitFor(s, 'cb_q');
}
check(!sawHack, `solo player never gets an impossible hack (fallback coins seen: ${fallback})`);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
