const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io'), { Chess } = require('chess.js'), { spawn } = require('child_process');
const app = express(); app.set('trust proxy', 1);
const path = require('path'), fs = require('fs');
const PUB = path.join(__dirname, 'public'), IDX = [path.join(PUB, 'index.html'), path.join(__dirname, 'index.html')].find(fs.existsSync);
app.use(express.static(PUB)); app.get('/health', (_, r) => r.send('ok'));
app.get('/', (_, r) => IDX ? r.sendFile(IDX) : r.status(500).send('index.html not found. Put it in a public/ folder next to server.js.'));
const srv = http.createServer(app), io = new Server(srv, { maxHttpBufferSize: 1e4 });

// ---- robot password: env only (plaintext or sha256 hex), compared in constant time
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const PW = process.env.ROBOT_UNLOCK_PASSWORD_HASH ? Buffer.from(process.env.ROBOT_UNLOCK_PASSWORD_HASH, 'hex')
  : process.env.ROBOT_UNLOCK_PASSWORD ? sha(process.env.ROBOT_UNLOCK_PASSWORD) : null;
const FAIL = new Map(); // ip -> {n, until}

// ---- Stockfish (native binary, UCI), one shared engine, serialized
let sf = null, engineOK = true, buf = '', cur = null, chain = Promise.resolve();
const tx = c => sf && sf.stdin.writable && sf.stdin.write(c + '\n');
function boot() {
  sf = spawn(process.env.STOCKFISH_PATH || 'stockfish'); buf = '';
  sf.on('error', () => { sf = null; engineOK = false; });
  sf.on('exit', () => { sf = null; });
  sf.stdin.on('error', () => {});
  sf.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); cur && cur(l); } });
  tx('uci'); tx('setoption name Threads value 2'); tx('setoption name Hash value 128');
}
boot();
function think(fen, ms) {
  const p = chain.then(() => new Promise((res, rej) => {
    if (!sf) boot();
    let depth = 0, sc = null;
    const t = setTimeout(() => { cur = null; try { sf && sf.kill(); } catch {} sf = null; rej(new Error('timeout')); }, ms + 3000);
    cur = l => {
      if (l.startsWith('info') && / score /.test(l)) { const d = l.match(/ depth (\d+)/), s = l.match(/score (cp|mate) (-?\d+)/); if (d) depth = +d[1]; if (s) sc = { t: s[1], v: +s[2] }; }
      else if (l.startsWith('bestmove')) { clearTimeout(t); cur = null; res({ move: l.split(' ')[1], depth, sc }); }
    };
    tx('ucinewgame'); tx('position fen ' + fen); tx('go movetime ' + ms);
  }));
  chain = p.catch(() => {}); return p;
}

