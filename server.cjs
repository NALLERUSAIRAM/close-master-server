// =================================================================
// CLOSE MASTER POWER RUMMY - COMPLETE PROFESSIONAL SERVER
// All Rules: Draw/Drop, J-Skip, 7-Draw, Open Card Match, Close
// =================================================================

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

// Express setup
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
}));

app.get("/", (req, res) => {
  res.json({
    status: "🚀 Close Master POWER RUMMY Server Active",
    rules: "Draw→Drop, J-Skip, 7-Draw, Open Match, Close",
    version: "2.0 - All Rules Fixed"
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ========================================
// GAME CONSTANTS & UTILITIES
// ========================================
const MAX_PLAYERS = 7;
const START_CARDS = 13; // Standard Rummy
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
let globalCardId = Date.now();

const rooms = new Map();

// Card value calculation
function cardValue(rank) {
  const valueMap = {
    "A": 1, "J": 10, "Q": 10, "K": 10, "JOKER": 0
  };
  return valueMap[rank] || parseInt(rank) || 0;
}

// Create and shuffle full deck (52 cards + 2 jokers)
function createDeck() {
  const deck = [];
  
  // Standard 52 cards
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: globalCardId++,
        suit,
        rank,
        value: cardValue(rank)
      });
    }
  }
  
  // 2 Jokers
  for (let i = 0; i < 2; i++) {
    deck.push({
      id: globalCardId++,
      suit: null,
      rank: "JOKER",
      value: 0
    });
  }
  
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  
  return deck;
}

// Generate unique 4-char room ID
function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ========================================
// ROOM STATE MANAGEMENT
// ========================================
function roomStateFor(room, playerId) {
  const discardTop = room.discardPile[room.discardPile.length - 1] || null;
  const player = room.players.find(p => p.id === playerId);
  
  return {
    roomId: room.roomId,
    youId: playerId,
    hostId: room.hostId,
    started: room.started,
    closeCalled: room.closeCalled,
    currentIndex: room.currentIndex,
    turnId: room.turnId,
    discardTop,
    pendingDraw: room.pendingDraw || 0,
    pendingSkips: room.pendingSkips || 0,
    hasDrawn: player?.hasDrawn || false,
    // NEW RULE: Count matching open cards for direct drop
    matchingOpenCardCount: player ? player.hand.filter(c => c.rank === discardTop?.rank).length : 0,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name.substring(0, 12), // Truncate long names
      score: p.score,
      hand: p.id === playerId ? p.hand : [], // Only show own hand
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn
    })),
    log: room.log.slice(-15), // Last 15 log entries
    deckSize: room.drawPile?.length || 0,
    discardSize: room.discardPile.length
  };
}

function broadcastRoom(room) {
  if (!room || !room.players.length) return;
  room.players.forEach(player => {
    io.to(player.id).emit("game_state", roomStateFor(room, player.id));
  });
}

// Ensure draw pile has cards (reshuffle discard if empty)
function ensureDrawPile(room) {
  if (room.drawPile.length > 0) return true;
  if (room.discardPile.length <= 1) return false;
  
  const topCard = room.discardPile.pop();
  const shufflePile = room.discardPile;
  room.discardPile = [topCard];
  
  // Shuffle remaining discard pile
  for (let i = shufflePile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shufflePile[i], shufflePile[j]] = [shufflePile[j], shufflePile[i]];
  }
  
  room.drawPile = shufflePile;
  room.log.push("🔄 Deck reshuffled");
  return true;
}

// Set current turn by player index
function setTurnByIndex(room, index) {
  if (!room.players.length) return;
  const safeIndex = ((index % room.players.length) + room.players.length) % room.players.length;
  room.currentIndex = safeIndex;
  room.turnId = room.players[safeIndex].id;
  // Reset hasDrawn for all players
  room.players.forEach(p => p.hasDrawn = false);
  room.log.push(`🎯 Turn: ${room.players[safeIndex].name}`);
}

// Advance turn (with skip logic for J cards)
function advanceTurn(room) {
  if (!room.players.length) return;
  
  let currentIdx = room.players.findIndex(p => p.id === room.turnId);
  if (currentIdx === -1) currentIdx = 0;

  let steps = 1;
  
  // J RULE: Apply pending skips
  if (room.pendingSkips > 0) {
    steps += room.pendingSkips;
    room.pendingSkips = 0;
    room.log.push(`⏭️ ${room.players[currentIdx].name} skipped ${steps - 1} turn(s)`);
  }

  const nextIndex = (currentIdx + steps) % room.players.length;
  room.log.push(`➡️ Turn: ${room.players[currentIdx].name} → ${room.players[nextIndex].name}`);
  setTurnByIndex(room, nextIndex);
}

