// server.cjs
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Close Master server running");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ----------------- GAME STATE -----------------
const rooms = new Map();

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

function createRoomId() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += letters[Math.floor(Math.random() * letters.length)];
  }
  return id;
}

let globalCardId = 1;

function rankValue(rank) {
  if (rank === "A") return 1;
  if (rank === "JOKER") return 0;
  if (["J", "Q", "K"].includes(rank)) return 10;
  const n = parseInt(rank, 10);
  return isNaN(n) ? 0 : n;
}

function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: globalCardId++,
        suit,
        rank,
        value: rankValue(rank),
      });
    }
  }

  // Jokers
  for (let i = 0; i < 2; i++) {
    deck.push({
      id: globalCardId++,
      suit: null,
      rank: "JOKER",
      value: 0,
    });
  }

  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function calcHandPoints(hand) {
  return hand.reduce((sum, c) => sum + (c.value || 0), 0);
}

function buildGameStateFor(room, youId) {
  const discardTop = room.discardPile[room.discardPile.length - 1] || null;

  return {
    roomId: room.roomId,
    youId,
    hostId: room.hostId,
    started: room.started,
    currentIndex: room.currentIndex,
    discardTop,
    pendingDraw: room.pendingDraw,
    pendingSkips: room.pendingSkips,
    roundEnded: room.roundEnded,
    hasDrawnThisTurn: room.hasDrawnThisTurn,
    log: room.log.slice(-100),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hand: p.id === youId ? p.hand : [],
      handSize: p.hand.length,
    })),
  };
}

function broadcastRoom(room) {
  room.players.forEach((p) => {
    io.to(p.id).emit("game_state", buildGameStateFor(room, p.id));
  });
}

function getRoomByPlayer(socketId) {
  for (const room of rooms.values()) {
    if (room.players.find((p) => p.id === socketId)) return room;
  }
  return null;
}

function advanceTurn(room) {
  if (room.players.length === 0) return;

  const totalSteps = 1 + room.pendingSkips;
  room.pendingSkips = 0;
  room.hasDrawnThisTurn = false;

  room.currentIndex =
    (room.currentIndex + totalSteps) % room.players.length;
}

function ensureDrawPile(room) {
  if (room.drawPile.length > 0) return;

  if (room.discardPile.length <= 1) return;

  const top = room.discardPile.pop();
  const reshuffle = room.discardPile;
  room.discardPile = [top];

  // Shuffle back
  for (let i = reshuffle.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [reshuffle[i], reshuffle[j]] = [reshuffle[j], reshuffle[i]];
  }

  room.drawPile = reshuffle;
}

function startNewRound(room) {
  const deck = createDeck();

  room.drawPile = deck;
  room.discardPile = [];
  room.started = true;
  room.roundEnded = false;
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.hasDrawnThisTurn = false;
  room.currentIndex = 0;

  // reset hands
  room.players.forEach((p) => (p.hand = []));

  // deal 7
  for (let r = 0; r < 7; r++) {
    room.players.forEach((p) => {
      const card = room.drawPile.pop();
      if (card) p.hand.push(card);
    });
  }

  // open card
  const first = room.drawPile.pop();
  if (first) room.discardPile.push(first);

  room.log.push(`New round started. Open card: ${first?.rank}`);
}

function settleClose(room, callerId) {
  room.roundEnded = true;

  const results = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    points: calcHandPoints(p.hand),
  }));

  // sort by points
  results.sort((a, b) => a.points - b.points);
  const lowest = results[0];
  const highest = results[results.length - 1];
  const callerRes = results.find((r) => r.id === callerId);

  const lowestCount = results.filter(
    (r) => r.points === lowest.points
  ).length;

  if (lowestCount === 1 && callerRes.id === lowest.id) {
    // CORRECT CLOSE
    room.log.push(`CLOSE correct by ${callerRes.name}.`);

    room.players.forEach((p) => {
      const r = results.find((x) => x.id === p.id);
      if (!r) return;

      if (p.id === callerId) {
        room.log.push(`${p.name} gets 0 points.`);
      } else {
        p.score += r.points;
        room.log.push(`${p.name} gets +${r.points} points.`);
      }
    });
  } else {
    // WRONG CLOSE
    room.log.push(`CLOSE wrong by ${callerRes.name}.`);

    room.players.forEach((p) => {
      const r = results.find((x) => x.id === p.id);
      if (!r) return;

      if (p.id === callerId) {
        const penalty = highest.points * 2;
        p.score += penalty;
        room.log.push(
          `${p.name} gets penalty +${penalty} points.`
        );
      } else if (p.id === lowest.id) {
        room.log.push(`${p.name} gets 0 points.`);
      } else {
        p.score += r.points;
        room.log.push(`${p.name} gets +${r.points} points.`);
      }
    });
  }
}