// ---- rooms
const rooms = new Map(), TC = 600000;
const mkId = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = Array.from({ length: 5 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(s)); return s; };
const fresh = r => { r.chess = new Chess(); r.clk = { w: TC, b: TC }; r.t0 = null; r.res = null; r.draw = null; r.ev = null; r.last = null; r.rb = null; };
const live = r => !r.res && r.p.w && r.p.b;
const tick = r => { if (!r.res && r.t0 && r.chess.history().length) r.clk[r.chess.turn()] -= Date.now() - r.t0; r.t0 = Date.now(); };
const pub = p => p && { name: p.name, on: !!p.robot || !!p.sid, robot: !!p.robot };
function view(r) {
  tick(r); const c = r.chess, dests = {}, cap = { w: [], b: [] };
  if (!r.res) for (const m of c.moves({ verbose: true })) (dests[m.from] ||= []).push(m.to);
  for (const m of c.history({ verbose: true })) if (m.captured) cap[m.color].push(m.captured);
  return { id: r.id, fen: c.fen(), turn: c.turn(), dests, hist: c.history(), cap, chk: c.inCheck(), res: r.res, last: r.last,
    clk: { w: Math.max(0, r.clk.w), b: Math.max(0, r.clk.b) }, players: { w: pub(r.p.w), b: pub(r.p.b) }, draw: r.draw, ev: r.ev, rb: r.rb };
}
const emit = r => { r.act = Date.now(); io.to(r.id).emit('state', view(r)); };
function judge(r) {
  const c = r.chess;
  if (c.isCheckmate()) r.res = { win: c.turn() === 'w' ? 'b' : 'w', why: 'Checkmate' };
  else if (c.isStalemate()) r.res = { win: null, why: 'Stalemate' };
  else if (c.isThreefoldRepetition()) r.res = { win: null, why: 'Threefold repetition' };
  else if (c.isInsufficientMaterial()) r.res = { win: null, why: 'Insufficient material' };
  else if (c.isDraw()) r.res = { win: null, why: 'Fifty-move rule' };
}
function play(r, mv) { tick(r); const m = r.chess.move(mv); r.last = [m.from, m.to]; r.draw = null; judge(r); emit(r); robotTurn(r); }
async function robotTurn(r) {
  const c = r.chess.turn(), p = r.p[c];
  if (r.res || !p || !p.robot || r.busy || !r.p.w || !r.p.b) return;
  r.busy = true; r.rb = { c, think: true }; emit(r);
  const fen = r.chess.fen(); let mv = null;
  try {
    tick(r); const ms = Math.min(2000, Math.max(300, r.clk[c] / 40));
    let o;
    try { o = await think(fen, ms); }
    catch { io.to(r.id).emit('err', 'Engine timeout. Robot played a fallback move.'); const l = r.chess.moves({ verbose: true }); const m = l[Math.floor(Math.random() * l.length)]; o = { move: m.from + m.to + (m.promotion || ''), depth: 0, sc: null }; }
    if (o.sc) { const v = c === 'w' ? o.sc.v : -o.sc.v; r.ev = { d: o.depth, s: o.sc.t === 'mate' ? (v > 0 ? '+' : '-') + '#' + Math.abs(v) : (v >= 0 ? '+' : '') + (v / 100).toFixed(2) }; }
    mv = { from: o.move.slice(0, 2), to: o.move.slice(2, 4) }; if (o.move[4]) mv.promotion = o.move[4];
  } finally { r.busy = false; r.rb = null; }
  if (r.chess.fen() === fen && !r.res) { try { play(r, mv); } catch { emit(r); } }
}

