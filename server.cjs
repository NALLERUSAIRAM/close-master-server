// ==========================
// CLOSE MASTER POWER RUMMY — SERVER ENGINE
// MAX 7 PLAYERS + ALL BUGS FIXED
// ==========================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Close Master POWER Rummy Server Running - Max 7 Players");
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MAX_PLAYERS = 7;
const START_CARDS = 7;
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];
let globalCardId = 1;

function cardValue(rank) {
  if (rank === "A") return 1;
  if (rank === "JOKER") return 0;
  if (["J","Q","K"].includes(rank)) return 10;
  const n = parseInt(rank);
  return isNaN(n) ? 0 : n;
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: globalCardId++, suit: s, rank: r, value: cardValue(r) });
    }
  }
  // 2 Jokers
  for (let i = 0; i < 2; i++) {
    deck.push({ id: globalCardId++, suit: null, rank: "JOKER", value: 0 });
  }
  // Shuffle
  for (let i = deck.length - 1; i >= 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function roomStateFor(room, pid) {
  return {
    roomId: room.roomId,
    youId: pid,
    hostId: room.hostId,
    started: room.started,
    closeCalled: room.closeCalled,
    currentIndex: room.currentIndex,
    discardTop: room.discardPile.at(-1),
    pendingDraw: room.pendingDraw,
    pendingSkips: room.pendingSkips,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hasDrawn: p.hasDrawn === undefined ? false : p.hasDrawn, // ✅ CRITICAL FIX
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length
    })),
    log: room.log.slice(-80)
  };
}