// ----------------- SOCKET HANDLERS -----------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // create room
  socket.on("create_room", (data, cb) => {
    const name = data?.name || "Player";

    let roomId;
    do roomId = createRoomId();
    while (rooms.has(roomId));

    const room = {
      roomId,
      hostId: socket.id,
      players: [],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      pendingDraw: 0,
      pendingSkips: 0,
      roundEnded: false,
      hasDrawnThisTurn: false,
      log: [],
    };

    room.players.push({
      id: socket.id,
      name,
      score: 0,
      hand: [],
    });

    rooms.set(roomId, room);

    socket.join(roomId);
    room.log.push(`${name} created room ${roomId}`);

    if (cb) cb({ roomId });
    broadcastRoom(room);
  });

  // join room
  socket.on("join_room", (data, cb) => {
    const roomId = data?.roomId;
    const name = data?.name || "Player";

    if (!roomId || !rooms.has(roomId)) {
      cb?.({ error: "Room not found" });
      return;
    }

    const room = rooms.get(roomId);

    if (room.started) {
      cb?.({ error: "Game already started" });
      return;
    }

    if (room.players.length >= 7) {
      cb?.({ error: "Room full" });
      return;
    }

    if (!room.players.find((p) => p.id === socket.id)) {
      room.players.push({
        id: socket.id,
        name,
        score: 0,
        hand: [],
      });
    }

    socket.join(roomId);
    room.log.push(`${name} joined room ${roomId}`);

    cb?.({ roomId });
    broadcastRoom(room);
  });

  // start round
  socket.on("start_round", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (room.hostId !== socket.id) return;

    if (room.players.length < 2) {
      room.log.push("Need at least 2 players to start.");
      broadcastRoom(room);
      return;
    }

    startNewRound(room);
    broadcastRoom(room);
  });

  // DRAW — FIXED TURN CHANGE
  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (!room.started || room.roundEnded) return;

    const i = room.players.findIndex((p) => p.id === socket.id);
    if (i === -1 || i !== room.currentIndex) return;

    const player = room.players[i];

    let count = room.pendingDraw > 0 ? room.pendingDraw : 1;

    for (let c = 0; c < count; c++) {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if (card) player.hand.push(card);
    }

    room.log.push(`${player.name} drew ${count} card(s).`);

    room.pendingDraw = 0;
    room.hasDrawnThisTurn = true;

    // 🔥 IMPORTANT: turn must advance after drawing
    advanceTurn(room);

    broadcastRoom(room);
  });

  // DROP
  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    const selectedIds = data?.selectedIds || [];

    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.roundEnded) return;

    const i = room.players.findIndex((p) => p.id === socket.id);
    if (i === -1 || i !== room.currentIndex) return;

    const player = room.players[i];

    if (!selectedIds.length) return;

    const selected = player.hand.filter((c) =>
      selectedIds.includes(c.id)
    );
    if (!selected.length) return;

    const sameRank = selected.every((c) => c.rank === selected[0].rank);
    if (!sameRank) {
      room.log.push(`${player.name} tried invalid drop.`);
      broadcastRoom(room);
      return;
    }

    // remove
    player.hand = player.hand.filter(
      (c) => !selectedIds.includes(c.id)
    );

    // discard pile
    selected.forEach((c) => room.discardPile.push(c));

    const rank = selected[0].rank;

    if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(
        `${player.name} dropped ${selected.length}x7 → +${2 * selected.length} draw`
      );
    } else if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(
        `${player.name} dropped ${selected.length}xJ → skip ${selected.length}`
      );
    } else {
      room.log.push(`${player.name} dropped ${selected.length} card(s).`);
    }

    if (player.hand.length === 0) {
      room.log.push(`${player.name} emptied hand → AUTO CLOSE`);
      settleClose(room, player.id);
    } else {
      advanceTurn(room);
    }

    broadcastRoom(room);
  });

  // CLOSE
  socket.on("action_close", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (!room.started || room.roundEnded) return;

    const i = room.players.findIndex((p) => p.id === socket.id);
    if (i === -1 || i !== room.currentIndex) return;

    const player = room.players[i];

    room.log.push(`${player.name} called CLOSE!`);
    settleClose(room, player.id);

    broadcastRoom(room);
  });

  // Points -> Just re-send
  socket.on("action_points", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    broadcastRoom(rooms.get(roomId));
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const room = getRoomByPlayer(socket.id);
    if (!room) return;

    const idx = room.players.findIndex((p) => p.id === socket.id);

    if (idx !== -1) {
      const name = room.players[idx].name;
      room.log.push(`${name} left the room.`);
      room.players.splice(idx, 1);
    }

    if (room.players.length === 0) {
      rooms.delete(room.roomId);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.log.push(`${room.players[0].name} is new host.`);
    }

    if (room.currentIndex >= room.players.length) {
      room.currentIndex = 0;
    }

    broadcastRoom(room);
  });
});

// ----------------- START -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
