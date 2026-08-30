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

const TURN_TIME_LIMIT = 90; // 90 Seconds Timer
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const cardValue = r => (r === "A" ? 1 : r === "JOKER" ? 0 : ["J", "Q", "K"].includes(r) ? 10 : parseInt(r) || 0);

const createDeck = () => {
  let deck = [];
  let id = Date.now();
  for (let r = 1; r <= 13; r++) {
    for (let i = 0; i < 4; i++) {
      let rankStr = r === 1 ? "A" : r === 11 ? "J" : r === 12 ? "Q" : r === 13 ? "K" : r.toString();
      deck.push({ id: id++, rank: rankStr, value: cardValue(rankStr) });
    }
  }
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
    if (room.drawPile.length === 0 && room.discardPile.length > 1) {
      const top = room.discardPile.pop();
      room.drawPile = room.discardPile.sort(() => Math.random() - 0.5);
      room.discardPile = [top];
    }
    if (room.drawPile.length > 0) currentP.hand.push(room.drawPile.pop());
  }

  const maxHandSize = room.gameType === 'close_master' ? 8 : 14;
  if (currentP.hand.length > maxHandSize) {
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
      roundNumber: room.roundNumber, turnId: room.turnId,
      turnTimeLeft: room.turnTimeLeft || TURN_TIME_LIMIT,
      discardTop: room.discardPile[room.discardPile.length - 1] || null,
      roundHistory: room.roundHistory || [],
      penaltyCount: room.penaltyCount || 0,
      players: room.players.map(pl => ({
        id: pl.id, name: pl.name, score: pl.score, handSize: pl.hand.length,
        hasDrawn: pl.hasDrawn, isOffline: pl.isOffline || false,
        lastRoundPoints: pl.lastRoundPoints || 0,
        bonusCard: pl.id === p.id ? pl.bonusCard : (pl.bonusUnlocked ? pl.bonusCard : null),
        bonusUnlocked: pl.bonusUnlocked || false,
        hand: pl.id === p.id ? pl.hand : []
      }))
    });
  });
};

