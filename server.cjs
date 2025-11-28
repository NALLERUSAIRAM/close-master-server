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
  if (r === "JOKER") return 0;
  if (["J","Q","K"].includes(r)) return 10;
  if (r === "A") return 1;
  return parseInt(r);
}

function createDeck() {
  const deck = [];
  for (let s of SUITS) {
    for (let r of RANKS) deck.push({ id: globalCardId++, rank: r, suit: s });
  }
  deck.push({ id: globalCardId++, rank: "JOKER", suit: "" });
  deck.push({ id: globalCardId++, rank: "JOKER", suit: "" });
  return deck.sort(() => Math.random() - 0.5);
}

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("create_room", ({ name }) => {
    const roomId = Math.random().toString(36).substr(2, 4).toUpperCase();
    const room = {
      roomId,
      deck: createDeck(),
      discardPile: [],
      players: [{ id: socket.id, name, hand: [], score: 0 }],
      turnIndex: 0,
      currentPlayerId: socket.id,
      hasDrawn: false,
      started: false,
      roundActive: false,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit("room_created", { room, players: room.players });
  });

  socket.on("join_room", ({ name, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "Room not found");
    if (room.players.length >= MAX_PLAYERS)
      return socket.emit("error", "Room full");
    if (room.started) return socket.emit("error", "Game already started");

    const player = { id: socket.id, name, hand: [], score: 0 };
    room.players.push(player);
    socket.join(roomId);
    io.to(roomId).emit("player_joined", room.players);
    socket.emit("room_joined", { room, players: room.players, isHost: false });
  });

  socket.on("start_game", () => {
    const [, roomId] = Array.from(socket.rooms);
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) return;

    room.started = true;
    room.roundActive = true;
    room.deck = createDeck();
    room.discardPile = [];
    room.players.forEach((p) => {
      p.hand = room.deck.splice(0, START_CARDS);
    });

    room.turnIndex = 0;
    room.currentPlayerId = room.players[0].id;
    room.hasDrawn = false;

    io.to(roomId).emit("game_update", room);
  });

  socket.on("action_draw", ({ fromDiscard } = {}) => {
    const [, roomId] = Array.from(socket.rooms);
    const room = rooms.get(roomId);
    if (!room || !room.roundActive) return;
    if (socket.id !== room.currentPlayerId || room.hasDrawn) return;

    const player = room.players.find((p) => p.id === socket.id);
    let card = null;

    if (fromDiscard && room.discardPile[0]) {
      const top = room.discardPile[0];
      if (!top.rank.match(/7|J/)) {
        card = room.discardPile.shift();
      }
    }

    if (!card && room.deck.length) {
      card = room.deck.pop();
    }

    if (card) player.hand.push(card);
    room.hasDrawn = true;

    io.to(roomId).emit("game_update", room);
  });

  socket.on("action_drop", ({ selectedIds }) => {
    const [, roomId] = Array.from(socket.rooms);
    const room = rooms.get(roomId);
    if (!room || !room.roundActive) return;
    if (socket.id !== room.currentPlayerId) return;
    if (!room.hasDrawn || !selectedIds || !selectedIds.length) return;

    const player = room.players.find((p) => p.id === socket.id);
    const dropSet = new Set(selectedIds.map(Number));
    const remaining = [];
    const dropped = [];

    for (const c of player.hand) {
      if (dropSet.has(c.id)) dropped.push(c);
      else remaining.push(c);
    }
    player.hand = remaining;
    if (dropped.length) room.discardPile.unshift(...dropped);

    const top = room.discardPile[0];
    if (top && top.rank === "7") {
      let ni = (room.turnIndex + 1) % room.players.length;
      const np = room.players[ni];
      for (let i = 0; i < 2 && room.deck.length; i++) {
        np.hand.push(room.deck.pop());
      }
      room.turnIndex = (ni + 1) % room.players.length;
    } else if (top && top.rank === "J") {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    } else {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    }

    room.currentPlayerId = room.players[room.turnIndex].id;
    room.hasDrawn = false;

    io.to(roomId).emit("game_update", room);
  });

  socket.on("action_close", () => {
    const [, roomId] = Array.from(socket.rooms);
    const room = rooms.get(roomId);
    if (!room || !room.roundActive) return;
    if (socket.id !== room.currentPlayerId) return;
    if (room.hasDrawn) return; // only before draw

    room.roundActive = false;

    room.players.forEach((p) => {
      p.roundTotal = p.hand.reduce((s, c) => s + cardValue(c.rank), 0);
    });

    const totals = room.players.map((p) => p.roundTotal);
    const minVal = Math.min(...totals);
    const maxVal = Math.max(...totals);

    const closePlayer = room.players.find((p) => p.id === socket.id);
    const isCorrect = closePlayer.roundTotal === minVal;

    if (isCorrect) {
      room.players.forEach((p) => {
        if (p.id === closePlayer.id) p.score += 0;
        else p.score += p.roundTotal;
      });
    } else {
      const lowestPlayer = room.players.find((p) => p.roundTotal === minVal);
      const highestPlayer = room.players.find((p) => p.roundTotal === maxVal);

      room.players.forEach((p) => {
        if (p.id === lowestPlayer.id) p.score += 0;
        else if (p.id === closePlayer.id) p.score += maxVal * 2;
        else p.score += p.roundTotal;
      });
    }

    io.to(roomId).emit("game_ended", room.players);
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server on", PORT));
