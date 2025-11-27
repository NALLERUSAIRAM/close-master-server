// ==========================
// CLOSE MASTER POWER RUMMY — COMPLETE FIXED SERVER (DRAW → DROP → NEXT)
// ==========================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Close Master POWER RUMMY Server ✅ - DRAW DROP FIXED");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ==========================
// GAME CONSTANTS
// ==========================

const MAX_PLAYERS = 7;
const START_CARDS = 7;

const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];

let globalCardId = 1;

function cardValue(rank) {
  if (rank === "A") return 1;
  if (rank === "JOKER") return 0;
  if (["J","Q","K"].includes(rank)) return 10;
  const n = parseInt(rank, 10);
  return Number.isNaN(n) ? 0 : n;
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({
        id: globalCardId++,
        suit: s,
        rank: r,
        value: cardValue(r),
      });
    }
  }
  for (let i = 0; i < 2; i++) {
    deck.push({
      id: globalCardId++,
      suit: null,
      rank: "JOKER",
      value: 0,
    });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j] = [deck[j], deck[i]];
  }
  return deck;
}

function roomStateFor(room, pid) {
  const discardTop = room.discardPile[room.discardPile.length - 1] || null;
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
    hasDrawn: room.players.find(p => p.id === pid)?.hasDrawn || false,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
    })),
    log: room.log.slice(-80),
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
  if (room.players.length === 0) return;
  const safeIndex = ((index % room.players.length) + room.players.length) % room.players.length;
  room.currentIndex = safeIndex;
  room.turnId = room.players[safeIndex].id;
  room.players.forEach(p => p.hasDrawn = false);
}

function advanceTurn(room) {
  if (room.players.length === 0) return;

  let idx = room.players.findIndex(p => p.id === room.turnId);
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

  const nextIndex = (idx + steps) % room.players.length;
  room.log.push(`Turn: ${room.players[idx].name} → ${room.players[nextIndex].name}`);
  setTurnByIndex(room, nextIndex);
}

function settleClose(room, callerId) {
  room.closeCalled = true;
  const results = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    points: p.hand.reduce((s, c) => s + (c.value || 0), 0),
  }));
  results.sort((a, b) => a.points - b.points);
  const lowest = results[0];
  const highest = results[results.length - 1];
  const caller = results.find((r) => r.id === callerId);

  room.log.push(`CLOSE by ${caller?.name || "Unknown"}`);

  if (caller && caller.id === lowest.id && lowest.points === caller.points) {
    room.log.push(`CLOSE CORRECT by ${caller.name}`);
    room.players.forEach((p) => {
      if (p.id === callerId) {
        room.log.push(`${p.name} gets 0 points (winner)`);
        return;
      }
      const r = results.find((x) => x.id === p.id);
      p.score += r.points;
      room.log.push(`${p.name} +${r.points} points`);
    });
  } else {
    room.log.push(`CLOSE WRONG by ${caller?.name || "Unknown"}`);
    const penalty = highest.points * 2;
    room.players.forEach((p) => {
      const r = results.find((x) => x.id === p.id);
      if (p.id === callerId) {
        p.score += penalty;
        room.log.push(`${p.name} penalty +${penalty}`);
      } else if (r.id === lowest.id) {
        room.log.push(`${p.name} 0 points (lowest)`);
      } else {
        p.score += r.points;
        room.log.push(`${p.name} +${r.points} points`);
      }
    });
  }

  room.started = false;
  room.drawPile = [];
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.currentIndex = 0;
  room.turnId = room.players[0].id;
  room.players.forEach((p) => {
    p.hand = [];
    p.hasDrawn = false;
  });
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

  for (let r = 0; r < START_CARDS; r++) {
    room.players.forEach((p) => {
      ensureDrawPile(room);
      const c = room.drawPile.pop();
      if (c) p.hand.push(c);
    });
  }

  ensureDrawPile(room);
  const first = room.drawPile.pop();
  if (first) room.discardPile.push(first);

  room.log.push(`Round started. Open: ${first ? first.rank : "?"}`);

  if (first && first.rank === "7") {
    room.pendingDraw = 2;
    room.log.push("Open 7 → next draws 2");
  }
  if (first && first.rank === "J") {
    room.pendingSkips = 1;
    room.log.push("Open J → next skipped");
  }
}

