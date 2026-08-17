const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (req, res) => res.status(200).send("Gully Cards Server is Running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["polling", "websocket"]
});

const TURN_TIME_LIMIT = 30;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

const cardValue = r => (r === "A" ? 1 : r === "JOKER" ? 0 : ["J", "Q", "K"].includes(r) ? 10 : parseInt(r) || 0);

const createDeck = () => {
  let deck = [];
  let id = Date.now();
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ id: id++, suit: s, rank: r, value: cardValue(r) })));
  deck.push({ id: id++, rank: "JOKER", suit: "🃏", value: 0 }, { id: id++, rank: "JOKER", suit: "🃏", value: 0 });
  return deck.sort(() => Math.random() - 0.5);
};

const rooms = new Map();

const startTurnTimer = (room) => {
  if (room.timer) clearInterval(room.timer);
  room.turnTimeLeft = TURN_TIME_LIMIT;
  room.timer = setInterval(() => {
    room.turnTimeLeft--;
    io.to(room.roomId).emit("timer_tick", { turnTimeLeft: room.turnTimeLeft, turnId: room.turnId });
    if (room.turnTimeLeft <= 0) {
      clearInterval(room.timer);
      handleTimeout(room);
    }
  }, 1000);
};

const handleTimeout = (room) => {
  const currentP = room.players.find(p => p.id === room.turnId);
  if (!currentP) return;

  if (!currentP.hasDrawn) {
    const take = room.penaltyCount > 0 ? room.penaltyCount : 1;
    for (let i = 0; i < take; i++) {
      if (room.drawPile.length === 0 && room.discardPile.length > 1) {
        const top = room.discardPile.pop();
        room.drawPile = room.discardPile.sort(() => Math.random() - 0.5);
        room.discardPile = [top];
      }
      if (room.drawPile.length > 0) currentP.hand.push(room.drawPile.pop());
    }
    room.penaltyCount = 0;
  }

  if (room.gameType === "cards_show" && currentP.hand.length > 13) {
      const dropCard = currentP.hand.pop();
      room.discardPile.push(dropCard);
  }

  currentP.hasDrawn = false;
  room.currentIndex = (room.currentIndex + 1) % room.players.length;
  room.turnId = room.players[room.currentIndex].id;
  startTurnTimer(room);
  broadcast(room);
};

const broadcast = (room) => {
  room.players.forEach(p => {
    io.to(p.socketId).emit("game_state", {
      roomId: room.roomId, gameType: room.gameType, hostId: room.hostId, youId: p.id, started: room.started,
      roundNumber: room.roundNumber, turnId: room.turnId, penaltyCount: room.penaltyCount,
      turnTimeLeft: room.turnTimeLeft || TURN_TIME_LIMIT,
      discardTop: room.discardPile[room.discardPile.length - 1] || null,
      roundHistory: room.roundHistory || [],
      players: room.players.map(pl => ({
        id: pl.id, name: pl.name, score: pl.score, handSize: pl.hand.length,
        hasDrawn: pl.hasDrawn, isOffline: pl.isOffline || false,
        lastRoundPoints: pl.lastRoundPoints || 0, hand: pl.id === p.id ? pl.hand : []
      }))
    });
  });
};

const calculateCardsShowPoints = (hand) => {
  const ranks = hand.map(c => c.rank);
  const nonJokers = ranks.filter(r => r !== "JOKER");
  const uniqueNonJokers = [...new Set(nonJokers)];
  let jokerCount = ranks.filter(r => r === "JOKER").length;

  const allRanks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  let missingRanks = allRanks.filter(r => !uniqueNonJokers.includes(r));
  let missingValues = missingRanks.map(r => cardValue(r)).sort((a, b) => b - a);

  while (jokerCount > 0 && missingValues.length > 0) {
      missingValues.shift(); 
      jokerCount--;
  }
  return missingValues.reduce((sum, val) => sum + val, 0);
};

