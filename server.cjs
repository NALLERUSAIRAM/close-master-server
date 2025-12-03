// CLOSE MASTER - FINAL SERVER (with Rule Fixes)
// =============================================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MAX_PLAYERS = 7;
const START_CARDS = 7;
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];
let globalCardId = 1;

// ----------------------
// CARD VALUE
// ----------------------
function cardValue(r) {
  if (r === "A") return 1;
  if (r === "JOKER") return 0;
  if (["J","Q","K"].includes(r)) return 10;
  return parseInt(r) || 0;
}

// ----------------------
// DECK
// ----------------------
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

// ----------------------
// CLIENT STATE FORMAT
// ----------------------
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
    discardTop,
    pendingDraw: room.pendingDraw || 0,
    pendingSkips: room.pendingSkips || 0,
    hasDrawn: player?.hasDrawn || false,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
      online: p.isConnected !== false,
    })),
  };
}

// ----------------------
// BROADCAST
// ----------------------
function broadcast(room) {
  room.players.forEach((p) => {
    if (p.socketId) {
      io.to(p.socketId).emit("game_state", roomStateFor(room, p.id));
    }
  });
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
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

function setTurnByIndex(room, index) {
  if (!room.players.length) return;
  room.currentIndex =
    ((index % room.players.length) + room.players.length) % room.players.length;
  room.turnId = room.players[room.currentIndex].id;
  room.players.forEach((p) => (p.hasDrawn = false));
}

function advanceTurn(room) {
  if (!room.players.length) return;
  let idx = room.players.findIndex((p) => p.id === room.turnId);
  if (idx === -1) idx = 0;

  let steps = 1;
  if (room.pendingSkips > 0) {
    steps += room.pendingSkips;
    room.pendingSkips = 0;
  }
  const nextIndex = (idx + steps) % room.players.length;
  setTurnByIndex(room, nextIndex);
}

// ----------------------
// START ROUND
// ----------------------
function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;
  room.started = true;

  room.players.forEach((p) => {
    p.hand = [];
    p.hasDrawn = false;
  });

  // RULE 1: RANDOM FIRST TURN
  const rand = Math.floor(Math.random() * room.players.length);
  setTurnByIndex(room, rand);

  // deal
  for (let i = 0; i < START_CARDS; i++) {
    room.players.forEach((p) => {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if (card) p.hand.push(card);
    });
  }

  ensureDrawPile(room);
  const firstCard = room.drawPile.pop();
  if (firstCard) {
    room.discardPile.push(firstCard);

    if (firstCard.rank === "7") {
      room.pendingDraw = 2;
    } else if (firstCard.rank === "J") {
      room.pendingSkips = 1;
      // RULE 2: APPLY SKIP IMMEDIATELY
      advanceTurn(room);
    }
  }

  broadcast(room);
}

