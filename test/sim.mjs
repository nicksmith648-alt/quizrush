import WebSocket from 'ws';
setTimeout(() => { console.log('TIMEOUT - test hung'); process.exit(2); }, 25000);const URL = 'ws://localhost:3055/ws';
const open = (name) => new Promise((res) => { const w = new WebSocket(URL); w.msgs = []; w.waiters = [];
  w.on('message', (d) => { const m = JSON.parse(d); w.msgs.push(m); if (process.env.DBG) console.log('  <-', w.tag || '?', JSON.stringify(m).slice(0,90)); w.waiters = w.waiters.filter(f => f(m)); });
  w.on('open', () => res(w)); });
const waitFor = (w, t) => new Promise((res) => { const hit = w.msgs.find(m => m.t === t && !m._seen); if (hit) { hit._seen = 1; return res(hit); }
  w.waiters.push((m) => { if (m.t === t && !m._seen) { m._seen = 1; res(m); return false; } return true; }); });
const send = (w, o) => w.send(JSON.stringify(o));
let fails = 0; const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };

const host = await open(); send(host, { t: 'host', file: 'english-warmup.txt' });
const h = await waitFor(host, 'hosted'); check(/^\d{6}$/.test(h.pin) && h.count === 5, `hosted pin=${h.pin} count=${h.count}`);
const [a, b, c] = await Promise.all([open(), open(), open()]);
send(a, { t: 'join', pin: h.pin, name: 'Ana' }); send(b, { t: 'join', pin: h.pin, name: 'Ben' }); send(c, { t: 'join', pin: h.pin, name: 'ana' });
await waitFor(a, 'joined'); await waitFor(b, 'joined');
const dup = await waitFor(c, 'error'); check(/taken/.test(dup.msg), 'duplicate nickname rejected');
const bad = await open(); send(bad, { t: 'join', pin: '000000', name: 'X' }); check(/not found/i.test((await waitFor(bad, 'error')).msg), 'bad PIN rejected');
send(a, { t: 'start' }); await new Promise(r => setTimeout(r, 100)); check(!host.msgs.some(m => m.t === 'question'), 'players cannot start game');
send(host, { t: 'start' });
const correct = [0, 1, 2, 1, 3];
for (let i = 0; i < 5; i++) {
  const q = await waitFor(host, 'question'); await waitFor(a, 'question'); await waitFor(b, 'question');
  check(q.index === i, `question ${i + 1} sent`);
  send(a, { t: 'answer', choice: correct[i] });                 // Ana always right
  await new Promise(r => setTimeout(r, 200));
  send(b, { t: 'answer', choice: i === 2 ? correct[i] : (correct[i] + 1) % 4 }); // Ben right only on Q3
  send(b, { t: 'answer', choice: correct[i] });                 // double answer must be ignored
  const r = await waitFor(host, 'reveal'); check(r.correct === correct[i], `Q${i + 1} reveal correct=${r.correct}`);
  const ra = await waitFor(a, 'result'); const rb = await waitFor(b, 'result');
  check(ra.right && ra.points > 500 && ra.points <= 1000 + 500, `Ana points=${ra.points} streak=${ra.streak}`);
  check(rb.right === (i === 2), `Ben right=${rb.right}`);
  if (i < 4) send(host, { t: 'next' }); else check(r.last, 'last flag');
}
send(host, { t: 'next' });
const end = await waitFor(host, 'end'); check(end.board[0].name === 'Ana', `winner ${end.board[0].name} ${end.board[0].score}`);
const ea = await waitFor(a, 'end'); check(ea.rank === 1 && ea.of === 2, 'Ana rank 1 of 2');
// timeout path + skip
const host2 = await open(); send(host2, { t: 'host', text: '# T\n\nQ?\ntime: 5\n*yes\nno' }); const h2 = await waitFor(host2, 'hosted');
const p = await open(); send(p, { t: 'join', pin: h2.pin, name: 'Zed' }); await waitFor(p, 'joined');
send(host2, { t: 'start' }); await waitFor(host2, 'question'); send(host2, { t: 'skip' });
const rr = await waitFor(p, 'result'); check(rr.answered === false && rr.points === 0, 'unanswered question scores 0 on skip');
// invalid quiz
const host3 = await open(); send(host3, { t: 'host', text: 'Q?\nonly one\nanswer' }); check(/correct answer/.test((await waitFor(host3, 'error')).msg), 'invalid quiz rejected');
// host leaves -> players told
const closed = waitFor(p, 'closed'); host2.close(); check(/host left/.test((await closed).reason), 'players notified when host leaves');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
