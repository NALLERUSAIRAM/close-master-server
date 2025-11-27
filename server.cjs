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
    origin: "*", // Vercel / any domain nundi connect avvadam kosam
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

  // two jokers
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

function rankValue(rank) {
  if (rank === "A") return 1;
  if (rank === "JOKER") return 0;
  if (["J", "Q", "K"].includes(rank)) return 10;
  const n = parseInt(rank, 10);
  if (!isNaN(n)) return n;
  return 0;
}

function calcHandPoints(hand) {
  return hand.reduce((sum, c) => sum + (c.value || 0), 0);
}

function buildGameStateFor(room, youId) {
  const discardTop =
    room.discardPile[room.discardPile.length - 1] || null;

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
    const state = buildGameStateFor(room, p.id);
    io.to(p.id).emit("game_state", state);
  });
}

function getRoomByPlayer(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.id === socketId);
    if (player) return room;
  }
  return null;
}

function advanceTurn(room) {
  if (room.players.length === 0) return;
  let steps = 1 + room.pendingSkips;
  room.pendingSkips = 0;
  room.hasDrawnThisTurn = false;

  room.currentIndex =
    (room.currentIndex + steps) % room.players.length;
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

  // clear hands, keep scores
  room.players.forEach((p) => {
    p.hand = [];
  });

  // deal 7 cards each
  for (let r = 0; r < 7; r++) {
    room.players.forEach((p) => {
      const card = room.drawPile.pop();
      if (card) p.hand.push(card);
    });
  }

  // first open card
  const first = room.drawPile.pop();
  if (first) room.discardPile.push(first);

  room.log.push(
    `New round started. Open card: ${first ? first.rank : "?"}`
  );
}

function ensureDrawPile(room) {
  if (room.drawPile.length > 0) return;
  // reshuffle discard except top
  if (room.discardPile.length <= 1) return;

  const top = room.discardPile.pop();
  let pile = room.discardPile;
  room.discardPile = [top];

  // shuffle pile
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  room.drawPile = pile;
}

function settleClose(room, callerId) {
  room.roundEnded = true;

  const results = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    points: calcHandPoints(p.hand),
  }));

  results.sort((a, b) => a.points - b.points);
  const lowest = results[0];
  const highest = results[results.length - 1];
  const callerRes = results.find((r) => r.id === callerId);

  const lowestCount = results.filter(
    (r) => r.points === lowest.points
  ).length;

  if (callerRes && lowestCount === 1 && lowest.id === callerId) {
    // CLOSE correct
    room.log.push(
      `CLOSE correct by ${callerRes.name}. Lowest = ${lowest.points}.`
    );
    room.players.forEach((p) => {
      const r = results.find((x) => x.id === p.id);
      if (!r) return;
      if (p.id === callerId) {
        // caller 0 points
        room.log.push(`${p.name} gets 0 points (caller).`);
      } else {
        p.score += r.points;
        room.log.push(`${p.name} gets +${r.points} points.`);
      }
    });
  } else {
    // CLOSE wrong
    room.log.push(
      `CLOSE wrong by ${callerRes ? callerRes.name : "Unknown"}.`
    );
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
        room.log.push(`${p.name} gets 0 points (lowest).`);
      } else {
        p.score += r.points;
        room.log.push(`${p.name} gets +${r.points} points.`);
      }
    });
  }

  room.hasDrawnThisTurn = false;
}

