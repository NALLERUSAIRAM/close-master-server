const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

const MAX_PLAYERS = 7;
const START_CARDS = 13;
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];
let globalCardId = 1;

function cardValue(r) {
  if (["A","2","3","4"].includes(r)) return 5;
  return 10;
}

function createDeck() {
  const deck = [];
  for (let suit of SUITS) {
    for (let rank of RANKS) {
      deck.push({ id: globalCardId++, rank, suit });
    }
  }
  deck.push({ id: globalCardId++, rank: "JOKER", suit: "" });
  deck.push({ id: globalCardId++, rank: "JOKER", suit: "" });
  return deck.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
  return hand.reduce((sum, card) => sum + cardValue(card.rank), 0);
}

function setTurnByIndex(room, index) {
  room.turnIndex = index;
  room.currentPlayerId = room.players[index].id;
  room.currentPlayer = room.players[index];
  room.hasDrawn = false;  // 🎯 RESET for new turn
}

const rooms = new Map();

io.on("connection", (socket) => {
  console.log(`[Socket] ${socket.id} connected`);

  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substr(2, 4).toUpperCase();
    const room = {
      roomId,
      deck: createDeck(),
      discardPile: [],
      players: [{ id: socket.id, name: data.name, hand: [], score: 0, folded: false }],
      turnIndex: 0,
      currentPlayerId: socket.id,
      hasDrawn: false,
      started: false
    };
    
    socket.join(roomId);
    rooms.set(roomId, room);
    socket.emit("room_created", { room, players: room.players });
    console.log(`[Room] ${roomId} created by ${data.name}`);
  });

  socket.on("join_room", (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return socket.emit("error", "Room not found!");
    if (room.players.length >= MAX_PLAYERS) return socket.emit("error", "Room full!");
    if (room.started) return socket.emit("error", "Game started!");

    const player = { id: socket.id, name: data.name, hand: [], score: 0, folded: false };
    room.players.push(player);
    socket.join(data.roomId);
    
    io.to(data.roomId).emit("player_joined", room.players);
    socket.emit("room_joined", { room, players: room.players, isHost: false });
  });

  socket.on("start_game", () => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) return socket.emit("error", "Need 2+ players!");
    
    room.started = true;
    room.players.forEach(player => player.hand = room.deck.splice(0, START_CARDS));
    room.discardPile.unshift(room.deck.pop());
    
    setTurnByIndex(room, 0);
    io.to(roomId).emit("game_update", room);
  });

  // 🎯 PERFECT: Deck/Open → NO turn pass, just hasDrawn=true
  socket.on("action_draw", (data) => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.currentPlayerId || room.hasDrawn) return;

    let card;
    if (data.fromDiscard && room.discardPile[0]) {
      card = room.discardPile.shift();
    } else if (room.deck.length > 0) {
      card = room.deck.pop();
    }
    
    if (card) {
      const player = room.players.find(p => p.id === socket.id);
      player.hand.push(card);
    }
    
    room.hasDrawn = true;  // 🎯 Mark drawn - NO turn pass
    io.to(roomId).emit("game_update", room);
    console.log(`[Draw] ${room.players.find(p=>p.id===socket.id)?.name} drew card`);
  });

  // 🎯 PERFECT: Drop → THEN turn pass
  socket.on("action_drop", (data) => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.currentPlayerId || !room.hasDrawn || !data.selectedIds?.length) return;

    const player = room.players.find(p => p.id === socket.id);
    const droppedCards = data.selectedIds.map(id => player.hand.find(c => c.id === parseInt(id))).filter(Boolean);
    
    droppedCards.forEach(card => {
      room.discardPile.unshift(card);
      player.hand = player.hand.filter(c => c.id !== card.id);
    });

    // 🎯 NOW pass turn after drop
    let nextIndex = (room.turnIndex + 1) % room.players.length;
    setTurnByIndex(room, nextIndex);
    
    io.to(roomId).emit("game_update", room);
    console.log(`[Drop] ${player.name} dropped ${droppedCards.length} cards → Turn ${room.players[nextIndex].name}`);
  });

  socket.on("action_close", () => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.currentPlayerId || !room.hasDrawn) return socket.emit("error", "Draw first!");

    room.players.forEach(player => {
      if (!player.folded) player.score = calculateScore(player.hand);
    });
    
    io.to(roomId).emit("game_ended", room.players);
    console.log(`[Close] Game ended! Scores:`, room.players.map(p => `${p.name}: ${p.score}`));
  });

  socket.on("disconnect", () => console.log(`[Socket] ${socket.id} disconnected`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Railway: Ready!`);
});
