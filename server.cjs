// ---------------------------
// Close Master Server - Compact & Explained
// ---------------------------

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

// Initialize Express app with CORS allowing all origins (for demo)
const app = express();
app.use(cors());
const server = http.createServer(app);

// Initialize Socket.io with CORS enabled
const io = new Server(server, { cors: { origin: "*" } });

// Constants
const MAX_PLAYERS = 7;
const START_CARDS = 7; // Deal 7 cards per player
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];
let globalCardId = 1; // Unique card ID generator

// Function to calculate card values
function cardValue(rank) {
  if(rank === "A") return 1;
  if(rank === "JOKER") return 0;
  if(["J","Q","K"].includes(rank)) return 10;
  return parseInt(rank) || 0;
}

// Create a shuffled deck including jokers
function createDeck() {
  const deck = [];
  for(const suit of SUITS) {
    for(const rank of RANKS) {
      deck.push({ id: globalCardId++, suit, rank, value: cardValue(rank) });
    }
  }
  // Add two jokers
  deck.push({ id: globalCardId++, suit: null, rank: "JOKER", value: 0 });
  deck.push({ id: globalCardId++, suit: null, rank: "JOKER", value: 0 });

  // Fisher-Yates shuffle algorithm
  for(let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Store all rooms keyed by their room ID
const rooms = new Map();

// Prepare room state to send to each player (hand hidden except for self)
function roomStateFor(room, playerId) {
  const discardTop = room.discardPile.length ? room.discardPile[room.discardPile.length-1] : null;
  const player = room.players.find(p => p.id === playerId);

  return {
    roomId: room.roomId,
    hostId: room.hostId,
    youId: playerId,
    started: room.started,
    closeCalled: room.closeCalled,
    currentIndex: room.currentIndex,
    turnId: room.turnId,
    discardTop,
    pendingDraw: room.pendingDraw,
    pendingSkips: room.pendingSkips,
    hasDrawn: player?.hasDrawn || false,
    matchingOpenCardCount: player ? player.hand.filter(c => c.rank === discardTop?.rank).length : 0,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hand: p.id === playerId ? p.hand : [],
      handSize: p.hand.length,
      hasDrawn: p.hasDrawn,
    })),
    log: room.log.slice(-20),
  };
}

// Send updated game state to all players in a room
function broadcast(room) {
  room.players.forEach(p => io.to(p.id).emit("game_state", roomStateFor(room, p.id)));
}

// Generate a unique 4-character room ID
function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let id = "";
  for(let i=0; i<4; i++) id += chars.charAt(Math.floor(Math.random()*chars.length));
  return id;
}

