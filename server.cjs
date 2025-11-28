// server.js

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

function cardValue(r) {
  if (r === "A") return 1;
  if (r === "JOKER") return 0;
  if (["J","Q","K"].includes(r)) return 10;
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
    discardTop,
    pendingDraw: room.pendingDraw || 0,
    pendingSkips: room.pendingSkips || 0,
    hasDrawn: player?.hasDrawn || false,
    matchingOpenCardCount: player
      ? player.hand.filter((c) => c.rank === discardTop?.rank).length
      : 0,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
    })),
    log: room.log.slice(-20),
  };
}

function broadcast(room) {
  room.players.forEach((p) =>
    io.to(p.id).emit("game_state", roomStateFor(room, p.id))
  );
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
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
  room.log.push(`Turn: ${room.players[idx].name} -> ${room.players[nextIndex].name}`);
  setTurnByIndex(room, nextIndex);
}

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

  setTurnByIndex(room, 0);

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
    room.log.push(
      `Round started! Open: ${firstCard.rank}${firstCard.suit || ""}`
    );
    if (firstCard.rank === "7") room.pendingDraw = 2;
    else if (firstCard.rank === "J") room.pendingSkips = 1;
  }

  broadcast(room);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("create_room", (data, cb) => {
    const name = (data?.name || "Player").trim().slice(0, 15) || "Player";
    let roomId;
    do roomId = randomRoomId();
    while (rooms.has(roomId));

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
    room.log.push(`${name} created room`);
    console.log(`Room created: ${roomId}`);

    cb?.({ roomId, success: true });
    broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    const roomId = (data?.roomId || "").trim().toUpperCase();
    const name = (data?.name || "Player").trim().slice(0, 15) || "Player";

    if (!roomId) return cb?.({ error: "Room ID required" });
    if (!rooms.has(roomId)) return cb?.({ error: `Room ${roomId} not found` });

    const room = rooms.get(roomId);
    if (room.players.length >= MAX_PLAYERS) return cb?.({ error: "Room full" });
    if (room.started) return cb?.({ error: "Game already started" });

    room.players.push({ id: socket.id, name, score: 0, hand: [], hasDrawn: false });
    socket.join(roomId);
    room.log.push(`${name} joined`);

    cb?.({ roomId, success: true });
    broadcast(room);
  });

  socket.on("start_round", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== socket.id) return;
    if (room.players.length < 2) return;
    startRound(room);
  });

  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled || socket.id !== room.turnId) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.hasDrawn) return;

    const count = room.pendingDraw > 0 ? room.pendingDraw : 1;
    const fromDiscard = data?.fromDiscard || false;

    for (let i = 0; i < count; i++) {
      let card;
      if (fromDiscard && room.discardPile.length > 0) card = room.discardPile.pop();
      else {
        ensureDrawPile(room);
        card = room.drawPile.pop();
      }
      if (card) player.hand.push(card);
    }
    player.hasDrawn = true;
    room.pendingDraw = 0;
    broadcast(room);
  });

  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled || socket.id !== room.turnId) return;
    const player = room.players.find((p) => p.id === socket.id);
    const ids = data?.selectedIds || [];
    const selected = player.hand.filter((c) => ids.includes(c.id));
    if (!selected.length) return;

    const ranks = [...new Set(selected.map((c) => c.rank))];
    if (ranks.length !== 1) return;

    const openCard = room.discardPile[room.discardPile.length - 1];

    // DRAW LEKUNDA DROP RULE:
    // 1) Same rank as open card -> any count (1+)
    // 2) Different rank -> must be at least 3 cards
    if (!player.hasDrawn) {
      const sameAsOpen = openCard && ranks[0] === openCard.rank;
      if (!sameAsOpen && selected.length < 3) {
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

  socket.on("action_close", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled || socket.id !== room.turnId) return;

    room.closeCalled = true;

    const closer = room.players.find((p) => p.id === socket.id);
    const closerPts = closer
      ? closer.hand.reduce((s, c) => s + c.value, 0)
      : 0;

    const roundScores = room.players.map((p) => {
      const pts = p.hand.reduce((s, c) => s + c.value, 0);
      const roundScore = p.id === socket.id || pts < closerPts ? 0 : pts * 2;
      return { player: p, roundScore };
    });

    roundScores.forEach(({ player, roundScore }) => {
      player.score = (player.score || 0) + roundScore;
    });

    room.started = false; // back to lobby
    room.log.push(`Close by ${closer?.name} (${closerPts} pts)`);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const name = room.players[idx].name;
        room.players.splice(idx, 1);
        room.log.push(`${name} left`);

        if (!room.players.length) {
          rooms.delete(roomId);
          break;
        }

        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.log.push(`New host: ${room.players[0].name}`);
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
server.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
