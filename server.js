// ARENA EAT – authoritative real-time server (Node + Socket.IO)
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Match, CONFIG } = require('./shared/engine');

const PORT = process.env.PORT || 3000;
const MAX_ROOMS = 60;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/health', (_, res) => res.json({ ok: true, matches: matches.size }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const matches = new Map();
let nextMatch = 1;

function createRoom(settings) {
  const id = 'm' + nextMatch++;
  const m = new Match({
    id, settings,
    send: (to, type, data) => (to == null ? io.to(id) : io.to(to)).emit(type, data)
  });
  matches.set(id, m);
  return m;
}
function openRooms() { return [...matches.values()].filter((m) => m.canJoin() && m.humanCount() > 0); }

// Quick play: busiest open lobby first, otherwise a new room with the player's own settings
function quickRoom(settings) {
  const open = openRooms().sort((a, b) => b.humanCount() - a.humanCount());
  return open[0] || createRoom(settings);
}

io.on('connection', (socket) => {
  let match = null;
  socket.join('menu');
  const leave = () => {
    if (match) { match.removeHuman(socket.id); socket.leave(match.id); match = null; }
    socket.join('menu');
  };
  socket.on('join', (d) => {
    d = d || {};
    leave();
    let m = null;
    if (d.room) {
      m = matches.get(String(d.room));
      if (!m || !m.canJoin()) { socket.emit('joinError', { msg: 'That game already started or is full.' }); return; }
    } else if (d.create) {
      if (matches.size >= MAX_ROOMS) { socket.emit('joinError', { msg: 'The server is busy. Try Quick play.' }); return; }
      m = createRoom(d.settings);
    } else m = quickRoom(d.settings);
    match = m;
    socket.leave('menu');
    socket.join(m.id);
    m.addHuman(socket.id, d.name, d.char);
    pushRooms(true);
  });
  socket.on('startNow', () => { if (match) match.startNow(socket.id); });
  socket.on('input', (d) => { if (match && d) match.setInput(socket.id, Number(d.a), Number(d.t)); });
  socket.on('leave', () => { leave(); pushRooms(true); });
  socket.on('disconnect', () => { if (match) { match.removeHuman(socket.id); match = null; } });
  socket.emit('rooms', openRooms().map((m) => m.summary()));
});

// Open lobbies are pushed to everyone sitting on the main menu
let lastRooms = '';
function pushRooms(force) {
  const json = JSON.stringify(openRooms().map((m) => m.summary()));
  if (!force && json === lastRooms) return;
  lastRooms = json;
  io.to('menu').emit('rooms', JSON.parse(json));
}
setInterval(() => pushRooms(false), 1000);

const DT = 1 / CONFIG.TICK_RATE;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  // catch up if the event loop lagged, but never simulate a huge jump
  const steps = Math.min(4, Math.max(1, Math.round((now - last) / (DT * 1000))));
  last = now;
  for (const [id, m] of matches) {
    for (let i = 0; i < steps; i++) m.update(DT);
    if (m.isFinished()) matches.delete(id);
  }
}, 1000 / CONFIG.TICK_RATE);

server.listen(PORT, () => console.log(`ARENA EAT running on http://localhost:${PORT}`));
