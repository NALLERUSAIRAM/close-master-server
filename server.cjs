// ================================
// CLOSE MASTER POWER RUMMY — FULL SERVER CODE (COMPREHENSIVE VERSION)
// ================================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Close Master POWER RUMMY Server Running ✅");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// GAME CONSTANTS
const MAX_PLAYERS = 7;
const START_CARDS = 7;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

let globalCardId = 1;

function cardValue(rank) {
  if (rank === "A") return 1;
  if (rank === "JOKER") return 0;
  if (["J", "Q", "K"].includes(rank)) return 10;
  return Number.isNaN(parseInt(rank)) ? 0 : parseInt(rank);
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: globalCardId++, suit: s, rank: r, value: cardValue(r) });
    }
  }
  // Add 2 Jokers
  for (let i = 0; i < 2; i++) {
    deck.push({ id: globalCardId++, suit: null, rank: "JOKER", value: 0 });
  }
  // Shuffle deck - Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function roomStateFor(room, pid) {
  const discardTop = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null;
  return {
    roomId: room.roomId,
    youId: pid,
    hostId: room.hostId,
    started: room.started,
    closeCalled: room.closeCalled,
    currentIndex: room.currentIndex,
    discardTop,
    pendingDraw: room.pendingDraw,
    pendingSkips: room.pendingSkips,
    hasDrawn: room.players.find((p) => p.id === pid)?.hasDrawn || false,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
    })),
    log: room.log.slice(-50),
  };
}

function broadcast(room) {
  room.players.forEach((p) => {
    io.to(p.id).emit("game_state", roomStateFor(room, p.id));
  });
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

const rooms = new Map();

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

function setTurnByIndex(room, index) {
  if (!room.players.length) return;
  const safeIndex = ((index % room.players.length) + room.players.length) % room.players.length;
  room.currentIndex = safeIndex;
  room.turnId = room.players[safeIndex].id;
  room.players.forEach((p) => (p.hasDrawn = false));
}

function advanceTurn(room) {
  if (!room.players.length) return;
  let idx = room.players.findIndex((p) => p.id === room.turnId);
  if (idx === -1) idx = 0;

  let steps = 1;
  if (room.pendingSkips > 0) {
    if (room.players.length === 2) {
      steps = 1;
    } else {
      steps += room.pendingSkips;
    }
    room.pendingSkips = 0;
  }

  let nextIndex = (idx + steps) % room.players.length;
  room.log.push(`Turn: ${room.players[idx].name} → ${room.players[nextIndex].name}`);
  setTurnByIndex(room, nextIndex);
}

function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;

  room.players.forEach((p) => {
    p.hand = [];
    p.hasDrawn = false;
  });

  setTurnByIndex(room, 0);

  // Deal cards
  for (let i = 0; i < START_CARDS; i++) {
    room.players.forEach((p) => {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if (card) p.hand.push(card);
    });
  }
  ensureDrawPile(room);
  const firstCard = room.drawPile.pop();
  if (firstCard) room.discardPile.push(firstCard);

  room.log.push(`Round started! Open card: ${firstCard?.rank}`);

  // Handle first card special rules
  if (firstCard?.rank === "7") {
    room.pendingDraw = 2;
    room.log.push("Open card 7 → next player draws 2");
  }
  if (firstCard?.rank === "J") {
    room.pendingSkips = 1;
    room.log.push("Open card J → next player skip");
  }
}