io.on('connection', s => {
  const G = f => { try { f(); } catch (e) { s.emit('err', typeof e === 'string' ? e : 'Server error'); } };
  const nm = n => String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 16) || 'Player';
  const attach = (r, c, tok) => { s.join(r.id); s.data = { room: r.id, color: c, tok }; s.emit('joined', { id: r.id, color: c, tok }); emit(r); };
  const seat = () => { const r = rooms.get(s.data.room), c = s.data.color; if (!r || !c || !r.p[c] || r.p[c].tok !== s.data.tok) throw 'You are not in a game'; return { r, c }; };
  s.data = {};

  s.on('create', d => G(() => {
    const r = { id: mkId(), p: { w: null, b: null }, act: Date.now() }; fresh(r); rooms.set(r.id, r);
    const tok = crypto.randomBytes(16).toString('hex'); r.p.w = { name: nm(d && d.name), sid: s.id, tok }; attach(r, 'w', tok);
  }));
  s.on('join', d => G(() => {
    const r = rooms.get(String(d && d.room || '').toUpperCase().slice(0, 8)); if (!r) throw 'Invalid Room ID';
    const known = ['w', 'b'].find(c => r.p[c] && d.tok && r.p[c].tok === d.tok);
    if (known) { r.p[known].sid = s.id; return attach(r, known, d.tok); }
    const c = !r.p.w ? 'w' : !r.p.b ? 'b' : null; if (!c) throw 'Room full';
    const tok = crypto.randomBytes(16).toString('hex'); r.p[c] = { name: nm(d.name), sid: s.id, tok }; attach(r, c, tok); robotTurn(r);
  }));
  s.on('move', d => G(() => {
    const { r, c } = seat(); if (r.res) throw 'Game already finished'; if (!live(r)) throw 'Waiting for opponent';
    if (r.chess.turn() !== c || r.p[c].robot) throw 'Not your turn';
    if (!d || !/^[a-h][1-8]$/.test(d.from) || !/^[a-h][1-8]$/.test(d.to)) throw 'Illegal move';
    const mv = { from: d.from, to: d.to }; if (d.promotion) { if (!/^[qrbn]$/.test(d.promotion)) throw 'Illegal move'; mv.promotion = d.promotion; }
    try { play(r, mv); } catch (e) { if (e instanceof Error && /Invalid move|Illegal/i.test(e.message)) throw 'Illegal move'; throw e; }
  }));
  s.on('resign', () => G(() => { const { r, c } = seat(); if (!live(r)) throw 'Game not active'; r.res = { win: c === 'w' ? 'b' : 'w', why: 'Resignation' }; emit(r); }));
  s.on('draw', () => G(() => {
    const { r, c } = seat(); if (!live(r)) throw 'Game not active'; const o = r.p[c === 'w' ? 'b' : 'w'];
    if (r.draw && r.draw !== c) { r.res = { win: null, why: 'Draw agreed' }; return emit(r); }
    if (o.robot) throw 'Robot declined the draw'; r.draw = c; emit(r);
  }));
  s.on('nodraw', () => G(() => { const { r } = seat(); r.draw = null; emit(r); }));
  s.on('newgame', () => G(() => { const { r } = seat(); if (!r.res) throw 'Game still in progress'; fresh(r); emit(r); robotTurn(r); }));
  s.on('leave', () => G(() => {
    const { r, c } = seat(); if (live(r) && r.chess.history().length) { r.res = { win: c === 'w' ? 'b' : 'w', why: 'Opponent left' }; }
    r.p[c] = null; s.leave(r.id); s.data = {}; emit(r);
    if (!r.p.w && !r.p.b) rooms.delete(r.id);
  }));
  s.on('unlock', pw => G(() => {
    if (!PW) throw 'Robot unavailable';
    const ip = (s.handshake.headers['x-forwarded-for'] || s.handshake.address || '').split(',')[0].trim(), f = FAIL.get(ip) || { n: 0, until: 0 };
    if (Date.now() < f.until) return s.emit('rerr', 'Too many attempts. Wait a moment.');
    if (typeof pw === 'string' && pw.length < 64 && crypto.timingSafeEqual(sha(pw), PW)) { s.ok = true; FAIL.delete(ip); return s.emit('unlocked'); }
    if (++f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } FAIL.set(ip, f); s.emit('rerr', 'Invalid password');
  }));
  s.on('robot', () => G(() => {
    if (!s.ok) throw 'Robot core is locked'; const { r, c } = seat();
    if (!engineOK) throw 'Robot unavailable'; if (r.res) throw 'Game already finished'; if (r.p[c].robot) throw 'Robot already online';
    r.p[c].robot = true; r.p[c].name = 'ROBOT'; emit(r); io.to(r.id).emit('note', 'ROBOT took over ' + (c === 'w' ? 'White' : 'Black')); robotTurn(r);
  }));
  s.on('disconnect', () => { const r = rooms.get(s.data.room), c = s.data.color; if (r && c && r.p[c] && r.p[c].sid === s.id) { r.p[c].sid = null; emit(r); } });
});

setInterval(() => {
  for (const r of rooms.values()) {
    if (!r.res && r.p.w && r.p.b && r.chess.history().length) { const c = r.chess.turn(); if (r.clk[c] - (Date.now() - r.t0) <= 0) { tick(r); r.res = { win: c === 'w' ? 'b' : 'w', why: 'Timeout' }; emit(r); robotTurn(r); } }
    if (Date.now() - r.act > 3600000) rooms.delete(r.id);
  }
}, 500);
srv.listen(process.env.PORT || 3000, () => console.log('chess server up'));