io.on("connection", (socket) => {

  socket.on("create_room", (data, cb) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const room = {
      roomId,
      gameType: data.gameType || "close_master",
      hostId: data.playerId,
      players: [{ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [], bonusCard: null, bonusUnlocked: false, isOffline: false }],
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
    
    const activeOnlinePlayers = room.players.filter(p => !p.isOffline);
    if (activeOnlinePlayers.length >= 7) return cb && cb({ error: "Room is Full! Max 7 players." });

    const existingPlayer = room.players.find(p => p.id === data.playerId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.isOffline = false;
    } else {
      room.players.push({ id: data.playerId, socketId: socket.id, name: data.name, score: 0, hand: [], bonusCard: null, bonusUnlocked: false, isOffline: false });
    }
    socket.join(data.roomId);
    if (cb) cb({ roomId: room.roomId });
    broadcast(room);
  });

  socket.on("start_round", d => {
    const r = rooms.get(d.roomId);
    if (r) {
      const activePlayers = r.players.filter(p => !p.isOffline);
      if (activePlayers.length < 2) {
        io.to(d.roomId).emit("show_error", "Need at least 2 players to start!");
        return;
      }

      r.started = true; r.roundNumber++;
      r.drawPile = createDeck();
      let initialCard = r.drawPile.pop();
      r.discardPile = [initialCard];
      r.penaltyCount = 0;

      const startCards = r.gameType === 'close_master' ? 7 : 13;
      r.players.forEach(p => {
        p.hand = [];
        for (let i = 0; i < startCards; i++) p.hand.push(r.drawPile.pop());
        p.hasDrawn = false;
        p.lastRoundPoints = 0;
        const randomRank = RANKS[Math.floor(Math.random() * RANKS.length)];
        p.bonusCard = { id: 9999 + Math.random(), rank: randomRank, value: cardValue(randomRank) };
        p.bonusUnlocked = false;
      });

      r.currentIndex = 0; 
      r.turnId = r.players[0].id;

      if (r.gameType === 'close_master') {
        if (initialCard.rank === '7') {
          r.penaltyCount = 1; 
        } else if (initialCard.rank === 'J') {
          r.currentIndex = (r.currentIndex + 1) % r.players.length;
          r.turnId = r.players[r.currentIndex].id;
        }
      }

      startTurnTimer(r);
      broadcast(r);
    }
  });

  socket.on("action_draw", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (p && !p.hasDrawn && room.turnId === p.id) {
      if (data.fromDiscard) {
        let topDiscard = room.discardPile[room.discardPile.length - 1];
        if (room.gameType === 'close_master' && (topDiscard.rank === '7' || topDiscard.rank === 'J')) {
          socket.emit("show_error", "Cannot pick 7 or J from discard pile!");
          return;
        }
        p.hand.push(room.discardPile.pop());
      } else {
        if (room.drawPile.length === 0 && room.discardPile.length > 1) {
          const top = room.discardPile.pop();
          room.drawPile = room.discardPile.sort(() => Math.random() - 0.5);
          room.discardPile = [top];
        }
        if (room.drawPile.length > 0) p.hand.push(room.drawPile.pop());
      }
      p.hasDrawn = true;
      broadcast(room);
    }
  });

  socket.on("action_drop", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (p && p.id === room.turnId && p.hasDrawn) {
      const droppedCards = p.hand.filter(c => data.selectedIds.includes(c.id));
      if (droppedCards.length === 0) return;

      const firstRank = droppedCards[0].rank;
      const allSameRank = droppedCards.every(c => c.rank === firstRank);
      if (!allSameRank && droppedCards.length > 1) {
        socket.emit("show_error", "Can only drop multiple cards of the same rank!");
        return;
      }

      if (room.gameType === 'close_master' && room.penaltyCount > 0) {
        if (firstRank === '7') {
          droppedCards.forEach(card => {
            room.discardPile.push(card);
            p.hand = p.hand.filter(c => c.id !== card.id);
            room.penaltyCount++;
          });
          room.currentIndex = (room.currentIndex + 1) % room.players.length;
          room.turnId = room.players[room.currentIndex].id;
          p.hasDrawn = false;
          startTurnTimer(room);
          broadcast(room);
          return;
        } else {
          socket.emit("show_error", "You must play a 7 to counter the penalty!");
          return;
        }
      }

      droppedCards.forEach(card => {
        room.discardPile.push(card);
        p.hand = p.hand.filter(c => c.id !== card.id);
      });

      const lastDropped = droppedCards[droppedCards.length - 1];

      if (room.gameType === 'close_master') {
        if (lastDropped.rank === '7') {
          room.penaltyCount = 1; 
          room.currentIndex = (room.currentIndex + 1) % room.players.length;
          room.turnId = room.players[room.currentIndex].id;
          p.hasDrawn = false;
          startTurnTimer(room);
          broadcast(room);
          return;
        }
        if (lastDropped.rank === 'J') {
          room.currentIndex = (room.currentIndex + 2) % room.players.length;
          room.turnId = room.players[room.currentIndex].id;
          p.hasDrawn = false;
          startTurnTimer(room);
          broadcast(room);
          return;
        }
      }

      if (room.gameType === "set_show") {
        const ranks = p.hand.map(c => c.rank);
        const rankCounts = {};
        ranks.forEach(r => rankCounts[r] = (rankCounts[r] || 0) + 1);
        if (Object.values(rankCounts).some(count => count >= 4)) p.bonusUnlocked = true;
      }
      
      room.currentIndex = (room.currentIndex + 1) % room.players.length;
      room.turnId = room.players[room.currentIndex].id;
      p.hasDrawn = false;
      startTurnTimer(room);
      broadcast(room);
    }
  });

  socket.on("resolve_penalty", data => {
    const room = rooms.get(data.roomId);
    const p = room?.players.find(x => x.socketId === socket.id);
    if (room && p && room.gameType === 'close_master' && room.penaltyCount > 0 && room.turnId === p.id) {
      let totalCardsToTake = room.penaltyCount * 2;
      for (let i = 0; i < totalCardsToTake; i++) {
        if (room.drawPile.length === 0 && room.discardPile.length > 1) {
          const top = room.discardPile.pop();
          room.drawPile = room.discardPile.sort(() => Math.random() - 0.5);
          room.discardPile = [top];
        }
        if (room.drawPile.length > 0) p.hand.push(room.drawPile.pop());
      }
      room.penaltyCount = 0;
      room.currentIndex = (room.currentIndex + 1) % room.players.length;
      room.turnId = room.players[room.currentIndex].id;
      p.hasDrawn = false;
      startTurnTimer(room);
      broadcast(room);
    }
  });

  socket.on("action_close", data => {
    const r = rooms.get(data.roomId);
    const p = r?.players.find(x => x.socketId === socket.id);
    if (r && p && r.gameType === "close_master" && p.hasDrawn) {
      if (data.selectedIds.length !== 1) { socket.emit("show_error", "Select 1 card to close/discard."); return; }
      const dropCard = p.hand.find(c => c.id === data.selectedIds[0]);
      const finalHand = p.hand.filter(c => c.id !== dropCard.id);
      
      if (r.timer) clearInterval(r.timer);
      r.discardPile.push(dropCard);
      p.hand = finalHand;
      const roundPointsMap = {};
      r.players.forEach(pl => {
        let pts = pl.id === p.id ? 0 : pl.hand.reduce((sum, c) => sum + (c.rank === 'J' ? 20 : c.rank === '7' ? 15 : cardValue(c.rank)), 0);
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
      if (data.selectedIds.length !== 1) { socket.emit("show_error", "Select 1 card to discard."); return; }
      const dropCard = p.hand.find(c => c.id === data.selectedIds[0]);
      const finalHand = p.hand.filter(c => c.id !== dropCard.id);
      
      if (r.timer) clearInterval(r.timer);
      r.discardPile.push(dropCard);
      p.hand = finalHand;
      const roundPointsMap = {};
      r.players.forEach(pl => {
        let pts = pl.id === p.id ? 0 : pl.hand.reduce((sum, c) => sum + cardValue(c.rank), 0);
        pl.lastRoundPoints = pts; pl.score += pts; roundPointsMap[pl.name] = pts;
      });
      r.roundHistory.push({ round: r.roundNumber, points: roundPointsMap });
      r.started = false;
      io.to(r.roomId).emit("close_result", { winner: p.name });
      broadcast(r);
    }
  });

  socket.on("action_show_set", data => {
    const r = rooms.get(data.roomId);
    const p = r?.players.find(x => x.socketId === socket.id);
    if (r && p && r.gameType === "set_show" && p.hasDrawn) {
      if (data.selectedIds.length !== 1) { socket.emit("show_error", "Select 1 card to discard."); return; }
      const dropCard = p.hand.find(c => c.id === data.selectedIds[0]);
      const finalHand = p.hand.filter(c => c.id !== dropCard.id);
      
      const ranks = finalHand.map(c => c.rank);
      const rankCounts = {};
      ranks.forEach(rank => {
        if (rank !== "JOKER") rankCounts[rank] = (rankCounts[rank] || 0) + 1;
      });

      let hasValid4CardGroupWithoutJoker = false;
      for (let rank in rankCounts) {
        if (rankCounts[rank] >= 4) {
          hasValid4CardGroupWithoutJoker = true;
          break;
        }
      }

      if (hasValid4CardGroupWithoutJoker || p.bonusUnlocked) {
        if (r.timer) clearInterval(r.timer);
        r.discardPile.push(dropCard);
        p.hand = finalHand;
        const roundPointsMap = {};
        r.players.forEach(pl => {
          let pts = pl.id === p.id ? 0 : pl.hand.reduce((sum, c) => sum + c.value, 0);
          pl.lastRoundPoints = pts; pl.score += pts; roundPointsMap[pl.name] = pts;
        });
        r.roundHistory.push({ round: r.roundNumber, points: roundPointsMap });
        r.started = false;
        io.to(r.roomId).emit("close_result", { winner: p.name });
        broadcast(r);
      } else {
        socket.emit("show_error", "Invalid Sets! 4-card set cannot contain Jokers.");
      }
    }
  });

  const handleDisconnect = (socket) => {
    rooms.rooms.forEach((room, roomId) => {
      // handled cleanly
    });
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
