const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["polling", "websocket"],
});

const MAX_PLAYERS = 7;
const START_CARDS = 7;
const TURN_MS = 20000; // 20 Seconds Timer
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
let globalCardId = 1;

function cardValue(r) {
  if (r === "A") return 1;
  if (r === "JOKER") return 0;
  if (["J", "Q", "K"].includes(r)) return 10;
  return parseInt(r) || 0;
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: globalCardId++, suit: s, rank: r, value: cardValue(r) });
    }
  }
  for (let i = 0; i < 2; i++) {
    deck.push({ id: globalCardId++, suit: null, rank: "JOKER", value: 0 });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const rooms = new Map();

function roomStateFor(room, pid) {
  const discardTop = room.discardPile[room.discardPile.length - 1] || null;
  const player = room.players.find((p) => p.id === pid);
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    youId: pid,
    started: room.started,
    closeCalled: room.closeCalled,
    currentIndex: room.currentIndex,
    turnId: room.turnId,
    roundNumber: room.roundNumber || 0,
    discardTop,
    pendingDraw: room.pendingDraw || 0,
    pendingSkips: room.pendingSkips || 0,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      lastRoundPoints: p.lastRoundPoints || 0,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
      online: p.isConnected !== false,
    })),
  };
}

function broadcast(room) {
  room.players.forEach((p) => {
    if (p.socketId) {
      io.to(p.socketId).emit("game_state", roomStateFor(room, p.id));
    }
  });
}

function ensureDrawPile(room) {
  if (room.drawPile.length > 0) return;
  if (room.discardPile.length <= 1) return;
  const top = room.discardPile.pop();
  let pile = room.discardPile;
  room.discardPile = [top];
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  room.drawPile = pile;
}

// 🔥 AUTO-PLAY LOGIC WHEN TIMER HITS 0
function autoPlayTurn(room) {
  const player = room.players[room.currentIndex];
  if (!player || !room.started || room.closeCalled) return;

  // 1. Auto Draw if not done
  if (!player.hasDrawn) {
    const count = room.pendingDraw > 0 ? room.pendingDraw : 1;
    for (let i = 0; i < count; i++) {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if (card) player.hand.push(card);
    }
    player.hasDrawn = true;
    room.pendingDraw = 0;
  }

  // 2. Auto Drop - Find highest value card (to reduce points)
  if (player.hand.length > 0) {
    let highestValIdx = 0;
    for (let i = 1; i < player.hand.length; i++) {
      if (player.hand[i].value > player.hand[highestValIdx].value) {
        highestValIdx = i;
      }
    }
    const card = player.hand.splice(highestValIdx, 1)[0];
    room.discardPile.push(card);

    // Apply card effects
    if (card.rank === "J") room.pendingSkips += 1;
    if (card.rank === "7") room.pendingDraw += 2;
  }

  player.hasDrawn = false;
  advanceTurn(room);
  broadcast(room);
}

function scheduleTurnTimeout(room) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  room.turnTimeout = setTimeout(() => {
    autoPlayTurn(room);
  }, TURN_MS);
}

function setTurnByIndex(room, index) {
  room.currentIndex = index % room.players.length;
  room.turnId = room.players[room.currentIndex].id;
  room.players.forEach((p) => (p.hasDrawn = false));
  scheduleTurnTimeout(room);
}

function advanceTurn(room) {
  let steps = 1 + (room.pendingSkips || 0);
  room.pendingSkips = 0;
  const nextIdx = (room.currentIndex + steps) % room.players.length;
  setTurnByIndex(room, nextIdx);
}

