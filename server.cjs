const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (req, res) => res.status(200).send("Game Server is Running OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["polling", "websocket"]
});

const START_CARDS = 7;
const TURN_TIME_LIMIT = 30; // 30 Seconds turn time limit
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

// --- 30 SECONDS TURN TIMER LOGIC ---
const startTurnTimer = (room) => {
  if (room.timer) clearInterval(room.timer);
  room.turnTimeLeft = TURN_TIME_LIMIT;

  room.timer = setInterval(() => {
    room.turnTimeLeft--;
    
    // Broadcast remaining time to all clients
    io.to(room.roomId).emit("timer_tick", { turnTimeLeft: room.turnTimeLeft, turnId: room.turnId });

    if (room.turnTimeLeft <= 0) {
      clearInterval(room.timer);
      handleTimeout(room);
    }
  }, 1000);
};

// Turn time aipoyinappudu Auto Action (Draw 1 card & Pass Turn)
const handleTimeout = (room) => {
  const currentP = room.players.find(p => p.id === room.turnId);
  if (!currentP) return;

  // Auto Draw if not drawn
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

  // Next player ki turn pass
  currentP.hasDrawn = false;
  room.currentIndex = (room.currentIndex + 1) % room.players.length;
  room.turnId = room.players[room.currentIndex].id;
  
  startTurnTimer(room);
  broadcast(room);
};

const broadcast = (room) => {
  room.players.forEach(p => {
    io.to(p.socketId).emit("game_state", {
      roomId: room.roomId, hostId: room.hostId, youId: p.id, started: room.started,
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

const handleDisconnect = (socket) => {
  rooms.forEach((room, roomId) => {
    const p = room.players.find(x => x.socketId === socket.id);
    if (p) {
      p.isOffline = true; // Player ni ventane remove cheyakunda offline ga mark chesthunnam

      // Active players evaraina unnara check chestham
      const activePlayers = room.players.filter(pl => !pl.isOffline);
      if (activePlayers.length === 0) {
        if (room.timer) clearInterval(room.timer);
        rooms.delete(roomId);
      } else {
        // Disconnect ayina player turn nadusthunte turn skip chestham
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

io.on("connection", (socket) => {

  // CREATE ROOM
  socket.on("create_room", (data, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      roomId,
      hostId: data.playerId,
      players: [{ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [], isOffline: false }],
      started: false,
      roundNumber: 0,
      discardPile: [],
      roundHistory: [],
      penaltyCount: 0
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    if (cb) cb({ roomId });
    broadcast(room);
  });

  // JOIN ROOM (With Reconnect support)
  socket.on("join_room", (data, cb) => {
    const room = rooms.get(data.roomId);
    if (!room) return cb && cb({ error: "Room Not Found" });

    const existingPlayer = room.players.find(p => p.id === data.playerId);

    if (existingPlayer) {
      // RECONNECT LOGIC: Tab close chesi malli osthe old ID tho reconnect chestham
      existingPlayer.socketId = socket.id;
      existingPlayer.isOffline = false;
      socket.join(data.roomId);
      if (cb) cb({ roomId: room.roomId });
      broadcast(room);
    } else {
      // NEW PLAYER JOIN
      if (room.started) return cb && cb({ error: "Game already started! Wait for next game." });
      room.players.push({ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [], isOffline: false });
      socket.join(data.roomId);
      if (cb) cb({ roomId: room.roomId });
      broadcast(room);
    }
  });

  // START ROUND
  socket.on("start_round", d => {
    const r = rooms.get(d.roomId);
    if (r) {
      r.started = true;
      r.roundNumber++;
      r.penaltyCount = 0;
      r.drawPile = createDeck();
      r.discardPile = [r.drawPile.pop()];
      
      r.players.forEach(p => {
        p.hand = [];
        for (let i = 0; i < START_CARDS; i++) p.hand.push(r.drawPile.pop());
        p.hasDrawn = false;
        p.lastRoundPoints = 0;
      });

      r.currentIndex = 0;
      r.turnId = r.players[0].id;
      startTurnTimer(r);
      broadcast(r);
    }
  });

  // DRAW ACTION
  socket.on("action_draw", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (p && !p.hasDrawn && room.turnId === p.id) {
      if (data.fromDiscard) {
        const top = room.discardPile[room.discardPile.length - 1];
        if (top && top.rank !== "J" && top.rank !== "7") {
          p.hand.push(room.discardPile.pop());
          p.hasDrawn = true;
        }
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
        p.hasDrawn = true;
        room.penaltyCount = 0;
      }
      broadcast(room);
    }
  });

  // DROP ACTION
  socket.on("action_drop", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (p && p.id === room.turnId) {
      const dropped = p.hand.filter(c => data.selectedIds.includes(c.id));
      if (dropped.length === 0) return;
      const is3Same = dropped.length >= 3 && dropped.every(c => c.rank === dropped[0].rank);
      const isMatch = dropped.some(c => c.rank === room.discardPile[room.discardPile.length - 1]?.rank);
      if (!p.hasDrawn && !is3Same && !isMatch) return;

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
      
      startTurnTimer(room); // Reset 30s timer for next player turn
      broadcast(room);
    }
  });

  // CLOSE ACTION & MISSED ROUNDS AVERAGE SCORE CALCULATION
  socket.on("action_close", d => {
    const r = rooms.get(d.roomId);
    const p = r?.players.find(x => x.socketId === socket.id);
    if (r && p) {
      if (r.timer) clearInterval(r.timer);

      // Active (Online) players hand totals calculation
      const activePlayers = r.players.filter(pl => !pl.isOffline);
      const totals = activePlayers.map(pl => ({ id: pl.id, t: pl.hand.reduce((s, c) => s + c.value, 0) }));
      
      const lowest = Math.min(...totals.map(x => x.t));
      const highest = Math.max(...totals.map(x => x.t));

      // Calculate Average Points of active players for missed/offline players
      const sumActiveScores = totals.reduce((sum, item) => sum + item.t, 0);
      const avgScore = Math.round(sumActiveScores / (activePlayers.length || 1));

      const roundPointsMap = {};

      r.players.forEach(pl => {
        let pts = 0;
        if (pl.isOffline) {
          // Offline / Missed player gets average score of this round (0 padakunda)
          pts = avgScore;
        } else {
          const total = pl.hand.reduce((s, c) => s + c.value, 0);
          pts = (total === lowest) ? 0 : (pl.id === p.id ? highest * 2 : total);
        }
        pl.lastRoundPoints = pts;
        pl.score += pts;
        roundPointsMap[pl.name] = pts;
      });

      r.roundHistory.push({ round: r.roundNumber, points: roundPointsMap });
      r.started = false;

      io.to(r.roomId).emit("close_result", { winner: p.name });
      broadcast(r);
    }
  });

  socket.on("exit_room", () => handleDisconnect(socket));
  socket.on("disconnect", () => handleDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`Server Running on ${PORT}`));