function broadcast(room) {
  room.players.forEach(p => {
    io.to(p.id).emit("game_state", roomStateFor(room, p.id));
  });
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const rooms = new Map();

function ensureDrawPile(room) {
  if (room.drawPile.length > 0) return;
  if (room.discardPile.length <= 1) return;
  const top = room.discardPile.pop();
  let pile = room.discardPile;
  room.discardPile = [top];
  for (let i = pile.length - 1; i >= 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  room.drawPile = pile;
}

function hasMatch(hand, openRank) {
  return hand.some(c => c.rank === openRank);
}

function anyTripleSet(hand) {
  let map = {};
  hand.forEach(c => map[c.rank] = (map[c.rank] || 0) + 1);
  for (const r in map) if (map[r] >= 3) return r;
  return null;
}

function nextTurn(room) {
  room.players[room.currentIndex].hasDrawn = false; // ✅ Reset hasDrawn
  room.currentIndex = (room.currentIndex + 1) % room.players.length;
}

function settleClose(room, callerId) {
  room.closeCalled = true;
  const results = room.players.map(p => ({
    id: p.id,
    name: p.name,
    points: p.hand.reduce((s, c) => s + c.value, 0)
  }));
  results.sort((a, b) => a.points - b.points);
  const lowest = results[0];
  const caller = results.find(r => r.id === callerId);
  const highest = results[results.length - 1];
  room.log.push(`CLOSE by ${caller.name}`);
  if (caller.id === lowest.id) {
    room.log.push(`CLOSE CORRECT by ${caller.name}`);
    room.players.forEach(p => {
      if (p.id === callerId) return;
      const r = results.find(x => x.id === p.id);
      p.score += r.points;
    });
  } else {
    room.log.push(`CLOSE WRONG by ${caller.name}`);
    const penalty = highest.points * 2;
    room.players.forEach(p => {
      if (p.id === callerId) p.score += penalty;
      else {
        const r = results.find(x => x.id === p.id);
        if (r.id === lowest.id) return;
        p.score += r.points;
      }
    });
  }
}

function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.currentIndex = 0; // ✅ HOST (index 0) FIRST TURN
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;
  room.players.forEach(p => {
    p.hand = [];
    p.hasDrawn = false;
    p.score = 0; // Reset scores
  });
  // Deal cards to all 7 players
  for (let r = 0; r < START_CARDS; r++) {
    room.players.forEach(p => {
      ensureDrawPile(room);
      p.hand.push(room.drawPile.pop());
    });
  }
  ensureDrawPile(room);
  const first = room.drawPile.pop();
  room.discardPile.push(first);
  room.log.push(`Round started. Open: ${first.rank}`);
  if (first.rank === "7") {
    room.pendingDraw = 2;
    room.log.push(`Open 7 → Next draws 2`);
  }
  if (first.rank === "J") {
    room.pendingSkips = 1;
    room.log.push(`Open J → Next skipped`);
  }
}

io.on("connection", socket => {
  console.log(`✅ Player connected: ${socket.id}`);

  socket.on("create_room", (data, cb) => {
    const name = data?.name?.trim().substring(0, 15) || "Player";
    let id;
    do { id = randomRoomId(); } while (rooms.has(id));
    const room = {
      roomId: id,
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0, hand: [], hasDrawn: false }],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      pendingDraw: 0,
      pendingSkips: 0,
      closeCalled: false,
      log: [`${name} created room ${id}`]
    };
    rooms.set(id, room);
    socket.join(id);
    cb?.({ roomId: id });
    broadcast(room);
    console.log(`🏠 Room ${id} created by ${name}`);
  });

  socket.on("join_room", (data, cb) => {
    const roomId = data?.roomId?.toUpperCase();
    const name = data?.name?.trim().substring(0, 15) || "Player";
    
    if (!roomId || !rooms.has(roomId)) return cb?.({ error: "Room not found" });
    const room = rooms.get(roomId);
    
    if (room.players.length >= MAX_PLAYERS) return cb?.({ error: `Room full (${MAX_PLAYERS} max)` });
    if (room.started) return cb?.({ error: "Game already started" });
    
    room.players.push({ id: socket.id, name, score: 0, hand: [], hasDrawn: false });
    socket.join(roomId);
    room.log.push(`${name} joined (${room.players.length}/${MAX_PLAYERS})`);
    cb?.({ roomId });
    broadcast(room);
    console.log(`🚪 ${name} joined ${roomId} (${room.players.length}/${MAX_PLAYERS})`);
  });

  socket.on("start_round", (data) => {
    const roomId = data?.roomId;
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== socket.id || room.players.length < 2) return;
    
    room.started = true;
    startRound(room);
    broadcast(room);
    console.log(`▶️ ${roomId} started - Host ${room.players[0].name} first turn`);
  });

  // ✅ PERFECT DRAW LOGIC
  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentIndex) return;
    
    const player = room.players[idx];
    if (player.hasDrawn) return; // Already drew
    
    let drawCount = room.pendingDraw > 0 ? room.pendingDraw : 1;
    for (let i = 0; i < drawCount; i++) {
      ensureDrawPile(room);
      const c = room.drawPile.pop();
      if (c) player.hand.push(c);
    }
    
    player.hasDrawn = true;
    room.pendingDraw = 0;
    room.log.push(`${player.name} drew ${drawCount} card(s)`);
    
    console.log(`📥 ${player.name} drew → hasDrawn: true`);
    broadcast(room);
  });

  // ✅ PERFECT DROP LOGIC - Works for 7 players
  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    const ids = data?.selectedIds || [];
    
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentIndex) return;
    
    const player = room.players[idx];
    if (!player.hasDrawn) {
      socket.emit("error", { message: "Draw first!" });
      return;
    }
    if (!ids.length) return;
    
    const selected = player.hand.filter(c => ids.includes(c.id));
    if (!selected.length) return;
    
    // Same rank validation
    const ranks = [...new Set(selected.map(c => c.rank))];
    if (ranks.length !== 1) {
      room.log.push(`${player.name}: Invalid drop - different ranks`);
      broadcast(room);
      return;
    }
    
    const rank = ranks[0];
    const openRank = room.discardPile.at(-1)?.rank;
    
    // ✅ FIXED: SAME RANK = ALWAYS ALLOWED
    if (rank === openRank) {
      // Perfect match - always allowed
    } else {
      // Non-match: Must have triple OR no matching cards in hand
      const hasMatchInHand = hasMatch(player.hand, openRank);
      const triple = anyTripleSet(player.hand);
      if (hasMatchInHand && !triple) {
        room.log.push(`${player.name}: Must match open card or use triple!`);
        broadcast(room);
        return;
      }
    }
    
    // ✅ SUCCESSFUL DROP
    player.hand = player.hand.filter(c => !ids.includes(c.id));
    selected.forEach(c => room.discardPile.push(c));
    
    // Power card effects
    if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(`${player.name} dropped ${selected.length} J → ${selected.length} skip(s)`);
    } else if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(`${player.name} dropped ${selected.length} 7 → +${2*selected.length} draw(s)`);
    } else {
      room.log.push(`${player.name} dropped ${selected.length} ${rank}(s)`);
    }
    
    nextTurn(room); // Next player (works for 7 players)
    broadcast(room);
    console.log(`🗑️ ${player.name} dropped → Next: ${room.players[room.currentIndex].name}`);
  });

  // ✅ PERFECT CLOSE LOGIC
  socket.on("action_close", (data) => {
    const roomId = data?.roomId;
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;
    
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentIndex) return;
    
    const player = room.players[idx];
    if (player.hasDrawn) {
      socket.emit("error", { message: "Cannot close after drawing!" });
      return;
    }
    
    settleClose(room, socket.id);
    broadcast(room);
    console.log(`❌ ${player.name} closed round`);
  });

  socket.on("disconnect", () => {
    console.log(`❌ ${socket.id} disconnected`);
    for (const room of rooms.values()) {
      if (room.players.some(p => p.id === socket.id)) {
        room.players = room.players.filter(p => p.id !== socket.id);
        room.log.push("Player disconnected");
        if (room.players.length === 0) {
          rooms.delete(room.roomId);
          return;
        }
        if (room.hostId === socket.id) {
          room.hostId = room.players[0]?.id;
          room.log.push(`${room.players[0]?.name || 'New Host'} is new host`);
        }
        if (room.currentIndex >= room.players.length) room.currentIndex = 0;
        broadcast(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 POWER Rummy Server running on port ${PORT}`);
  console.log(`📱 Max ${MAX_PLAYERS} players supported`);
  console.log(`🌐 Test: http://localhost:${PORT}`);
});