// Start new round
function startRound(room) {
  console.log(`🎮 Starting round in room ${room.roomId}`);
  
  // Reset game state
  room.drawPile = createDeck();
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;
  room.started = true;

  // Reset player hands and scores for new round
  room.players.forEach(p => {
    p.hand = [];
    p.hasDrawn = false;
    p.roundScore = 0; // Track per-round scoring
  });

  setTurnByIndex(room, 0);

  // Deal initial hands (13 cards each)
  for (let cardNum = 0; cardNum < START_CARDS; cardNum++) {
    room.players.forEach(player => {
      if (ensureDrawPile(room)) {
        const card = room.drawPile.pop();
        if (card) player.hand.push(card);
      }
    });
  }

  // Place first card face up
  if (ensureDrawPile(room)) {
    const firstCard = room.drawPile.pop();
    if (firstCard) {
      room.discardPile.push(firstCard);
      room.log.push(`🎴 Round started! Open: ${firstCard.rank}${firstCard.suit || ''}`);
      
      // Special first card rules
      if (firstCard.rank === "7") {
        room.pendingDraw = 2;
        room.log.push("🔢 Open 7 → First player draws 2 extra");
      } else if (firstCard.rank === "J") {
        room.pendingSkips = 1;
        room.log.push("⏭️ Open J → First player skipped");
      }
    }
  }
  
  broadcastRoom(room);
}