io.on("connection", (socket) => {

  socket.on("create_room", (data, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      roomId,
      gameType: data.gameType || "close_master",
      hostId: data.playerId,
      players: [{ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [], isOffline: false }],
      started: false, roundNumber: 0, discardPile: [], roundHistory: [], penaltyCount: 0
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    if (cb) cb({ roomId });
    broadcast(room);
  });

  socket.on("join_room", (data, cb) => {
    const room = rooms.get(data.roomId);
    if (!room) return cb && cb({ error: "Room Not Found" });
    if (room.started) return cb && cb({ error: "Game already started!" });
    
    // MAX 7 PLAYERS CHECK
    const activeOnlinePlayers = room.players.filter(p => !p.isOffline);
    if (activeOnlinePlayers.length >= 7) {
      return cb && cb({ error: "Room is Full! Max 7 players allowed." });
    }

    const existingPlayer = room.players.find(p => p.id === data.playerId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.isOffline = false;
    } else {
      room.players.push({ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [], isOffline: false });
    }
    socket.join(data.roomId);
    if (cb) cb({ roomId: room.roomId });
    broadcast(room);
  });

  // START ROUND (MIN 2 & MAX 7 PLAYERS VALIDATION)
  socket.on("start_round", d => {
    const r = rooms.get(d.roomId);
    if (r) {
      const activePlayers = r.players.filter(p => !p.isOffline);
      
      // MIN 2 PLAYERS CHECK
      if (activePlayers.length < 2) {
        io.to(d.roomId).emit("show_error", "Need at least 2 players to start the game!");
        return;
      }
      
      // MAX 7 PLAYERS CHECK
      if (activePlayers.length > 7) {
        io.to(d.roomId).emit("show_error", "Maximum 7 players allowed per game!");
        return;
      }

      r.started = true; r.roundNumber++; r.penaltyCount = 0;
      r.drawPile = createDeck();
      r.discardPile = [r.drawPile.pop()];
      
      const startCards = r.gameType === "cards_show" ? 13 : 7;
      r.players.forEach(p => {
        p.hand = [];
        for (let i = 0; i < startCards; i++) p.hand.push(r.drawPile.pop());
        p.hasDrawn = false; p.lastRoundPoints = 0;
      });

      r.currentIndex = 0; r.turnId = r.players[0].id;
      startTurnTimer(r);
      broadcast(r);
    }
  });

  socket.on("action_draw", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (p && !p.hasDrawn && room.turnId === p.id) {
      if (data.fromDiscard) {
        p.hand.push(room.discardPile.pop());
      } else {
        const take = room.penaltyCount > 0 ? room.penaltyCount : 1;
        for (let i = 0; i < take; i++) {
          if (room.drawPile.length === 0 && room.discardPile.length > 1) {
            const top = room.discardPile.pop();
            room.drawPile = room.discardPile.sort(() => Math.random() - 0.5);
            room.discardPile = [top];
          }
          if (room.drawPile.length > 0) p.hand.push(room.drawPile.pop());
        }
        room.penaltyCount = 0;
      }
      p.hasDrawn = true;
      broadcast(room);
    }
  });

  socket.on("action_drop", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (p && p.id === room.turnId && p.hasDrawn) {
      const dropped = p.hand.filter(c => data.selectedIds.includes(c.id));
      if (dropped.length === 0) return;

      if (room.gameType === "cards_show") {
        if (dropped.length !== 1) return;
        room.discardPile.push(dropped[0]);
        p.hand = p.hand.filter(c => c.id !== dropped[0].id);
        room.currentIndex = (room.currentIndex + 1) % room.players.length;
        room.turnId = room.players[room.currentIndex].id;
        p.hasDrawn = false;
        startTurnTimer(room);
        broadcast(room);
      } else {
        const is3Same = dropped.length >= 3 && dropped.every(c => c.rank === dropped[0].rank);
        const isMatch = dropped.some(c => c.rank === room.discardPile[room.discardPile.length - 1]?.rank);
        if (!is3Same && !isMatch) return;

        room.discardPile.push(...dropped);
        p.hand = p.hand.filter(c => !data.selectedIds.includes(c.id));
        
        let skips = 1;
        dropped.forEach(c => {
          if (c.rank === "J") skips++;
          if (c.rank === "7") room.penaltyCount += 2;
        });

        room.currentIndex = (room.currentIndex + skips) % room.players.length;
        room.turnId = room.players[room.currentIndex].id;
        p.hasDrawn = false;
        startTurnTimer(room);
        broadcast(room);
      }
    }
  });

  socket.on("action_close", d => {
    const r = rooms.get(d.roomId);
    const p = r?.players.find(x => x.socketId === socket.id);
    if (r && p && r.gameType === "close_master") {
      if (r.timer) clearInterval(r.timer);
      const activePlayers = r.players.filter(pl => !pl.isOffline);
      const totals = activePlayers.map(pl => ({ id: pl.id, t: pl.hand.reduce((s, c) => s + c.value, 0) }));
      const lowest = Math.min(...totals.map(x => x.t));
      const highest = Math.max(...totals.map(x => x.t));
      const avgScore = Math.round(totals.reduce((sum, item) => sum + item.t, 0) / (activePlayers.length || 1));
      
      const roundPointsMap = {};
      r.players.forEach(pl => {
        let pts = pl.isOffline ? avgScore : ((pl.hand.reduce((s, c) => s + c.value, 0) === lowest) ? 0 : (pl.id === p.id ? highest * 2 : pl.hand.reduce((s, c) => s + c.value, 0)));
        pl.lastRoundPoints = pts; pl.score += pts; roundPointsMap[pl.name] = pts;
      });
      r.roundHistory.push({ round: r.roundNumber, points: roundPointsMap });
      r.started = false;
      io.to(r.roomId).emit("close_result", { winner: p.name });
      broadcast(r);
    }
  });

  socket.on("action_show_cards", data => {
    const r = rooms.get(data.roomId);
    const p = r?.players.find(x => x.socketId === socket.id);
    
    if (r && p && r.gameType === "cards_show" && p.hasDrawn) {
      if (data.selectedIds.length !== 1) {
         socket.emit("show_error", "Please select 1 card to discard for Show.");
         return;
      }
      
      const dropCard = p.hand.find(c => c.id === data.selectedIds[0]);
      const finalHand = p.hand.filter(c => c.id !== dropCard.id);
      const penalty = calculateCardsShowPoints(finalHand);
      
      if (penalty === 0) {
        if (r.timer) clearInterval(r.timer);
        r.discardPile.push(dropCard);
        p.hand = finalHand;

        const roundPointsMap = {};
        r.players.forEach(pl => {
          let pts = pl.id === p.id ? 0 : calculateCardsShowPoints(pl.hand);
          pl.lastRoundPoints = pts; pl.score += pts; roundPointsMap[pl.name] = pts;
        });

        r.roundHistory.push({ round: r.roundNumber, points: roundPointsMap });
        r.started = false;
        io.to(r.roomId).emit("close_result", { winner: p.name });
        broadcast(r);
      } else {
        socket.emit("show_error", "Invalid Hand! You don't have all 13 unique ranks.");
      }
    }
  });

  const handleDisconnect = (socket) => {
    rooms.forEach((room, roomId) => {
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) {
        p.isOffline = true;
        const activePlayers = room.players.filter(pl => !pl.isOffline);
        if (activePlayers.length === 0) {
          if (room.timer) clearInterval(room.timer);
          rooms.delete(roomId);
        } else {
          if (room.turnId === p.id && room.started) {
            room.currentIndex = (room.currentIndex + 1) % room.players.length;
            room.turnId = room.players[room.currentIndex].id;
            startTurnTimer(room);
          }
          broadcast(room);
        }
      }
    });
  };

  socket.on("exit_room", () => handleDisconnect(socket));
  socket.on("disconnect", () => handleDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Server Running on ${PORT}`));