// =============================================
// SOCKET HANDLERS
// =============================================
io.on("connection", (socket) => {
  // CREATE ROOM
  socket.on("create_room", (data, cb) => {
    const name = (data?.name || "Player").trim().slice(0, 15) || "Player";
    const playerId = (data?.playerId || socket.id).toString();

    let roomId;
    do roomId = randomRoomId();
    while (rooms.has(roomId));

    const room = {
      roomId,
      hostId: playerId,
      players: [{
        id: playerId,
        socketId: socket.id,
        name,
        score: 0,
        hand: [],
        hasDrawn: false,
        isConnected: true,
        disconnectTimeout: null,
      }],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      turnId: playerId,
      pendingDraw: 0,
      pendingSkips: 0,
      closeCalled: false,
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.playerId = playerId;
    socket.roomId = roomId;

    cb?.({ roomId, success: true });
    broadcast(room);
  });

  // JOIN ROOM
  socket.on("join_room", (data, cb) => {
    const roomId = (data?.roomId || "").trim().toUpperCase();
    const name = (data?.name || "Player").trim().slice(0, 15) || "Player";
    const playerId = (data?.playerId || socket.id).toString();

    if (!rooms.has(roomId)) return cb?.({ error: "Room not found" });
    const room = rooms.get(roomId);

    if (room.players.length >= MAX_PLAYERS) return cb?.({ error: "Room full" });
    if (room.started) return cb?.({ error: "Game already started" });

    let existing = room.players.find((p) => p.id === playerId);
    if (!existing) {
      room.players.push({
        id: playerId,
        socketId: socket.id,
        name,
        score: 0,
        hand: [],
        hasDrawn: false,
        isConnected: true,
        disconnectTimeout: null,
      });
    } else {
      existing.socketId = socket.id;
      existing.isConnected = true;
    }

    socket.join(roomId);
    socket.playerId = playerId;
    socket.roomId = roomId;

    cb?.({ roomId, success: true });
    broadcast(room);
  });

  // REJOIN
  socket.on("rejoin_room", ({ roomId, name, playerId }) => {
    if (!rooms.has(roomId)) {
      socket.emit("rejoin_error", { message: "Room not found" });
      return;
    }
    const room = rooms.get(roomId);

    let player = room.players.find((p) => p.id === playerId);
    if (!player) {
      player = room.players.find((p) => p.name === name);
    }
    if (!player) {
      socket.emit("rejoin_error", { message: "Player not found" });
      return;
    }

    player.socketId = socket.id;
    player.isConnected = true;

    socket.join(roomId);
    socket.playerId = player.id;
    socket.roomId = roomId;

    socket.emit("rejoin_success", roomStateFor(room, player.id));
    broadcast(room);
  });

  // START ROUND
  socket.on("start_round", (data) => {
    const room = rooms.get(data?.roomId);
    if (!room) return;
    const me = room.players.find((p) => p.socketId === socket.id);
    if (!me || me.id !== room.hostId) return;
    if (room.players.length < 2) return;
    startRound(room);
  });

  // DRAW
  socket.on("action_draw", (data) => {
    const room = rooms.get(data?.roomId);
    if (!room || !room.started || room.closeCalled) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player || player.id !== room.turnId || player.hasDrawn) return;

    const fromDiscard = data?.fromDiscard || false;
    const count = room.pendingDraw > 0 ? room.pendingDraw : 1;

    for (let i = 0; i < count; i++) {
      let card;
      if (fromDiscard && room.discardPile.length > 0) {
        card = room.discardPile.pop();
      } else {
        ensureDrawPile(room);
        card = room.drawPile.pop();
      }
      if (card) player.hand.push(card);
    }

    player.hasDrawn = true;
    room.pendingDraw = 0;

    broadcast(room);
  });

  // DROP
  socket.on("action_drop", (data) => {
    const room = rooms.get(data?.roomId);
    if (!room || !room.started || room.closeCalled) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player || player.id !== room.turnId) return;

    const ids = data?.selectedIds || [];
    const selected = player.hand.filter((c) => ids.includes(c.id));
    if (!selected.length) return;

    const ranks = [...new Set(selected.map((c) => c.rank))];
    if (ranks.length !== 1) return;

    const openCard = room.discardPile[room.discardPile.length - 1];

    // RULE 3: If pendingDraw exists (open-card=7), drop allowed ONLY if rank=7
    if (room.pendingDraw > 0) {
      if (ranks[0] !== "7") {
        return; // MUST DRAW
      }
    }

    // normal rule: if not drawn yet:
    if (!player.hasDrawn) {
      const sameAsOpen = openCard && ranks[0] === openCard.rank;
      if (!sameAsOpen && selected.length < 3 && ranks[0] !== "7") {
        return;
      }
    }

    player.hand = player.hand.filter((c) => !ids.includes(c.id));
    selected.forEach((c) => room.discardPile.push(c));

    if (ranks[0] === "J") room.pendingSkips += selected.length;
    else if (ranks[0] === "7") room.pendingDraw += 2 * selected.length;

    player.hasDrawn = false;
    advanceTurn(room);
    broadcast(room);
  });

  // CLOSE
  socket.on("action_close", (data) => {
    const room = rooms.get(data?.roomId);
    if (!room || !room.started || room.closeCalled) return;

    const closer = room.players.find((p) => p.socketId === socket.id);
    if (!closer || closer.id !== room.turnId) return;

    room.closeCalled = true;

    const totals = room.players.map((p) => ({
      player: p,
      total: p.hand.reduce((s, c) => s + c.value, 0),
    }));

    const lowest = Math.min(...totals.map((t) => t.total));
    const highest = Math.max(...totals.map((t) => t.total));

    totals.forEach(({ player, total }) => {
      let score = 0;
      if (total === lowest) score = 0;
      else if (player.id === closer.id) score = highest * 2;
      else score = total;
      player.score = (player.score || 0) + score;
    });

    room.started = false;
    broadcast(room);
  });

  // DISCONNECT
  socket.on("disconnect", () => {});
});

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