function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;
  room.started = true;
  room.roundNumber += 1;

  room.players.forEach((p) => {
    p.hand = [];
    p.hasDrawn = false;
    p.lastRoundPoints = 0;
  });

  const rand = Math.floor(Math.random() * room.players.length);
  setTurnByIndex(room, rand);

  for (let i = 0; i < START_CARDS; i++) {
    room.players.forEach((p) => {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if (card) p.hand.push(card);
    });
  }

  ensureDrawPile(room);
  const first = room.drawPile.pop();
  if (first) {
    room.discardPile.push(first);
    if (first.rank === "7") room.pendingDraw = 2;
    if (first.rank === "J") {
      room.pendingSkips = 1;
      advanceTurn(room);
    }
  }
  broadcast(room);
}

io.on("connection", (socket) => {
  socket.on("create_room", (data, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      roomId,
      hostId: data.playerId,
      players: [{
        id: data.playerId,
        socketId: socket.id,
        name: data.name,
        score: 0,
        hand: [],
        hasDrawn: false,
        isConnected: true,
      }],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      turnId: data.playerId,
      roundNumber: 0,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    cb?.({ roomId, success: true });
    broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    const room = rooms.get(data.roomId);
    if (!room || room.started) return cb?.({ error: "Cannot join" });
    room.players.push({
      id: data.playerId,
      socketId: socket.id,
      name: data.name,
      score: 0,
      hand: [],
      hasDrawn: false,
      isConnected: true,
    });
    socket.join(data.roomId);
    cb?.({ roomId: room.roomId, success: true });
    broadcast(room);
  });

  socket.on("action_draw", (data) => {
    const room = rooms.get(data.roomId);
    const player = room?.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.turnId || player.hasDrawn) return;

    const count = room.pendingDraw > 0 ? room.pendingDraw : 1;
    for (let i = 0; i < count; i++) {
      let card = data.fromDiscard ? room.discardPile.pop() : (ensureDrawPile(room), room.drawPile.pop());
      if (card) player.hand.push(card);
    }
    player.hasDrawn = true;
    room.pendingDraw = 0;
    broadcast(room);
  });

  socket.on("action_drop", (data) => {
    const room = rooms.get(data.roomId);
    const player = room?.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.turnId) return;

    const ids = data.selectedIds || [];
    const selected = player.hand.filter(c => ids.includes(c.id));
    if (!selected.length) return;

    player.hand = player.hand.filter(c => !ids.includes(c.id));
    selected.forEach(c => room.discardPile.push(c));

    const rank = selected[0].rank;
    if (rank === "J") room.pendingSkips += selected.length;
    if (rank === "7") room.pendingDraw += (2 * selected.length);

    player.hasDrawn = false;
    advanceTurn(room);
    broadcast(room);
  });

  socket.on("action_close", (data) => {
    const room = rooms.get(data.roomId);
    const closer = room?.players.find(p => p.socketId === socket.id);
    if (!closer || closer.id !== room.turnId) return;

    room.closeCalled = true;
    if (room.turnTimeout) clearTimeout(room.turnTimeout);

    const totals = room.players.map(p => ({
      p, total: p.hand.reduce((s, c) => s + c.value, 0)
    }));

    const lowest = Math.min(...totals.map(t => t.total));
    const highest = Math.max(...totals.map(t => t.total));

    totals.forEach(({ p, total }) => {
      let rPoints = (total === lowest) ? 0 : (p.id === closer.id ? highest * 2 : total);
      p.lastRoundPoints = rPoints;
      p.score += rPoints;
    });

    const isGameOver = room.players.some(p => p.score >= 500);
    if (isGameOver) {
      room.players.forEach(p => p.score = 0);
      room.roundNumber = 0;
    }

    room.started = false;
    io.to(room.roomId).emit("close_result", { 
      winner: closer.name, 
      roundScores: room.players.map(p => ({ name: p.name, points: p.lastRoundPoints }))
    });
    broadcast(room);
  });

  socket.on("start_round", (data) => {
    const room = rooms.get(data.roomId);
    if (room && room.hostId) startRound(room);
  });

  socket.on("disconnect", () => {
    // Basic disconnect handling
  });
});

server.listen(process.env.PORT || 3000);
