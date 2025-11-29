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
  if (r === "A") return 1;
  if (r === "J") return 11;
  if (r === "Q") return 12;
  if (r === "K") return 13;
  return parseInt(r);
}

const rooms = new Map();

function createDeck() {
  const deck = [];
  for (let suit of SUITS) {
    for (let rank of RANKS) {
      deck.push({ id: globalCardId++, rank, suit, globalId: globalCardId - 1 });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function ensureDrawPile(room) {
  while (room.drawPile.length < 10) {
    if (room.usedPile.length === 0) {
      room.drawPile.push(...shuffle(createDeck()));
      room.log.push("New deck!");
    } else {
      room.drawPile.push(...shuffle(room.usedPile));
      room.usedPile = [];
    }
  }
}

function broadcast(room) {
  io.to(room.id).emit("game_state", room);
}

function findPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function setTurnByIndex(room, index) {
  room.turnIndex = index;
  room.turnId = room.players[index]?.id || null;
}

function nextTurn(room) {
  if (!room.players.length) return;
  
  const currentIndex = room.players.findIndex(p => p.id === room.turnId);
  let nextIndex = (currentIndex + 1) % room.players.length;
  
  while (nextIndex !== currentIndex && room.players[nextIndex]?.folded) {
    nextIndex = (nextIndex + 1) % room.players.length;
  }
  
  setTurnByIndex(room, nextIndex);
}

function allFoldedExceptOne(room) {
  const activePlayers = room.players.filter(p => !p.folded);
  return activePlayers.length <= 1;
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substr(2, 4).toUpperCase();
    rooms.set(roomId, {
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
      pendingDraw: 0,
      pendingSkips: 0
    });
    
    socket.join(roomId);
    socket.emit("room_created", { roomId });
    console.log(`Room created: ${roomId}`);
  });

  socket.on("join_room", (data) => {
    const roomId = (data?.roomId || "").trim().toUpperCase();
    console.log(`JOIN REQ: ${roomId} from ${data.name}`);
    
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("error", "Room not found");
      return;
    }
    
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("error", "Room full");
      return;
    }
    
    if (room.players.some(p => p.name.toLowerCase() === data.name.toLowerCase())) {
      socket.emit("error", "Name already exists");
      return;
    }
    
    const player = { id: socket.id, name: data.name, hand: [], score: 0, hasDrawn: false, folded: false };
    room.players.push(player);
    socket.join(roomId);
    
    room.log.push(`${data.name} joined. Players: ${room.players.length}/${MAX_PLAYERS}`);
    
    if (!room.players.length) {
      rooms.delete(roomId);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.log.push(`New host: ${room.players[0].name}`);
    }

    if (!room.players.some((p) => p.id === room.turnId)) {
      setTurnByIndex(room, 0);
    }

    broadcast(room);
  });

  socket.on("start_game", () => {
    const room = Array.from(rooms.values()).find(r => r.hostId === socket.id && !r.started);
    if (!room) return;

    room.started = true;
    room.players.forEach(p => {
      p.hand = [];
      p.score = 0;
      p.hasDrawn = false;
      p.folded = false;
    });
    room.roundScores = {};
    room.log = ["New round started!"];
    room.pendingDraw = 0;
    room.pendingSkips = 0;
    room.drawPile = shuffle(createDeck());
    room.discardPile = [];
    room.usedPile = [];

    room.players.forEach(p => {
      for (let i = 0; i < START_CARDS; i++) {
        const card = room.drawPile.pop();
        if (card) p.hand.push(card);
      }
    });

    ensureDrawPile(room);
    const firstCard = room.drawPile.pop();
    if (firstCard) {
      room.discardPile.push(firstCard);
      room.log.push(`Round started! Open: ${firstCard.rank}${firstCard.suit || ""}`);
      if (firstCard.rank === "7") room.pendingDraw = 2;
      else if (firstCard.rank === "J") room.pendingSkips = 1;
    }

    setTurnByIndex(room, 0);
    broadcast(room);
  });

  socket.on("action_draw", () => {
    const room = Array.from(rooms.values()).find(r => r.turnId === socket.id);
    if (!room || room.pendingDraw > 0) return;

    const player = findPlayer(room, socket.id);
    if (!player || player.hasDrawn) return;

    ensureDrawPile(room);
    const card = room.drawPile.pop();
    if (card) {
      player.hand.push(card);
      player.hasDrawn = true;
      room.log.push(`${player.name} drew a card`);
    }

    nextTurn(room);
    broadcast(room);
  });

  socket.on("action_drop", (data) => {
    const room = Array.from(rooms.values()).find(r => r.turnId === socket.id);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    const selectedCards = player.hand.filter(c => data.selectedIds.includes(c.id));
    if (selectedCards.length === 0) return;

    const openCard = room.discardPile[room.discardPile.length - 1];
    let canDropWithoutDraw = false;

    // Rule 1: Same rank as open card (any count: 1,2,3+)
    const matchingOpenCardCount = selectedCards.filter(c => c.rank === openCard?.rank).length;
    if (matchingOpenCardCount > 0) {
      canDropWithoutDraw = true;
    }
    // Rule 2: 3+ same rank cards (regardless of open card)
    else if (selectedCards.length >= 3) {
      const rankCounts = {};
      selectedCards.forEach(c => {
        rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1;
      });
      if (Object.values(rankCounts).some(count => count >= 3)) {
        canDropWithoutDraw = true;
      }
    }

    const allowDrop = selectedCards.length > 0 && (player.hasDrawn || canDropWithoutDraw);
    if (!allowDrop) return;

    // Remove selected cards
    player.hand = player.hand.filter(c => !data.selectedIds.includes(c.id));
    
    // Add to discard pile
    room.discardPile.push(...selectedCards);
    
    room.log.push(`${player.name} dropped ${selectedCards.length} cards`);
    
    // Check if all folded except one
    if (allFoldedExceptOne(room)) {
      room.log.push("Round closed - only one active player");
      room.players.forEach(p => {
        if (!p.folded) {
          room.roundScores[p.id] = p.score;
        }
      });
      room.started = false;
    } else {
      nextTurn(room);
    }

    player.hasDrawn = true;
    broadcast(room);
  });

  socket.on("action_close", () => {
    const room = Array.from(rooms.values()).find(r => r.turnId === socket.id);
    if (!room || !room.started) return;

    const player = findPlayer(room, socket.id);
    if (!player) return;

    room.roundScores[player.id] = player.score;
    room.log.push(`${player.name} closed the round`);
    room.started = false;

    broadcast(room);
  });

  socket.on("action_fold", () => {
    const room = Array.from(rooms.values()).find(r => r.turnId === socket.id);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (!player || player.folded) return;

    player.folded = true;
    room.log.push(`${player.name} folded`);

    if (allFoldedExceptOne(room)) {
      room.log.push("Round closed - all folded");
      room.players.forEach(p => {
        if (!p.folded) {
          room.roundScores[p.id] = p.score;
        }
      });
      room.started = false;
    } else {
      nextTurn(room);
    }

    broadcast(room);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        room.log.push(`Player left. Players: ${room.players.length}/${MAX_PLAYERS}`);
        
        if (!room.players.length) {
          rooms.delete(roomId);
          break;
        }

        if (room.hostId === socket.id) {
          room.hostId = room.players[0]?.id;
          room.log.push(`New host: ${room.players[0]?.name}`);
        }

        if (!room.players.some((p) => p.id === room.turnId)) {
          setTurnByIndex(room, 0);
        }

        broadcast(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
