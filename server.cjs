const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ["polling", "websocket"] });

const TURN_MS = 20000;
const START_CARDS = 7;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

const cardValue = r => (r === "A" ? 1 : r === "JOKER" ? 0 : ["J", "Q", "K"].includes(r) ? 10 : parseInt(r) || 0);

const createDeck = () => {
  let deck = [];
  let id = 1;
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ id: id++, suit: s, rank: r, value: cardValue(r) })));
  deck.push({ id: id++, rank: "JOKER", suit: "🃏", value: 0 }, { id: id++, rank: "JOKER", suit: "🃏", value: 0 });
  return deck.sort(() => Math.random() - 0.5);
};

const rooms = new Map();

const broadcast = (room) => {
  room.players.forEach(p => {
    io.to(p.socketId).emit("game_state", {
      roomId: room.roomId, hostId: room.hostId, youId: p.id, started: room.started,
      roundNumber: room.roundNumber, turnId: room.turnId, penaltyCount: room.penaltyCount,
      discardTop: room.discardPile[room.discardPile.length - 1] || null,
      roundHistory: room.roundHistory || [],
      players: room.players.map(pl => ({
        id: pl.id, name: pl.name, score: pl.score, handSize: pl.hand.length,
        hasDrawn: pl.hasDrawn, lastRoundPoints: pl.lastRoundPoints || 0, hand: pl.id === p.id ? pl.hand : []
      }))
    });
  });
};

const handleClose = (room, closer) => {
  const totals = room.players.map(p => ({ id: p.id, t: p.hand.reduce((s, c) => s + c.value, 0) }));
  const lowest = Math.min(...totals.map(x => x.t));
  const highest = Math.max(...totals.map(x => x.t));

  const roundPointsMap = {};
  room.players.forEach(p => {
    const playerTotal = p.hand.reduce((s, c) => s + c.value, 0);
    let pts = (playerTotal === lowest) ? 0 : (p.id === closer.id ? highest * 2 : playerTotal);
    p.lastRoundPoints = pts;
    p.score += pts;
    roundPointsMap[p.name] = pts;
  });

  room.roundHistory.push({ round: room.roundNumber, points: roundPointsMap });
  room.started = false;
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  io.to(room.roomId).emit("close_result", { winner: closer.name });
  broadcast(room);
};

const startRound = (room) => {
  room.started = true; room.roundNumber++; room.penaltyCount = 0;
  room.drawPile = createDeck(); room.discardPile = [room.drawPile.pop()];
  room.players.forEach(p => {
    p.hand = []; for (let i = 0; i < START_CARDS; i++) p.hand.push(room.drawPile.pop());
    p.hasDrawn = false; p.lastRoundPoints = 0;
  });
  room.currentIndex = 0; room.turnId = room.players[0].id;
  broadcast(room);
};

io.on("connection", (socket) => {
  socket.on("create_room", (data, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = { roomId, hostId: data.playerId, players: [{ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [] }], started: false, roundNumber: 0, discardPile: [], roundHistory: [], penaltyCount: 0 };
    rooms.set(roomId, room); socket.join(roomId); cb({ roomId }); broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    const room = rooms.get(data.roomId);
    if (!room || room.started) return cb({ error: "Error" });
    room.players.push({ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [] });
    socket.join(data.roomId); cb({ roomId: room.roomId }); broadcast(room);
  });

  socket.on("start_round", d => { const r = rooms.get(d.roomId); if (r) startRound(r); });

  socket.on("action_draw", data => {
    const room = rooms.get(data.roomId); const p = room?.players.find(x => x.socketId === socket.id);
    if (p && !p.hasDrawn && room.turnId === p.id) {
      if (data.fromDiscard) {
        const top = room.discardPile[room.discardPile.length - 1];
        if (top.rank === "J" || top.rank === "7") return;
        p.hand.push(room.discardPile.pop());
      } else {
        const take = room.penaltyCount > 0 ? room.penaltyCount : 1;
        for (let i = 0; i < take; i++) if (room.drawPile.length) p.hand.push(room.drawPile.pop());
        room.penaltyCount = 0;
      }
      p.hasDrawn = true; broadcast(room);
    }
  });

  socket.on("action_drop", data => {
    const room = rooms.get(data.roomId); const p = room?.players.find(x => x.socketId === socket.id);
    if (p && p.id === room.turnId) {
      const dropped = p.hand.filter(c => data.selectedIds.includes(c.id));
      const is3Same = dropped.length >= 3 && dropped.every(c => c.rank === dropped[0].rank);
      const isMatch = dropped.some(c => c.rank === room.discardPile[room.discardPile.length - 1]?.rank);
      if (!p.hasDrawn && !is3Same && !isMatch) return;

      room.discardPile.push(...dropped);
      p.hand = p.hand.filter(c => !data.selectedIds.includes(c.id));
      let skips = 1;
      dropped.forEach(c => { if (c.rank === "J") skips++; if (c.rank === "7") room.penaltyCount += 2; });
      room.currentIndex = (room.currentIndex + skips) % room.players.length;
      room.turnId = room.players[room.currentIndex].id;
      p.hasDrawn = false; broadcast(room);
    }
  });

  socket.on("action_close", d => { const r = rooms.get(d.roomId); const p = r?.players.find(x => x.socketId === socket.id); if (p) handleClose(r, p); });
});

server.listen(process.env.PORT || 3000);