// ----------------- SOCKET HANDLERS -----------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // create room
  socket.on("create_room", (data, cb) => {
    const name = (data && data.name) || "Player";

    let roomId;
    do {
      roomId = createRoomId();
    } while (rooms.has(roomId));

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

    const player = {
      id: socket.id,
      name,
      score: 0,
      hand: [],
    };

    room.players.push(player);
    rooms.set(roomId, room);

    socket.join(roomId);

    room.log.push(`${name} created room ${roomId}`);
    console.log("Room created:", roomId);

    if (cb) cb({ roomId });

    broadcastRoom(room);
  });

  // join room
  socket.on("join_room", (data, cb) => {
    const roomId = data && data.roomId;
    const name = (data && data.name) || "Player";

    if (!roomId || !rooms.has(roomId)) {
      if (cb) cb({ error: "Room not found" });
      return;
    }

    const room = rooms.get(roomId);

    if (room.players.length >= 7) {
      if (cb) cb({ error: "Room is full" });
      return;
    }

    if (room.started) {
      if (cb) cb({ error: "Game already started" });
      return;
    }

    const existing = room.players.find((p) => p.id === socket.id);
    if (!existing) {
      room.players.push({
        id: socket.id,
        name,
        score: 0,
        hand: [],
      });
    }

    socket.join(roomId);
    room.log.push(`${name} joined room ${roomId}`);

    if (cb) cb({ roomId });

    broadcastRoom(room);
  });

  // start round
  socket.on("start_round", (data) => {
    const roomId = data && data.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (room.hostId !== socket.id) return; // only host

    if (room.players.length < 2) {
      room.log.push("Need at least 2 players to start.");
      broadcastRoom(room);
      return;
    }

    startNewRound(room);
    broadcastRoom(room);
  });

  // draw
  socket.on("action_draw", (data) => {
    const roomId = data && data.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.roundEnded) return;

    const playerIndex = room.players.findIndex(
      (p) => p.id === socket.id
    );
    if (playerIndex === -1) return;
    if (playerIndex !== room.currentIndex) return; // not your turn

    const player = room.players[playerIndex];

    let drawCount = 1;
    if (room.pendingDraw > 0) {
      drawCount = room.pendingDraw;
    }

    ensureDrawPile(room);
    for (let i = 0; i < drawCount; i++) {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if (card) {
        player.hand.push(card);
      }
    }

    room.log.push(
      `${player.name} drew ${drawCount} card${drawCount > 1 ? "s" : ""}.`
    );

    room.pendingDraw = 0;
    room.hasDrawnThisTurn = true;

    broadcastRoom(room);
  });

  // drop
  socket.on("action_drop", (data) => {
    const roomId = data && data.roomId;
    const selectedIds = (data && data.selectedIds) || [];
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.roundEnded) return;

    const playerIndex = room.players.findIndex(
      (p) => p.id === socket.id
    );
    if (playerIndex === -1) return;
    if (playerIndex !== room.currentIndex) return; // not your turn

    const player = room.players[playerIndex];
    if (!selectedIds.length) return;

    const selected = player.hand.filter((c) =>
      selectedIds.includes(c.id)
    );
    if (!selected.length) return;

    // multi-drop only same rank
    const allSameRank = selected.every(
      (c) => c.rank === selected[0].rank
    );
    if (!allSameRank) {
      room.log.push(
        `${player.name} tried invalid drop (different ranks).`
      );
      broadcastRoom(room);
      return;
    }

    // remove from hand
    player.hand = player.hand.filter(
      (c) => !selectedIds.includes(c.id)
    );

    // add to discard pile
    selected.forEach((c) => room.discardPile.push(c));

    // special rules: 7 => draw chain, J => skip
    const rank = selected[0].rank;
    if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(
        `${player.name} dropped ${selected.length}x 7 → draw +${2 *
          selected.length}.`
      );
    } else if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(
        `${player.name} dropped ${selected.length}x J → skip +${selected.length}.`
      );
    } else {
      room.log.push(
        `${player.name} dropped ${selected.length} card(s).`
      );
    }

    // if no cards -> auto close as winner
    if (player.hand.length === 0) {
      room.log.push(
        `${player.name} emptied hand → auto CLOSE.`
      );
      settleClose(room, player.id);
    } else {
      advanceTurn(room);
    }

    broadcastRoom(room);
  });

  // close
  socket.on("action_close", (data) => {
    const roomId = data && data.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.roundEnded) return;

    const playerIndex = room.players.findIndex(
      (p) => p.id === socket.id
    );
    if (playerIndex === -1) return;
    if (playerIndex !== room.currentIndex) return; // only current player

    const player = room.players[playerIndex];
    room.log.push(`${player.name} called CLOSE!`);

    settleClose(room, player.id);
    broadcastRoom(room);
  });

  // points (just force re-send – UI already shows scores)
  socket.on("action_points", (data) => {
    const roomId = data && data.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const room = getRoomByPlayer(socket.id);
    if (!room) return;

    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx !== -1) {
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      room.log.push(`${name} left the room.`);
    }

    if (room.players.length === 0) {
      rooms.delete(room.roomId);
      console.log("Room deleted:", room.roomId);
      return;
    }

    // if host left → new host = first player
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.log.push(
        `${room.players[0].name} is new host.`
      );
    }

    // adjust currentIndex
    if (room.currentIndex >= room.players.length) {
      room.currentIndex = 0;
    }

    broadcastRoom(room);
  });
});

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
