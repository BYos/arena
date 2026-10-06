// ARENA EAT – authoritative real-time server (Node + Socket.IO)
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Match, CONFIG } = require('./shared/engine');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/health', (_, res) => res.json({ ok: true, matches: matches.size }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const matches = new Map();
let nextMatch = 1;

function findOrCreateLobby() {
  for (const m of matches.values()) if (m.canJoin()) return m;
  const id = 'm' + nextMatch++;
  const m = new Match({
    id,
    send: (to, type, data) => (to == null ? io.to(id) : io.to(to)).emit(type, data)
  });
  matches.set(id, m);
  return m;
}

io.on('connection', (socket) => {
  let match = null;
  const leave = () => {
    if (!match) return;
    match.removeHuman(socket.id);
    socket.leave(match.id);
    match = null;
  };
  socket.on('join', (d) => {
    leave();
    match = findOrCreateLobby();
    socket.join(match.id);
    match.addHuman(socket.id, d && d.name);
  });
  socket.on('input', (d) => { if (match && d) match.setInput(socket.id, Number(d.a), Number(d.t)); });
  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

const DT = 1 / CONFIG.TICK_RATE;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  // catch up if the event loop lagged, but never simulate a huge jump
  let steps = Math.min(4, Math.max(1, Math.round((now - last) / (DT * 1000))));
  last = now;
  for (const [id, m] of matches) {
    for (let i = 0; i < steps; i++) m.update(DT);
    if (m.isFinished()) matches.delete(id);
  }
}, 1000 / CONFIG.TICK_RATE);

server.listen(PORT, () => console.log(`ARENA EAT running on http://localhost:${PORT}`));