// Ensure the draw pile is not empty by reshuffling the discard pile (except top)
function ensureDrawPile(room) {
  if(room.drawPile.length > 0) return;
  if(room.discardPile.length <= 1) return;

  const topCard = room.discardPile.pop();
  let pile = room.discardPile;
  room.discardPile = [topCard];

  for(let i = pile.length -1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  room.drawPile = pile;
}

// Set current turn based on player index
function setTurnByIndex(room, index) {
  if(room.players.length === 0) return;
  room.currentIndex = ((index % room.players.length) + room.players.length) % room.players.length;
  room.turnId = room.players[room.currentIndex].id;
  room.players.forEach(p => p.hasDrawn = false);
}

// Advance turn, applying skip if any
function advanceTurn(room) {
  if(room.players.length === 0) return;
  let idx = room.players.findIndex(p => p.id === room.turnId);
  if(idx === -1) idx = 0;

  let steps = 1;
  if(room.pendingSkips > 0) {
    steps += room.pendingSkips;
    room.pendingSkips = 0;
  }

  let nextIndex = (idx + steps) % room.players.length;
  room.log.push(`Turn: ${room.players[idx].name} → ${room.players[nextIndex].name}`);
  setTurnByIndex(room, nextIndex);
}

// Start a new game round
function startRound(room) {
  room.drawPile = createDeck();
  room.discardPile = [];
  room.pendingDraw = 0;
  room.pendingSkips = 0;
  room.closeCalled = false;
  room.started = true;

  room.players.forEach(player => {
    player.hand = [];
    player.hasDrawn = false;
  });

  setTurnByIndex(room, 0);

  // Deal START_CARDS cards to each player
  for(let i =0; i < START_CARDS; i++){
    room.players.forEach(player => {
      ensureDrawPile(room);
      const card = room.drawPile.pop();
      if(card) player.hand.push(card);
    });
  }

  ensureDrawPile(room);
  const firstCard = room.drawPile.pop();
  if(firstCard){
    room.discardPile.push(firstCard);
    room.log.push(`Round started! Open card: ${firstCard.rank}${firstCard.suit || ""}`);

    if(firstCard.rank === "7"){
      room.pendingDraw = 2;
      room.log.push("Open card 7 → Next player must draw 2");
    } else if(firstCard.rank === "J"){
      room.pendingSkips = 1;
      room.log.push("Open card J → Next player skip turn");
    }
  }

  broadcast(room);
}

// Socket.io event handling
io.on("connection", socket => {
  console.log(`New player connected: ${socket.id}`);

  // Create Room
  socket.on("create_room", (data, callback) => {
    const name = (data?.name || "Player").trim().slice(0,15) || "Player";
    if(!name){
      callback?.({error:"Name Required"});
      return;
    }

    let roomId;
    do {
      roomId = randomRoomId();
    } while(rooms.has(roomId));

    const room = {
      roomId,
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0, hand: [], hasDrawn: false}],
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
    room.log.push(`${name} created room ${roomId}`);
    console.log(`Room created: ${roomId} by ${name}`);

    callback?.({ roomId, success: true });
    broadcast(room);
  });

  // Join Room
  socket.on("join_room", (data, callback) => {
    const roomId = (data?.roomId || "").trim().toUpperCase();
    const name = (data?.name || "Player").trim().slice(0,15) || "Player";

    if(!roomId){
      callback?.({ error: "Room ID required" });
      return;
    }
    if(!rooms.has(roomId)){
      callback?.({ error: `Room ${roomId} not found` });
      return;
    }

    const room = rooms.get(roomId);
    if(room.players.length >= MAX_PLAYERS){
      callback?.({ error: "Room full" });
      return;
    }
    if(room.started){
      callback?.({ error: "Game already started" });
      return;
    }

    // Add player
    room.players.push({ id: socket.id, name, score: 0, hand: [], hasDrawn: false});
    socket.join(roomId);
    room.log.push(`${name} joined the room`);

    callback?.({ roomId, success: true });
    broadcast(room);
  });

  // Start Round (Host only)
  socket.on("start_round", data => {
    const roomId = data?.roomId;
    if(!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if(room.hostId !== socket.id){
      socket.emit("error",{ message:"Only host can start the game"});
      return;
    }
    if(room.players.length < 2){
      socket.emit("error",{ message:"At least 2 players needed"});
      return;
    }

    startRound(room);
  });

  // Draw card
  socket.on("action_draw", data => {
    const roomId = data?.roomId;
    if(!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if(!room.started || room.closeCalled || socket.id !== room.turnId) return;

    const player = room.players.find(p => p.id === socket.id);
    if(!player || player.hasDrawn) return;

    const count = room.pendingDraw > 0 ? room.pendingDraw : 1;
    const fromDiscard = data?.fromDiscard || false;

    for(let i=0; iunt; i++){
      let card;
      if(fromDiscard && room.discardPile.length >0){
        card = room.discardPile.pop();
      } else {
        ensureDrawPile(room);
        card = room.drawPile.pop();
      }
      if(card) player.hand.push(card);
    }
    player.hasDrawn = true;
    room.pendingDraw = 0;
    broadcast(room);
  });

  // Drop cards
  socket.on("action_drop", data => {
    const roomId = data?.roomId;
    if(!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if(!room.started || room.closeCalled || socket.id !== room.turnId) return;

    const player = room.players.find(p => p.id === socket.id);
    const selectedIds = data?.selectedIds || [];
    const selectedCards = player.hand.filter(c => selectedIds.includes(c.id));

    if(selectedCards.length === 0) return;

    // All cards must have the same rank
    const ranks = [...new Set(selectedCards.map(c => c.rank))];
    if(ranks.length !== 1) {
      socket.emit("error", { message: "Select cards of the same rank only!" });
      return;
    }

    const openCard = room.discardPile[room.discardPile.length-1];
    const canDropWithoutDraw = openCard && ranks[0] === openCard.rank;

    if(!player.hasDrawn && !canDropWithoutDraw){
      socket.emit("error", { message: "Draw first or match open card rank!" });
      return;
    }

    // Remove cards from hand and add to discard pile
    player.hand = player.hand.filter(c => !selectedIds.includes(c.id));
    selectedCards.forEach(c => room.discardPile.push(c));

    const rank = ranks[0];

    // Apply special rules for J and 7
    if(rank === "J"){
      room.pendingSkips += selectedCards.length;
      room.log.push(`${player.name} dropped ${selectedCards.length}J - skipping next players`);
    } else if(rank === "7"){
      room.pendingDraw += 2 * selectedCards.length;
      room.log.push(`${player.name} dropped ${selectedCards.length}7 - next draws`);
    }
    
    player.hasDrawn = false;
    advanceTurn(room);
    broadcast(room);
  });

  // Close game scoring with corrected logic
  socket.on("action_close", data => {
    const roomId = data?.roomId;
    if(!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if(!room.started || room.closeCalled || socket.id !== room.turnId) return;

    room.closeCalled = true;

    const closer = room.players.find(p => p.id === socket.id);
    const closerPts = closer ? closer.hand.reduce((s,c) => s+c.value, 0) : 0;

    room.players.forEach(player => {
      const pts = player.hand.reduce((s,c) => s+c.value, 0);
      if(player.id === socket.id || pts < closerPts){
        player.score = 0;  // CLOSE or LOST players get 0
      } else {
        player.score = pts * 2; // Others double points
      }
    });

    room.log.push(`🏁 ${closer?.name} called CLOSE with ${closerPts} pts`);
    broadcast(room);
  });

  // Player disconnect handling
  socket.on("disconnect", () => {
    for(const [roomId, room] of rooms){
      const idx = room.players.findIndex(p => p.id === socket.id);
      if(idx !== -1){
        const name = room.players[idx].name;
        room.players.splice(idx,1);
        room.log.push(`${name} left`);

        if(room.players.length === 0){
          rooms.delete(roomId);
          break;
        }

        if(room.hostId === socket.id){
          room.hostId = room.players[0].id;
          room.log.push(`New host: ${room.players[0].name}`);
        }

        if(room.turnId === socket.id){
          setTurnByIndex(room, 0);
        }

        broadcast(room);
        break;
      }
    }
  });
});

// Server listen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Close Master server running on port ${PORT}`));
