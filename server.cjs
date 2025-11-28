const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MAX_PLAYERS = 7;
const START_CARDS = 7;  // ✅ Your Rule #2
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["♠","♥","♦","♣"];
let globalCardId = 1;

function cardValue(r) {
  if (r === "JOKER") return 0;
  if (["J","Q","K"].includes(r)) return 10;
  if (r === "A") return 1;
  return parseInt(r);  // ✅ 2=2,3=3,...,10=10
}

function createDeck() {
  const deck = [];
  for (let suit of SUITS) for (let rank of RANKS) deck.push({id:globalCardId++,rank,suit});
  deck.push({id:globalCardId++,rank:"JOKER",suit:""}); // 2 jokers
  deck.push({id:globalCardId++,rank:"JOKER",suit:""});
  return deck.sort(()=>Math.random()-0.5);
}

const rooms = new Map();

io.on("connection", (socket) => {
  console.log(`[Socket] ${socket.id}`);

  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substr(2,4).toUpperCase();
    const room = {
      roomId, deck: createDeck(), discardPile: [],
      players: [{id:socket.id,name:data.name,hand:[],score:0}],
      turnIndex: 0, currentPlayerId: socket.id, hasDrawn: false,
      started: false, roundActive: false, closeCalled: false
    };
    socket.join(roomId); rooms.set(roomId, room);
    socket.emit("room_created", {room, players: room.players});
  });

  socket.on("join_room", (data) => {
    const room = rooms.get(data.roomId);
    if (!room || room.players.length>=MAX_PLAYERS || room.started) 
      return socket.emit("error", "Cannot join!");
    const player = {id:socket.id,name:data.name,hand:[],score:0};
    room.players.push(player); socket.join(data.roomId);
    io.to(data.roomId).emit("player_joined", room.players);
    socket.emit("room_joined", {room, players: room.players});
  });

  socket.on("start_game", () => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room || room.players.length<2) return;
    
    room.started = true;
    room.players.forEach(p => p.hand = room.deck.splice(0, START_CARDS)); // ✅ 7 cards
    room.discardPile.unshift(room.deck.pop()); // ✅ 1st open card
    room.turnIndex = 0; room.currentPlayerId = room.players[0].id;
    room.hasDrawn = false; room.roundActive = true;
    
    io.to(roomId).emit("game_update", room); // ✅ HOST + ALL players
    console.log(`[START] ${roomId} - ${room.players.length} players`);
  });

  // ✅ PHASE 1: DRAW (Rule #3)
  socket.on("action_draw", (data) => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room?.roundActive || socket.id !== room.currentPlayerId || room.hasDrawn) return;
    
    let card;
    if (data.fromDiscard && room.discardPile[0] && !room.discardPile[0].rank?.match(/7|J/)) {
      card = room.discardPile.shift();
    } else if (room.deck.length) {
      card = room.deck.pop();
    }
    
    if (card) {
      const player = room.players.find(p=>p.id===socket.id);
      player.hand.push(card);
    }
    room.hasDrawn = true; // ✅ PHASE 2 ready
    
    io.to(roomId).emit("game_update", room);
  });

  // ✅ PHASE 2: DROP (Rule #3)
  socket.on("action_drop", (data) => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room?.roundActive || socket.id !== room.currentPlayerId || !room.hasDrawn || !data.selectedIds?.length) return;
    
    const player = room.players.find(p=>p.id===socket.id);
    const dropped = data.selectedIds.map(id=>player.hand.find(c=>c.id===parseInt(id))).filter(Boolean);
    
    dropped.forEach(card => {
      room.discardPile.unshift(card);
      player.hand = player.hand.filter(c=>c.id!==card.id);
    });

    // ✅ SPECIAL CARDS (Rule #4)
    const topCard = room.discardPile[0];
    if (topCard.rank === "7") {
      // Next player draws 2 + skip
      const nextIdx = (room.turnIndex + 1) % room.players.length;
      const nextPlayer = room.players[nextIdx];
      for(let i=0; i<2 && room.deck.length; i++) nextPlayer.hand.push(room.deck.pop());
      room.turnIndex = (nextIdx + 1) % room.players.length;
    } else if (topCard.rank === "J") {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    } else {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    }
    
    room.currentPlayerId = room.players[room.turnIndex].id;
    room.hasDrawn = false;
    
    io.to(roomId).emit("game_update", room);
  });

  // ✅ CLOSE (Rule #5) - ONLY BEFORE DRAW
  socket.on("action_close", () => {
    const roomId = Array.from(socket.rooms)[1];
    const room = rooms.get(roomId);
    if (!room?.roundActive || socket.id !== room.currentPlayerId || room.hasDrawn) 
      return socket.emit("error", "Draw first!");
    
    room.roundActive = false;
    room.players.forEach(p => p.score = p.hand.reduce((sum,c)=>sum+cardValue(c.rank),0));
    
    // Find lowest score
    const scores = room.players.map(p=>p.score);
    const minScore = Math.min(...scores);
    const closePlayerScore = room.players.find(p=>p.id===socket.id).score;
    
    if (closePlayerScore === minScore) {
      room.players.find(p=>p.id===socket.id).score = 0; // ✅ WINNER 0 points
    } else {
      // Penalty: highest gets double
      const maxScore = Math.max(...scores);
      room.players.find(p=>p.score===maxScore).score *= 2;
    }
    
    io.to(roomId).emit("game_ended", room.players);
    console.log(`[CLOSE] Round ended!`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 CLOSE MASTER on ${PORT}`));