io.on("connection", (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Create room
  socket.on("create_room", (data, cb) => {
    const name = (data?.name || "Player").trim().substring(0, 15) || "Player";
    let roomId;
    do {
      roomId = randomRoomId();
    } while (rooms.has(roomId));

    const room = {
      roomId,
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0, hand: [], hasDrawn: false }],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      turnId: socket.id,
      pendingDraw: 0,
      pendingSkips: 0,
      closeCalled: false,
      log: [],
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    room.log.push(`${name} created room ${roomId}`);
    console.log(`Room created: ${roomId} by ${name}`);

    cb({ roomId, success: true });
    broadcast(room);
  });

  // Join room
  socket.on("join_room", (data, cb) => {
    const roomId = (data?.roomId || "").trim().toUpperCase();
    const name = (data?.name || "Player").trim().substring(0, 15) || "Player";

    if (!roomId) return cb({ error: "Room ID missing" });
    if (!rooms.has(roomId)) return cb({ error: `Room ${roomId} not found` });

    const room = rooms.get(roomId);

    if (room.players.length >= MAX_PLAYERS) return cb({ error: "Room full" });
    if (room.started) return cb({ error: "Game already started" });

    room.players.push({ id: socket.id, name, score: 0, hand: [], hasDrawn: false });
    socket.join(roomId);
    room.log.push(`${name} joined (${room.players.length}/${MAX_PLAYERS})`);
    console.log(`${name} joined room ${roomId}`);

    cb({ roomId, success: true });
    broadcast(room);
  });

  // Start round
  socket.on("start_round", () => {
    const room = Array.from(rooms.values()).find((r) => r.hostId === socket.id);
    if (!room || room.started) return;
    if (room.players.length < 2) return;
    room.started = true;
    startRound(room);
    broadcast(room);
  });

  // Draw card
  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.hasDrawn) {
      socket.emit("error", { message: "Already drawn this turn!" });
      return;
    }

    let drawCount = room.pendingDraw > 0 ? room.pendingDraw : 1;
    for (let i = 0; i < drawCount; i++) {
      let card = null;
      if (data?.fromDiscard && room.discardPile.length > 0) {
        card = room.discardPile.pop();
      } else {
        ensureDrawPile(room);
        card = room.drawPile.pop();
      }
      if (card) player.hand.push(card);
    }

    player.hasDrawn = true;
    room.pendingDraw = 0;
    room.log.push(`${player.name} drew ${drawCount} card(s)`);
    broadcast(room);
  });

  // Drop cards
  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.hasDrawn) {
      socket.emit("error", { message: "Must draw first before dropping!" });
      return;
    }

    const ids = data?.selectedIds || [];
    const selected = player.hand.filter((c) => ids.includes(c.id));

    if (selected.length === 0) return;

    // Check all cards same rank
    const uniqueRanks = [...new Set(selected.map((c) => c.rank))];
    if (uniqueRanks.length !== 1) {
      socket.emit("error", { message: "Select cards of the same rank only" });
      return;
    }

    player.hand = player.hand.filter((c) => !ids.includes(c.id));
    selected.forEach((c) => room.discardPile.push(c));

    if (uniqueRanks[0] === "J") {
      room.pendingSkips += selected.length;
      room.log.push(`${player.name} dropped ${selected.length} Jacks - skip`);
    } else if (uniqueRanks[0] === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(`${player.name} dropped ${selected.length} Sevens - draw`);
    } else {
      room.log.push(`${player.name} dropped ${selected.length} cards`);
    }

    player.hasDrawn = false;
    advanceTurn(room);
    broadcast(room);
  });

  // Call close
  socket.on("action_close", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;

    room.closeCalled = true;

    // Calculate points
    room.players.forEach((p) => {
      const points = p.hand.reduce((sum, c) => sum + c.value, 0);
      p.score += points;
    });

    room.log.push(`${room.players.find(p => p.id === socket.id)?.name} called CLOSE`);

    broadcast(room);
  });

  // Disconnect handler
  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);

    for (const [roomId, room] of rooms.entries()) {
      if (room.players.some((p) => p.id === socket.id)) {
        room.players = room.players.filter((p) => p.id !== socket.id);
        room.log.push(`Player left`);

        if (room.players.length === 0) {
          rooms.delete(roomId);
          break;
        }

        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.log.push(`Host left; new host assigned`);
        }

        if (!room.players.some((p) => p.id === room.turnId)) {
          setTurnByIndex(room, 0);
        }

        broadcast(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Close Master POWER RUMMY Server started on port ${PORT}`);
});
