const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

app.get("/", (req, res) => {
  res.send("🚀 Close Master POWER RUMMY - 7 CARDS ✅ ALL RULES FIXED");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ========================================
// GAME CONSTANTS - 7 CARDS FIXED
// ========================================
const MAX_PLAYERS = 7;
const START_CARDS = 7;  // ✅ FIXED: 7 cards per player
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
let globalCardId = 1;

function cardValue(rank) {
  if (rank === "A") return 1;
  if (rank === "JOKER") return 0;
  if (["J", "Q", "K"].includes(rank)) return 10;
  return parseInt(rank) || 0;
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
  const player = room.players.find(p => p.id === pid);
  
  return {
    roomId: room.roomId,
    youId: pid,
    hostId: room.hostId,
    started: room.started,
    closeCalled: room.closeCalled,
    currentIndex: room.currentIndex,
    discardTop,
    pendingDraw: room.pendingDraw || 0,
    pendingSkips: room.pendingSkips || 0,
    hasDrawn: player?.hasDrawn || false,
    matchingOpenCardCount: player ? player.hand.filter(c => c.rank === discardTop?.rank).length : 0,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
    })),
    log: room.log.slice(-15),
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
  room.log.push("🔄 Deck reshuffled");
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
    steps += room.pendingSkips;
    room.pendingSkips = 0;
    room.log.push(`⏭️ Skipped ${steps-1} turn(s)`);
  }

  const nextIndex = (idx + steps) % room.players.length;
  room.log.push(`Turn → ${room.players[nextIndex].name}`);
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
    p.score = 0;
  });

  setTurnByIndex(room, 0);

  // ✅ 7 CARDS DEALING
  for (let i = 0; i < START_CARDS; i++) {  // START_CARDS = 7
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
    room.log.push(`🎴 Round started! Open: ${firstCard.rank}`);
    
    if (firstCard.rank === "7") {
      room.pendingDraw = 2;
      room.log.push("7 → Next draws 2");
    }
    if (firstCard.rank === "J") {
      room.pendingSkips = 1;
      room.log.push("J → Next skipped");
    }
  }

  broadcast(room);
}

io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on("create_room", (data, cb) => {
    console.log("🎮 CREATE:", data);
    const name = (data?.name || "Player").trim().substring(0, 15) || "Player";
    
    let roomId;
    do { roomId = randomRoomId(); } while (rooms.has(roomId));

    const room = {
      roomId, 
      hostId: socket.id, 
      players: [{
        id: socket.id, name, score: 0, hand: [], hasDrawn: false
      }], 
      started: false, 
      drawPile: [], 
      discardPile: [], 
      currentIndex: 0,
      turnId: socket.id, 
      pendingDraw: 0, 
      pendingSkips: 0, 
      closeCalled: false, 
      log: []
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    room.log.push(`${name} created room`);
    console.log(`✅ Room ${roomId} created by ${name}`);
    
    cb({ roomId, success: true });
    broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    console.log("🚪 JOIN:", data);
    const roomId = (data?.roomId || "").trim().toUpperCase();
    const name = (data?.name || "Player").trim().substring(0, 15) || "Player";

    if (!roomId) return cb({ error: "Room ID missing" });
    if (!rooms.has(roomId)) return cb({ error: `Room ${roomId} not found` });

    const room = rooms.get(roomId);
    if (room.players.length >= MAX_PLAYERS) return cb({ error: "Room full" });
    if (room.started) return cb({ error: "Game started" });

    room.players.push({ id: socket.id, name, score: 0, hand: [], hasDrawn: false });
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
    if (room.hostId !== socket.id || room.players.length < 2) return;
    
    console.log(`▶️ ${socket.id} starting round ${roomId}`);
    startRound(room);
  });

  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled || socket.id !== room.turnId) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hasDrawn) return;

    let drawCount = room.pendingDraw > 0 ? room.pendingDraw : 1;
    const fromDiscard = data?.fromDiscard || false;
    
    for (let i = 0; i < drawCount; i++) {
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
    room.log.push(`${player.name} drew ${drawCount} card(s)`);
    broadcast(room);
  });

  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled || socket.id !== room.turnId) return;
    
    const player = room.players.find(p => p.id === socket.id);
    const ids = data?.selectedIds || [];
    const selected = player.hand.filter(c => ids.includes(c.id));

    if (selected.length === 0) return;

    const uniqueRanks = [...new Set(selected.map(c => c.rank))];
    if (uniqueRanks.length !== 1) return;

    const openCard = room.discardPile[room.discardPile.length - 1];
    const canDropWithoutDraw = openCard && uniqueRanks[0] === openCard.rank;
    
    if (!player.hasDrawn && !canDropWithoutDraw) return;

    player.hand = player.hand.filter(c => !ids.includes(c.id));
    selected.forEach(c => room.discardPile.push(c));

    const rank = uniqueRanks[0];
    if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(`${player.name} dropped ${selected.length}J → ${selected.length} skip(s)`);
    } else if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(`${player.name} dropped ${selected.length}7 → +${2*selected.length} draw`);
    } else {
      room.log.push(`${player.name} dropped ${selected.length} ${rank}`);
    }

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
    room.players.forEach(p => {
      p.score += p.hand.reduce((sum, c) => sum + c.value, 0);
    });
    room.log.push(`${room.players.find(p => p.id === socket.id)?.name} called CLOSE`);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 ${socket.id} disconnected`);
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.some(p => p.id === socket.id)) {
        room.players = room.players.filter(p => p.id !== socket.id);
        room.log.push("Player left");

        if (room.players.length === 0) {
          rooms.delete(roomId);
          break;
        }
        
        if (room.hostId === socket.id) {
          room.hostId = room.players[0]?.id;
        }
        
        if (!room.players.some(p => p.id === room.turnId)) {
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
  console.log(`🚀 Close Master Server on port ${PORT} - 7 CARDS ✅`);
});