// ==========================
// SOCKET HANDLERS (COMPLETE FIXED)
// ==========================

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("create_room", (data, cb) => {
    console.log("CREATE ROOM:", data);
    const name = data?.name?.trim() || "Player";

    let id;
    do {
      id = randomRoomId();
    } while (rooms.has(id));

    const room = {
      roomId: id,
      hostId: socket.id,
      players: [{
        id: socket.id,
        name,
        score: 0,
        hand: [],
        hasDrawn: false,
      }],
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

    rooms.set(id, room);
    socket.join(id);
    room.log.push(`${name} created room ${id}`);
    console.log(`✅ Room created: ${id}`);
    cb({ roomId: id, success: true });
    broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    console.log("JOIN ROOM:", data);
    const roomId = data?.roomId?.trim();
    const name = data?.name?.trim() || "Player";

    if (!roomId) {
      cb({ error: "Room ID missing" });
      return;
    }
    if (!rooms.has(roomId)) {
      cb({ error: `Room ${roomId} not found` });
      return;
    }

    const room = rooms.get(roomId);
    if (room.players.length >= MAX_PLAYERS) {
      cb({ error: "Room full (max 7)" });
      return;
    }
    if (room.started) {
      cb({ error: "Game started" });
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      score: 0,
      hand: [],
      hasDrawn: false,
    });
    socket.join(roomId);

    room.log.push(`${name} joined (${room.players.length}/${MAX_PLAYERS})`);
    console.log(`✅ ${name} joined ${roomId}`);
    cb({ roomId, success: true });
    broadcast(room);
  });

  socket.on("start_round", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (room.hostId !== socket.id) return;
    if (room.players.length < 2) return;

    room.started = true;
    startRound(room);
    broadcast(room);
  });

  // ✅ FIXED: DRAW → STAY SAME TURN (wait for DROP)
  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    const fromDiscard = data?.fromDiscard || false;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hasDrawn) {
      socket.emit("error", { message: "Already drawn this turn!" });
      return;
    }

    let drawCount = room.pendingDraw > 0 ? room.pendingDraw : 1;
    for (let i = 0; i < drawCount; i++) {
      let card = null;
      if (fromDiscard && room.discardPile.length > 0) {
        card = room.discardPile.pop();
        room.log.push(`${player.name} drew ${card.rank} (discard)`);
      } else {
        ensureDrawPile(room);
        card = room.drawPile.pop();
        room.log.push(`${player.name} drew ${card?.rank || "?"}`);
      }
      if (card) player.hand.push(card);
    }

    player.hasDrawn = true;
    room.pendingDraw = 0;
    room.log.push(`${player.name} ✓ Drew - now DROP!`);
    
    // ✅ NO advanceTurn - player must DROP next
    broadcast(room);
  });

  // ✅ FIXED: DROP → THEN advance turn
  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    const ids = data?.selectedIds || [];
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.hasDrawn) {
      socket.emit("error", { message: "Must draw first before dropping!" });
      return;
    }
    if (!ids.length) return;

    const selected = player.hand.filter(c => ids.includes(c.id));
    if (!selected.length) return;

    const uniqueRanks = [...new Set(selected.map(c => c.rank))];
    if (uniqueRanks.length !== 1) {
      room.log.push(`${player.name} invalid drop (same rank only)`);
      broadcast(room);
      return;
    }

    const rank = uniqueRanks[0];
    player.hand = player.hand.filter(c => !ids.includes(c.id));
    selected.forEach(c => room.discardPile.push(c));

    if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(`${player.name} dropped ${selected.length}J → skip`);
    } else if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(`${player.name} dropped ${selected.length}7 → draw`);
    } else {
      room.log.push(`${player.name} dropped ${selected.length}`);
    }

    player.hasDrawn = false;
    advanceTurn(room); // ✅ TURN ADVANCES ONLY AFTER DROP
    broadcast(room);
  });

  socket.on("action_close", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;

    settleClose(room, socket.id);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    let roomFound = null;
    for (const room of rooms.values()) {
      if (room.players.some(p => p.id === socket.id)) {
        roomFound = room;
        break;
      }
    }
    if (!roomFound) return;

    roomFound.players = roomFound.players.filter(p => p.id !== socket.id);
    roomFound.log.push("Player left");

    if (roomFound.players.length === 0) {
      rooms.delete(roomFound.roomId);
      return;
    }

    if (roomFound.hostId === socket.id) {
      roomFound.hostId = roomFound.players[0].id;
    }

    if (!roomFound.players.some(p => p.id === roomFound.turnId)) {
      setTurnByIndex(roomFound, 0);
    }

    broadcast(roomFound);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 POWER Rummy Server (DRAW→DROP→NEXT) on port", PORT);
});
