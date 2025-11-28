// ==========================
// CLOSE MASTER POWER RUMMY — SERVER ENGINE
// FULLY CUSTOM GAME ENGINE
// ==========================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Close Master POWER Rummy Server Running");
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
  const n = parseInt(rank);
  return isNaN(n) ? 0 : n;
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

  // 2 Jokers
  for (let i=0;i<2;i++) {
    deck.push({
      id: globalCardId++,
      suit: null,
      rank: "JOKER",
      value: 0
    });
  }

  // Shuffle
  for (let i = deck.length-1; i >= 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
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
      hasDrawn: p.hasDrawn || false,  // ✅ ADDED: Send hasDrawn to client
      hand: p.id===pid ? p.hand : [],
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
  for (let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

const rooms = new Map();

function ensureDrawPile(room) {
  if (room.drawPile.length > 0) return;

  if (room.discardPile.length <= 1) return;

  const top = room.discardPile.pop();
  let pile = room.discardPile;
  room.discardPile = [top];

  // shuffle
  for (let i = pile.length-1; i >= 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [pile[i],pile[j]]=[pile[j],pile[i]];
  }
  room.drawPile = pile;
}

// ==========================
// GAME RULE HELPERS
// ==========================

function hasMatch(hand, openRank) {
  return hand.some(c => c.rank === openRank);
}

function sameRankSet(hand, rank) {
  return hand.filter(c => c.rank === rank);
}

function anyTripleSet(hand) {
  let map = {};
  hand.forEach(c => {
    map[c.rank] = (map[c.rank]||0)+1;
  });
  for (const r in map) {
    if (map[r] >= 3) return r;
  }
  return null;
}

function nextTurn(room) {
  // ✅ FIXED: Reset hasDrawn before next turn
  room.players[room.currentIndex].hasDrawn = false;
  room.currentIndex = (room.currentIndex + 1) % room.players.length;
}

function settleClose(room, callerId) {
  room.closeCalled = true;

  const results = room.players.map(p => ({
    id: p.id,
    name: p.name,
    points: p.hand.reduce((s,c)=>s+c.value,0)
  }));

  results.sort((a,b)=>a.points - b.points);

  const lowest = results[0];

  const caller = results.find(r => r.id===callerId);
  const highest = results[results.length - 1];

  room.log.push(`CLOSE by ${caller.name}`);

  if (caller.id === lowest.id && lowest.points === caller.points) {
    // correct
    room.log.push(`CLOSE CORRECT by ${caller.name}`);
    room.players.forEach(p=>{
      if (p.id === callerId) return;
      const r = results.find(x => x.id===p.id);
      p.score += r.points;
    });
  } else {
    // wrong
    room.log.push(`CLOSE WRONG by ${caller.name}`);
    const penalty = highest.points * 2;
    room.players.forEach(p=>{
      if (p.id===callerId) {
        p.score += penalty;
      } else {
        const r = results.find(x=>x.id===p.id);
        if (r.id===lowest.id) return;
        p.score += r.points;
      }
    });
  }
}

function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.currentIndex = Math.floor(Math.random()*room.players.length);
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;

  room.players.forEach(p=>{
    p.hand = [];
    p.hasDrawn = false;  // ✅ ADDED: Reset hasDrawn
  });

  // deal cards
  for (let r=0;r<START_CARDS;r++) {
    room.players.forEach(p=>{
      ensureDrawPile(room);
      p.hand.push(room.drawPile.pop());
    });
  }

  // open card
  ensureDrawPile(room);
  const first = room.drawPile.pop();
  room.discardPile.push(first);

  room.log.push(`Round started. Open: ${first.rank}`);

  // open card power applies immediately
  if (first.rank === "7") {
    room.pendingDraw = 2;
    room.log.push(`Open card is 7 → Next player must draw 2`);
  }
  if (first.rank === "J") {
    room.pendingSkips = 1;
    room.log.push(`Open card is J → Next player skip`);
  }
}

// ==========================
// SOCKET HANDLERS
// ==========================

io.on("connection", socket => {

  // CREATE ROOM
  socket.on("create_room",(data,cb)=>{
    const name = data?.name || "Player";

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
        hasDrawn: false  // ✅ ADDED: hasDrawn flag
      }],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      pendingDraw: 0,
      pendingSkips: 0,
      closeCalled: false,
      log: []
    };

    rooms.set(id,room);
    socket.join(id);
    room.log.push(`${name} created room ${id}`);

    cb && cb({roomId:id});
    broadcast(room);
  });

  // JOIN ROOM
  socket.on("join_room",(data,cb)=>{
    const roomId = data?.roomId;
    const name = data?.name || "Player";

    if (!roomId || !rooms.has(roomId)) {
      cb && cb({error:"Room not found"});
      return;
    }
    const room = rooms.get(roomId);

    if (room.players.length >= MAX_PLAYERS) {
      cb && cb({error:"Room full"});
      return;
    }
    if (room.started) {
      cb && cb({error:"Game already started"});
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      score: 0,
      hand: [],
      hasDrawn: false  // ✅ ADDED: hasDrawn flag
    });
    socket.join(roomId);

    room.log.push(`${name} joined`);
    cb && cb({roomId});

    broadcast(room);
  });

  // START ROUND (only host)
  socket.on("start_round",(data)=>{
    const roomId = data?.roomId;
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (room.hostId !== socket.id) return;
    if (room.players.length < 2) return;

    room.started = true;
    startRound(room);

    broadcast(room);
  });

  // 🔥 FIXED: DRAW - NO nextTurn(), only hasDrawn=true
  socket.on("action_draw",(data)=>{
    const roomId = data?.roomId;
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled) return;

    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.currentIndex) return; // not turn

    const player = room.players[idx];
    if (player.hasDrawn) return;  // ✅ FIXED: Prevent double draw

    let drawCount = room.pendingDraw > 0 ? room.pendingDraw : 1;

    for (let i=0;i<drawCount;i++) {
      ensureDrawPile(room);
      const c = room.drawPile.pop();
      if (c) player.hand.push(c);
    }

    player.hasDrawn = true;  // ✅ FIXED: Set flag ONLY
    room.log.push(`${player.name} drew ${drawCount}`);
    room.pendingDraw = 0;

    console.log(`✅ ${player.name} drew - hasDrawn: true, WAITING FOR DROP/CLOSE`);
    broadcast(room);
    // ✅ NO nextTurn() here - FIXED BUG!
  });

  // DROP CARDS - NOW calls nextTurn()
  socket.on("action_drop",(data)=>{
    const roomId = data?.roomId;
    const ids = data?.selectedIds || [];

    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;

    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.currentIndex) return;

    const player = room.players[idx];
    if (!player.hasDrawn) {  // ✅ FIXED: Must draw first
      socket.emit("error", { message: "Draw first!" });
      return;
    }
    if (!ids.length) return;

    const selected = player.hand.filter(c=>ids.includes(c.id));
    if (!selected.length) return;

    const ranks = [...new Set(selected.map(c=>c.rank))];
    if (ranks.length !== 1) {
      room.log.push("Invalid drop (different ranks)");
      broadcast(room);
      return;
    }

    const rank = ranks[0];
    const openRank = room.discardPile.at(-1).rank;

    // Rule: forced match unless draw OR special escape
    const hasMatchInHand = hasMatch(player.hand, openRank);
    const triple = anyTripleSet(player.hand);

    let isDrawCard = false;
    if (room.pendingDraw === 0) {
      // normal scenario
      if (openRank !== rank && hasMatchInHand) {
        room.log.push("Forced match rule violated");
        broadcast(room);
        return;
      }
    }

    // special 3-card rule
    if (!hasMatchInHand && triple && rank === triple) {
      // allowed
    }

    // remove from hand
    player.hand = player.hand.filter(c=>!ids.includes(c.id));

    // add to discard
    selected.forEach(c=>room.discardPile.push(c));

    // Power effects
    if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(`${player.name} dropped ${selected.length} J → skip chain`);
    } else if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(`${player.name} dropped ${selected.length} 7 → draw chain +${2*selected.length}`);
    } else {
      room.log.push(`${player.name} dropped ${selected.length} card(s)`);
    }

    // ✅ FIXED: Next turn ONLY after drop
    nextTurn(room);
    player.hasDrawn = false;  // Reset for next turn

    broadcast(room);
  });

  // CLOSE - Only before draw
  socket.on("action_close",(data)=>{
    const roomId = data?.roomId;
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled) return;

    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.currentIndex) return;

    const player = room.players[idx];
    if (player.hasDrawn) {  // ✅ FIXED: Cannot close after draw
      socket.emit("error", { message: "Cannot close after drawing!" });
      return;
    }

    settleClose(room, socket.id);
    broadcast(room);
  });

  // DISCONNECT
  socket.on("disconnect",()=>{
    let roomFound=null;
    for (const room of rooms.values()) {
      if (room.players.some(p=>p.id===socket.id)) {
        roomFound=room;
        break;
      }
    }
    if (!roomFound) return;

    roomFound.players = roomFound.players.filter(p=>p.id!==socket.id);
    roomFound.log.push("Player disconnected");

    if (roomFound.players.length === 0) {
      rooms.delete(roomFound.roomId);
      return;
    }

    if (roomFound.hostId === socket.id) {
      roomFound.hostId = roomFound.players[0].id;
      roomFound.log.push(`${roomFound.players[0].name} is new host`);
    }

    if (roomFound.currentIndex >= roomFound.players.length)
      roomFound.currentIndex = 0;

    broadcast(roomFound);
  });
});

// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{
  console.log("POWER Rummy Server running on",PORT);
});