// ========================================
// SOCKET EVENT HANDLERS
// ========================================
io.on("connection", (socket) => {
  console.log(`🔌 Player connected: ${socket.id}`);

  // CREATE ROOM
  socket.on("create_room", (data, callback) => {
    console.log("🏠 CREATE ROOM request:", data);
    
    const name = (data?.name || "Player").toString().trim().substring(0, 15) || "Player";
    
    // Generate unique room ID
    let roomId;
    do {
      roomId = randomRoomId();
    } while (rooms.has(roomId));

    // Create room object
    const room = {
      roomId,
      hostId: socket.id,
      players: [{
        id: socket.id,
        name,
        score: 0,
        roundScore: 0,
        hand: [],
        hasDrawn: false
      }],
      started: false,
      drawPile: [],
      discardPile: [],
      currentIndex: 0,
      turnId: socket.id,
      pendingDraw: 0,
      pendingSkips: 0,
      closeCalled: false,
      log: [`🏠 ${name} created room ${roomId}`],
      createdAt: Date.now()
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    
    console.log(`✅ Room ${roomId} created by ${name} (${socket.id})`);
    
    // Send success response
    callback?.({ roomId, success: true, message: `Room ${roomId} created!` });
    broadcastRoom(room);
  });

  // JOIN ROOM
  socket.on("join_room", (data, callback) => {
    console.log("🚪 JOIN ROOM request:", data);
    
    const roomId = (data?.roomId || "").toString().trim().toUpperCase();
    const name = (data?.name || "Player").toString().trim().substring(0, 15) || "Player";

    if (!roomId) {
      callback?.({ error: "Room ID is required!" });
      return;
    }

    if (!rooms.has(roomId)) {
      callback?.({ error: `Room ${roomId} not found!` });
      return;
    }

    const room = rooms.get(roomId);
    
    // Validation checks
    if (room.players.length >= MAX_PLAYERS) {
      callback?.({ error: `Room full (${MAX_PLAYERS} players max)!` });
      return;
    }
    
    if (room.started) {
      callback?.({ error: "Game already started! Create new room." });
      return;
    }

    // Check for duplicate names (case-insensitive)
    const existingPlayer = room.players.find(p => 
      p.name.toLowerCase() === name.toLowerCase()
    );
    
    if (existingPlayer) {
      callback?.({ error: "Name already taken! Choose different name." });
      return;
    }

    // Add player
    const player = {
      id: socket.id,
      name,
      score: 0,
      roundScore: 0,
      hand: [],
      hasDrawn: false
    };
    
    room.players.push(player);
    socket.join(roomId);
    
    room.log.push(`🚪 ${name} joined (${room.players.length}/${MAX_PLAYERS})`);
    console.log(`✅ ${name} joined ${roomId} (${room.players.length}/${MAX_PLAYERS})`);
    
    callback?.({ roomId, success: true, playerCount: room.players.length });
    broadcastRoom(room);
  });

  // START ROUND (Host only)
  socket.on("start_round", (data) => {
    console.log("▶️ START ROUND request:", data);
    const roomId = data?.roomId;
    
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    if (room.hostId !== socket.id) {
      socket.emit("error", { message: "Only host can start game!" });
      return;
    }
    
    if (room.players.length < 2) {
      socket.emit("error", { message: "Minimum 2 players required!" });
      return;
    }
    
    startRound(room);
  });

  // DRAW CARD (Deck or Discard/Open)
  socket.on("action_draw", (data) => {
    console.log("📥 DRAW request:", data);
    const roomId = data?.roomId;
    
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    
    // Game state validation
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    if (player.hasDrawn) {
      socket.emit("error", { message: "Already drawn this turn!" });
      return;
    }

    const fromDiscard = data?.fromDiscard || false;
    let drawCount = Math.max(1, room.pendingDraw || 1);
    
    let drawnCards = 0;
    
    for (let i = 0; i < drawCount; i++) {
      let card = null;
      
      if (fromDiscard && room.discardPile.length > 0) {
        // Draw from open/discard pile
        card = room.discardPile.pop();
        room.log.push(`${player.name} drew ${card.rank}${card.suit || ''} (OPEN)`);
      } else {
        // Draw from closed deck
        if (ensureDrawPile(room)) {
          card = room.drawPile.pop();
          room.log.push(`${player.name} drew card`);
        }
      }
      
      if (card) {
        player.hand.push(card);
        drawnCards++;
      }
    }

    player.hasDrawn = true;
    room.pendingDraw = 0; // Reset penalty draws
    
    room.log.push(`✓ ${player.name} drew ${drawnCards} card(s)`);
    broadcastRoom(room);
  });

  // DROP CARDS (Same rank only)
  socket.on("action_drop", (data) => {
    console.log("🗑️ DROP request:", data);
    const roomId = data?.roomId;
    
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    
    // Game state validation
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    const cardIds = data?.selectedIds || [];
    if (!Array.isArray(cardIds) || cardIds.length === 0) return;
    
    // Filter selected cards from player's hand
    const selectedCards = player.hand.filter(card => cardIds.includes(card.id));
    if (selectedCards.length === 0) return;

    // RULE 1: All cards must be same rank
    const ranks = selectedCards.map(c => c.rank);
    const uniqueRanks = [...new Set(ranks)];
    if (uniqueRanks.length !== 1) {
      socket.emit("error", { message: "Select cards of SAME RANK only!" });
      return;
    }

    const dropRank = uniqueRanks[0];
    const openCard = room.discardPile[room.discardPile.length - 1];

    // NEW RULE: Allow drop without draw IF matching open card
    const canDropWithoutDraw = openCard && dropRank === openCard.rank;
    if (!player.hasDrawn && !canDropWithoutDraw) {
      socket.emit("error", { message: "Must DRAW first or match OPEN card!" });
      return;
    }

    // Execute drop
    player.hand = player.hand.filter(card => !cardIds.includes(card.id));
    selectedCards.forEach(card => room.discardPile.push(card));

    // Apply special rules based on rank
    if (dropRank === "J") {
      // J RULE: Skip next players
      room.pendingSkips += selectedCards.length;
      room.log.push(`🃏 ${player.name} dropped ${selectedCards.length}J → ${selectedCards.length} skip(s)`);
    } else if (dropRank === "7") {
      // 7 RULE: Next player draws extra cards
      room.pendingDraw += 2 * selectedCards.length;
      room.log.push(`7️⃣ ${player.name} dropped ${selectedCards.length}7 → +${2 * selectedCards.length} draw`);
    } else {
      room.log.push(`🗑️ ${player.name} dropped ${selectedCards.length} ${dropRank}`);
    }

    // Reset hasDrawn and advance turn
    player.hasDrawn = false;
    advanceTurn(room);
    broadcastRoom(room);
  });

  // CALL CLOSE (End round)
  socket.on("action_close", (data) => {
    console.log("❌ CLOSE request:", data);
    const roomId = data?.roomId;
    
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    
    if (!room.started || room.closeCalled) return;
    if (socket.id !== room.turnId) return;
    
    const player = room.players.find(p => p.id === socket.id);
    
    room.closeCalled = true;
    room.log.push(`🏁 ${player.name} called CLOSE!`);
    
    // Calculate final scores (sum card values)
    room.players.forEach(p => {
      p.roundScore = p.hand.reduce((sum, card) => sum + card.value, 0);
      p.score += p.roundScore;
    });
    
    // Sort by lowest score (winner has least points)
    const sortedPlayers = [...room.players].sort((a, b) => a.roundScore - b.roundScore);
    room.log.push(`🥇 Winner: ${sortedPlayers[0].name} (${sortedPlayers[0].roundScore} pts)`);
    
    broadcastRoom(room);
  });

  // DISCONNECT HANDLING
  socket.on("disconnect", (reason) => {
    console.log(`🔌 ${socket.id} disconnected (${reason})`);
    
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const playerName = room.players[playerIndex].name;
        room.players.splice(playerIndex, 1);
        room.log.push(`👋 ${playerName} left`);
        
        // Delete empty room
        if (room.players.length === 0) {
          console.log(`🗑️ Empty room ${roomId} deleted`);
          rooms.delete(roomId);
          break;
        }
        
        // Transfer host if needed
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id;
          room.log.push(`👑 New host: ${room.players[0].name}`);
        }
        
        // Fix turn if current player left
        if (room.turnId === socket.id) {
          setTurnByIndex(room, 0);
        }
        
        broadcastRoom(room);
        break;
      }
    }
  });
});

// Server startup
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Close Master POWER RUMMY Server`);
  console.log(`📍 Running on port ${PORT}`);
  console.log(`🌐 All rules active: Draw/Drop/J-Skip/7-Draw/Open-Match/Close\n`);
});
