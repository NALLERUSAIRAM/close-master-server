// ==========================
// CLOSE MASTER POWER RUMMY — SERVER ENGINE
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

  // 2 Jokers
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

function roomStateFor(room, pid) {
  const discardTop =
    room.discardPile[room.discardPile.length - 1] || null;

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
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hand: p.id === pid ? p.hand : [],
      handSize: p.hand.length,
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

  // shuffle discard (except top) back into draw
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  room.drawPile = pile;
}

// TURN ROTATION — uses explicit turnId for stability
function setTurnByIndex(room, index) {
  if (room.players.length === 0) return;
  const safeIndex = ((index % room.players.length) + room.players.length) % room.players.length;
  room.currentIndex = safeIndex;
  room.turnId = room.players[safeIndex].id;
}

function advanceTurn(room) {
  if (room.players.length === 0) return;

  // find current turn index based on turnId
  let idx = room.players.findIndex(p => p.id === room.turnId);
  if (idx === -1) idx = 0;

  let steps = 1;
  if (room.pendingSkips > 0) {
    steps += room.pendingSkips;
    room.pendingSkips = 0;
  }

  const nextIndex = (idx + steps) % room.players.length;
  setTurnByIndex(room, nextIndex);
}

// SCORE & CLOSE HANDLING
function settleClose(room, callerId) {
  room.closeCalled = true;

  const results = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    points: p.hand.reduce(
      (s, c) => s + (c.value || 0),
      0
    ),
  }));

  results.sort((a, b) => a.points - b.points);

  const lowest = results[0];
  const highest = results[results.length - 1];
  const caller = results.find((r) => r.id === callerId);

  room.log.push(`CLOSE by ${caller?.name || "Unknown"}`);

  if (
    caller &&
    caller.id === lowest.id &&
    lowest.points === caller.points
  ) {
    // ✅ CLOSE CORRECT:
    // caller -> 0, others -> +their hand points
    room.log.push(`CLOSE CORRECT by ${caller.name}`);
    room.players.forEach((p) => {
      if (p.id === callerId) {
        // explicitly 0, no change
        room.log.push(`${p.name} gets 0 points (caller, lowest).`);
        return;
      }
      const r = results.find((x) => x.id === p.id);
      p.score += r.points;
      room.log.push(`${p.name} gets +${r.points} points.`);
    });
  } else {
    // ✅ CLOSE WRONG:
    // caller -> +2 × highest points
    // lowest -> +0
    // others -> +their hand points
    room.log.push(`CLOSE WRONG by ${caller?.name || "Unknown"}`);
    const penalty = highest.points * 2;

    room.players.forEach((p) => {
      const r = results.find((x) => x.id === p.id);
      if (p.id === callerId) {
        p.score += penalty;
        room.log.push(
          `${p.name} gets penalty +${penalty} (2x highest ${highest.points}).`
        );
      } else if (r.id === lowest.id) {
        room.log.push(
          `${p.name} gets 0 points (lowest hand, protected).`
        );
      } else {
        p.score += r.points;
        room.log.push(`${p.name} gets +${r.points} points.`);
      }
    });
  }

  // 🟢 ROUND RESET (players & scores stay, hands + piles clear)
  room.started = false;
  room.drawPile = [];
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.currentIndex = 0;
  room.turnId = room.players[0].id;
  room.players.forEach((p) => {
    p.hand = [];
  });
}

function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;

  // 🟢 Host always index 0, and host starts turn
  room.players.forEach((p) => {
    p.hand = [];
  });
  setTurnByIndex(room, 0); // sets currentIndex & turnId

  // deal 7 each
  for (let r = 0; r < START_CARDS; r++) {
    room.players.forEach((p) => {
      ensureDrawPile(room);
      const c = room.drawPile.pop();
      if (c) p.hand.push(c);
    });
  }

  // first open card
  ensureDrawPile(room);
  const first = room.drawPile.pop();
  if (first) room.discardPile.push(first);

  room.log.push(
    `Round started. Open: ${first ? first.rank : "?"}`
  );

  // Open card power applies immediately
  if (first && first.rank === "7") {
    room.pendingDraw = 2;
    room.log.push("Open card 7 → next player draws 2");
  }
  if (first && first.rank === "J") {
    room.pendingSkips = 1;
    room.log.push("Open card J → next player skip");
  }
}

// ==========================
// SOCKET HANDLERS
// ==========================

