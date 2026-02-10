const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ["polling", "websocket"] });

const TURN_MS = 20000;
const START_CARDS = 7;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
let globalCardId = 1;

const cardValue = r => (r === "A" ? 1 : r === "JOKER" ? 0 : ["J", "Q", "K"].includes(r) ? 10 : parseInt(r) || 0);

const createDeck = () => {
  let deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ id: globalCardId++, suit: s, rank: r, value: cardValue(r) })));
  deck.push({ id: globalCardId++, rank: "JOKER", value: 0 }, { id: globalCardId++, rank: "JOKER", value: 0 });
  return deck.sort(() => Math.random() - 0.5);
};

const rooms = new Map();

const broadcast = room => {
  room.players.forEach(p => {
    const discardTop = room.discardPile[room.discardPile.length - 1] || null;
    io.to(p.socketId).emit("game_state", {
      roomId: room.roomId, hostId: room.hostId, youId: p.id, started: room.started, 
      roundNumber: room.roundNumber, turnId: room.turnId, discardTop,
      isGameOver: room.players.some(pl => pl.score >= 500),
      players: room.players.map(pl => ({ id: pl.id, name: pl.name, score: pl.score, lastRoundPoints: pl.lastRoundPoints, handSize: pl.hand.length, hasDrawn: pl.hasDrawn, hand: pl.id === p.id ? pl.hand : [] }))
    });
  });
};

const handleClose = (room, closer) => {
  room.closeCalled = true;
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  const totals = room.players.map(p => ({ p, t: p.hand.reduce((s, c) => s + c.value, 0) }));
  const lowest = Math.min(...totals.map(x => x.t));
  const highest = Math.max(...totals.map(x => x.t));
  totals.forEach(({ p, t }) => {
    let pts = (t === lowest) ? 0 : (p.id === closer.id ? highest * 2 : t);
    p.lastRoundPoints = pts; p.score += pts;
  });
  room.started = false;
  io.to(room.roomId).emit("close_result", { winner: closer.name });
  broadcast(room);
};

const autoPlay = (room) => {
  const p = room.players[room.currentIndex];
  if (!p || !room.started) return;
  if (!p.hasDrawn) p.hand.push(room.drawPile.pop());
  const nonJokers = p.hand.filter(c => c.rank !== "JOKER").sort((a, b) => b.value - a.value);
  if (nonJokers.length > 0) {
    const card = nonJokers[0];
    p.hand = p.hand.filter(c => c.id !== card.id);
    room.discardPile.push(card);
  }
  const idx = (room.currentIndex + 1) % room.players.length;
  room.currentIndex = idx; room.turnId = room.players[idx].id;
  p.hasDrawn = false;
  room.turnTimeout = setTimeout(() => autoPlay(room), TURN_MS);
  broadcast(room);
};

const startRound = (room) => {
  room.started = true; room.roundNumber++; room.drawPile = createDeck(); room.discardPile = [room.drawPile.pop()];
  room.players.forEach(p => { p.hand = []; for(let i=0; i<START_CARDS; i++) p.hand.push(room.drawPile.pop()); p.hasDrawn = false; });
  room.currentIndex = 0; room.turnId = room.players[0].id;
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  room.turnTimeout = setTimeout(() => autoPlay(room), TURN_MS);
  broadcast(room);
};

io.on("connection", (socket) => {
  socket.on("create_room", (data, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = { roomId, hostId: data.playerId, players: [{ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [] }], started: false, roundNumber: 0, discardPile: [] };
    rooms.set(roomId, room); socket.join(roomId); cb({ roomId }); broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    const room = rooms.get(data.roomId);
    if (!room || room.started) return cb({ error: "Room error" });
    room.players.push({ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [] });
    socket.join(data.roomId); cb({ roomId: room.roomId }); broadcast(room);
  });

  socket.on("start_round", data => { const room = rooms.get(data.roomId); if (room) startRound(room); });

  socket.on("reset_game", data => {
    const room = rooms.get(data.roomId);
    if (room && room.hostId === data.playerId) { room.players.forEach(p => p.score = 0); room.roundNumber = 0; startRound(room); }
  });

  socket.on("action_draw", data => {
    const room = rooms.get(data.roomId); const p = room?.players.find(x => x.socketId === socket.id);
    if (p && !p.hasDrawn) { p.hand.push(data.fromDiscard ? room.discardPile.pop() : room.drawPile.pop()); p.hasDrawn = true; broadcast(room); }
  });

  socket.on("action_drop", data => {
    const room = rooms.get(data.roomId); const p = room?.players.find(x => x.socketId === socket.id);
    if (p && p.id === room.turnId) {
      p.hand = p.hand.filter(c => !data.selectedIds.includes(c.id));
      const idx = (room.currentIndex + 1) % room.players.length;
      room.currentIndex = idx; room.turnId = room.players[idx].id;
      p.hasDrawn = false; if (room.turnTimeout) clearTimeout(room.turnTimeout);
      room.turnTimeout = setTimeout(() => autoPlay(room), TURN_MS); broadcast(room);
    }
  });

  socket.on("action_close", data => { const room = rooms.get(data.roomId); const p = room?.players.find(x => x.socketId === socket.id); if (p) handleClose(room, p); });
});

server.listen(process.env.PORT || 3000);
