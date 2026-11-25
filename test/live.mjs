import WebSocket from 'ws';
const url = process.argv[2] || 'wss://quizrush-015q.onrender.com/ws';
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 30000);
const t = (msg) => new Promise((r) => { const w = new WebSocket(url); w.on('open', () => w.send(JSON.stringify(msg))); w.on('message', (d) => { r(JSON.parse(d)); w.close(); }); w.on('error', (e) => r({ err: e.message })); });
console.log('host with wrong password ->', JSON.stringify(await t({ t: 'host', file: 'english-warmup.txt', password: 'definitely-wrong' })));
console.log('join with fake PIN       ->', JSON.stringify(await t({ t: 'join', pin: '000000', name: 'x' })));
process.exit(0);
