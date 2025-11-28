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
  if (r === "A") return 5;
  if (r === "J") return 10;
  if (r === "Q") return 10;
  if (r === "K") return 10;
  const num = parseInt(r);
  return num >= 5 ? 10 : 5;
}

const rooms = new Map();

function createDeck() {
  const deck = [];
  for (let suit of SUITS) {
    for (let rank of RANKS) {
      deck.push({ id: globalCardId++, rank, suit });
    }
  }
  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getRoomByPlayer(socketId) {
  return Array.from(rooms.values()).find(r => r.turnId === socketId || r.players.some(p => p.id === socketId));
}

function getCurrentPlayer(room) {
  return room.players[room.turnIndex];
}

function nextTurn(room) {
  // Reset current player's hasDrawn
  room.players[room.turnIndex].hasDrawn = false;
  
  // Move to next player
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.turnId = room.players[room.turnIndex].id;
}

function broadcast(room) {
  io.to(room.id).emit("game_state", {
    ...room,
    players: room.players.map(p => ({
      ...p,
      hand: p.id === room.hostId ? p.hand : p.hand.map(c => ({ rank: c.rank, suit: c.suit, id: c.id })),
      handSize: p.hand.length
    })),
    discardTop: room.discardPile[room.discardPile.length - 1] || null
  });
}

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  socket.on("create_room", (data) => {
    console.log(`🎮 CREATE ROOM: ${data.name}`);
    const roomId = Math.random().toString(36).substr(2, 4).toUpperCase();
    
    const room = {
      id: roomId,
      players: [{ id: socket.id, name: data.name, hand: [], score: 0, hasDrawn: false, folded: false }],
      hostId: socket.id,
      turnId: null,
      turnIndex: 0,
      drawPile: [],
      discardPile: [],
      usedPile: [],
      log: [`Room ${roomId} created by ${data.name}`],
      started: false,
      roundScores: {},
      pendingDraw: 1,
      pendingSkips: 0
    };
    
    rooms.set(roomId, room);
    socket.join(roomId);
    
    console.log(`✅ Room created: ${roomId}`);
    socket.emit("room_created", { roomId });
    broadcast(room);
  });

  socket.on("join_room", (data) => {
    const roomId = data.roomId.toUpperCase();
    console.log(`🚪 JOIN: ${data.name} → ${roomId}`);
    
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("error", "Room not found");
      return;
    }
    
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("error", "Room full");
      return;
    }
    
    const player = { id: socket.id, name: data.name, hand: [], score: 0, hasDrawn: false, folded: false };
    room.players.push(player);
    socket.join(roomId);
    
    room.log.push(`${data.name} joined (${room.players.length}/${MAX_PLAYERS})`);
    broadcast(room);
    console.log(`✅ ${data.name} joined ${roomId}`);
  });

  socket.on("start_game", () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id || room.players.length < 2 || room.started) return;

    console.log(`🚀 ${room.id} game started`);
    room.started = true;
    room.players.forEach(p => {
      p.hand = [];
      p.score = 0;
      p.hasDrawn = false;
      p.folded = false;
    });
    room.drawPile = createDeck();
    room.discardPile = [];
    
    room.players.forEach(p => {
      for (let i = 0; i < START_CARDS; i++) {
        if (room.drawPile.length > 0) {
          p.hand.push(room.drawPile.pop());
        }
      }
    });
    
    const firstCard = room.drawPile.pop();
    if (firstCard) room.discardPile.push(firstCard);
    
    room.log = [`Round started! Open: ${firstCard?.rank}${firstCard?.suit || ''}`];
    room.turnIndex = 0;
    room.turnId = room.players[0].id;
    
    broadcast(room);
  });

  // ✅ FIXED: Draw - NO nextTurn() here
  socket.on("action_draw", ({ fromDiscard = false }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room || !room.started) return;
    
    const player = getCurrentPlayer(room);
    if (player.id !== socket.id) return; // Not your turn
    if (player.hasDrawn) return; // Already drew
    
    let card = null;
    
    if (fromDiscard && room.discardPile.length > 0) {
      const topCard = room.discardPile[room.discardPile.length - 1];
      // Cannot take 7 or J from discard
      if (topCard.rank === "7" || topCard.rank === "J") {
        socket.emit("error", { message: "Cannot take 7 or J from open!" });
        return;
      }
      card = room.discardPile.pop();
    } else if (room.drawPile.length > 0) {
      card = room.drawPile.pop();
    }
    
    if (!card) {
      socket.emit("error", { message: "No cards left!" });
      return;
    }
    
    player.hand.push(card);
    player.hasDrawn = true;
    room.log.push(`${player.name} drew ${fromDiscard ? 'open' : 'deck'} card`);
    
    console.log(`✅ ${player.name} drew card, hasDrawn: true`);
    broadcast(room);
  });

  // ✅ FIXED: Drop - Only here nextTurn() called
  socket.on("action_drop", ({ selectedIds }) => {
    const room = getRoomByPlayer(socket.id);
    if (!room || !room.started) return;
    
    const player = getCurrentPlayer(room);
    if (player.id !== socket.id) return;
    if (!player.hasDrawn) {
      socket.emit("error", { message: "Draw first!" });
      return;
    }
    if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
      socket.emit("error", { message: "Select cards!" });
      return;
    }
    
    const droppedCards = [];
    player.hand = player.hand.filter(card => {
      if (selectedIds.includes(card.id)) {
        droppedCards.push(card);
        room.discardPile.push(card);
        return false;
      }
      return true;
    });
    
    room.log.push(`${player.name} dropped ${droppedCards.length} cards`);
    
    nextTurn(room);
    broadcast(room);
    console.log(`✅ ${player.name} dropped → Next turn: ${room.players[room.turnIndex].name}`);
  });

  // ✅ FIXED: Close - Only before draw
  socket.on("action_close", () => {
    const room = getRoomByPlayer(socket.id);
    if (!room || !room.started) return;
    
    const player = getCurrentPlayer(room);
    if (player.id !== socket.id) return;
    if (player.hasDrawn) {
      socket.emit("error", { message: "Cannot close after drawing!" });
      return;
    }
    
    // Calculate scores
    room.players.forEach(p => {
      p.score = p.hand.reduce((sum, card) => sum + cardValue(card.rank), 0);
    });
    
    room.roundScores = {};
    room.players.forEach(p => {
      room.roundScores[p.id] = p.score;
    });
    
    room.log.push(`${player.name} closed the round!`);
    room.closeCalled = player.id;
    room.started = false;
    
    broadcast(room);
    console.log(`✅ Round closed by ${player.name}`);
  });

  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    for (const [roomId, room] of rooms) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          broadcast(room);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Test with: http://localhost:${PORT}`);
});