io.on("connection", (socket) => {
  // CREATE ROOM
  socket.on("create_room", (data, cb) => {
    const name = data?.name || "Player";

    let id;
    do {
      id = randomRoomId();
    } while (rooms.has(id));

    const room = {
      roomId: id,
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          name,
          score: 0,
          hand: [],
        },
      ],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      turnId: socket.id,   // 🟢 host turn by default (before round)
      pendingDraw: 0,
      pendingSkips: 0,
      closeCalled: false,
      log: [],
    };

    rooms.set(id, room);
    socket.join(id);
    room.log.push(`${name} created room ${id}`);

    cb && cb({ roomId: id });
    broadcast(room);
  });

  // JOIN ROOM
  socket.on("join_room", (data, cb) => {
    const roomId = data?.roomId;
    const name = data?.name || "Player";

    if (!roomId || !rooms.has(roomId)) {
      cb && cb({ error: "Room not found" });
      return;
    }
    const room = rooms.get(roomId);

    if (room.players.length >= MAX_PLAYERS) {
      cb && cb({ error: "Room is full (max 7 players)" });
      return;
    }
    if (room.started) {
      cb && cb({ error: "Game already started" });
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      score: 0,
      hand: [],
    });
    socket.join(roomId);

    room.log.push(`${name} joined`);
    cb && cb({ roomId });

    broadcast(room);
  });

  // START ROUND (only host)
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

  // DRAW CARD
  socket.on("action_draw", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled) return;

    const idx = room.players.findIndex(
      (p) => p.id === socket.id
    );
    if (idx === -1) return;
    if (socket.id !== room.turnId) return; // 🟢 only turn owner can draw

    const player = room.players[idx];

    let drawCount =
      room.pendingDraw > 0 ? room.pendingDraw : 1;

    for (let i = 0; i < drawCount; i++) {
      ensureDrawPile(room);
      const c = room.drawPile.pop();
      if (c) player.hand.push(c);
    }

    room.log.push(
      `${player.name} drew ${drawCount} card(s)`
    );
    room.pendingDraw = 0;

    broadcast(room);
  });

  // DROP CARDS
  socket.on("action_drop", (data) => {
    const roomId = data?.roomId;
    const ids = data?.selectedIds || [];

    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (!room.started || room.closeCalled) return;

    const idx = room.players.findIndex(
      (p) => p.id === socket.id
    );
    if (idx === -1) return;
    if (socket.id !== room.turnId) return; // 🟢 only current turn can drop

    const player = room.players[idx];
    if (!ids.length) return;

    const selected = player.hand.filter((c) =>
      ids.includes(c.id)
    );
    if (!selected.length) return;

    const uniqueRanks = [
      ...new Set(selected.map((c) => c.rank)),
    ];
    if (uniqueRanks.length !== 1) {
      room.log.push(
        `${player.name} invalid drop (different ranks)`
      );
      broadcast(room);
      return;
    }

    const rank = uniqueRanks[0];

    // remove from hand
    player.hand = player.hand.filter(
      (c) => !ids.includes(c.id)
    );

    // add to discard
    selected.forEach((c) => room.discardPile.push(c));

    // power effects
    if (rank === "J") {
      room.pendingSkips += selected.length;
      room.log.push(
        `${player.name} dropped ${selected.length} J → skip +${selected.length}`
      );
    } else if (rank === "7") {
      room.pendingDraw += 2 * selected.length;
      room.log.push(
        `${player.name} dropped ${selected.length} 7 → draw +${
          2 * selected.length
        }`
      );
    } else {
      room.log.push(
        `${player.name} dropped ${selected.length} card(s)`
      );
    }

    // turn moves clockwise (with skip chain)
    advanceTurn(room);
    broadcast(room);
  });

  // CLOSE
  socket.on("action_close", (data) => {
    const roomId = data?.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (!room.started || room.closeCalled) return;

    const idx = room.players.findIndex(
      (p) => p.id === socket.id
    );
    if (idx === -1) return;
    if (socket.id !== room.turnId) return;

    settleClose(room, socket.id);
    broadcast(room);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    let roomFound = null;
    for (const room of rooms.values()) {
      if (room.players.some((p) => p.id === socket.id)) {
        roomFound = room;
        break;
      }
    }
    if (!roomFound) return;

    roomFound.players = roomFound.players.filter(
      (p) => p.id !== socket.id
    );
    roomFound.log.push("Player disconnected");

    if (roomFound.players.length === 0) {
      rooms.delete(roomFound.roomId);
      return;
    }

    if (roomFound.hostId === socket.id) {
      roomFound.hostId = roomFound.players[0].id;
      roomFound.log.push(
        `${roomFound.players[0].name} is new host`
      );
    }

    // if turn owner left, shift to index 0
    if (
      !roomFound.players.some(
        (p) => p.id === roomFound.turnId
      )
    ) {
      setTurnByIndex(roomFound, 0);
    } else {
      // also keep currentIndex in range
      if (
        roomFound.currentIndex >=
        roomFound.players.length
      ) {
        setTurnByIndex(roomFound, 0);
      }
    }

    broadcast(roomFound);
  });
});

// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("POWER Rummy Server running on", PORT);
});
