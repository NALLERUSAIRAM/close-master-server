const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.status(200).send("Close Master Server is Running");
});

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

const PORT = process.env.PORT || 3000;

const TURN_TIME_LIMIT = 90;

const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

const cardValue = (rank) => {
  if (rank === "JOKER") return 0;
  if (rank === "A") return 1;
  if (["J", "Q", "K"].includes(rank)) return 10;
  return Number.parseInt(rank, 10) || 0;
};

/* -------------------------------------------------------
   DECK
------------------------------------------------------- */

function createDeck() {
  const deck = [];
  let id = Date.now();

  const suits = ["♥", "♦", "♣", "♠"];

  for (const rank of RANKS) {
    for (const suit of suits) {
      deck.push({
        id: String(id++),
        rank,
        suit,
        value: cardValue(rank),
      });
    }
  }

  deck.push({
    id: String(id++),
    rank: "JOKER",
    suit: "🃏",
    value: 0,
  });

  deck.push({
    id: String(id++),
    rank: "JOKER",
    suit: "🃏",
    value: 0,
  });

  return shuffle(deck);
}

function shuffle(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

/* -------------------------------------------------------
   ROOMS
------------------------------------------------------- */

const rooms = new Map();

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

function activePlayers(room) {
  return room.players.filter((p) => !p.isOffline);
}

function currentPlayer(room) {
  return room.players.find((p) => p.id === room.turnId);
}

function nextTurn(room, skipCount = 1) {
  const players = activePlayers(room);

  if (players.length === 0) return;

  const currentActiveIndex = players.findIndex(
    (p) => p.id === room.turnId
  );

  if (currentActiveIndex === -1) {
    room.currentIndex = 0;
    room.turnId = players[0].id;
    return;
  }

  const nextIndex =
    (currentActiveIndex + skipCount) % players.length;

  room.currentIndex = nextIndex;
  room.turnId = players[nextIndex].id;
}

function handScore(player) {
  return player.hand.reduce(
    (sum, card) => sum + cardValue(card.rank),
    0
  );
}

function reshuffleDiscardIntoDraw(room) {
  if (room.drawPile.length > 0) return true;

  if (room.discardPile.length <= 1) return false;

  const top = room.discardPile.pop();

  room.drawPile = shuffle(room.discardPile);
  room.discardPile = [top];

  return room.drawPile.length > 0;
}

function drawOne(room, player) {
  if (!reshuffleDiscardIntoDraw(room)) return null;

  const card = room.drawPile.pop();

  if (!card) return null;

  player.hand.push(card);

  return card;
}

function drawMany(room, player, count) {
  let drawn = 0;

  for (let i = 0; i < count; i++) {
    const card = drawOne(room, player);

    if (!card) break;

    drawn++;
  }

  return drawn;
}

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function resetPlayerTurnState(player) {
  player.hasDrawn = false;
}

function startTurnTimer(room) {
  stopTimer(room);

  room.turnTimeLeft = TURN_TIME_LIMIT;

  room.timer = setInterval(() => {
    if (!rooms.has(room.roomId) || !room.started) {
      stopTimer(room);
      return;
    }

    room.turnTimeLeft--;

    io.to(room.roomId).emit("timer_tick", {
      turnTimeLeft: room.turnTimeLeft,
      turnId: room.turnId,
    });

    if (room.turnTimeLeft <= 0) {
      stopTimer(room);
      handleTimeout(room);
    }
  }, 1000);
}

/* -------------------------------------------------------
   PLAY VALIDATION
------------------------------------------------------- */

function sameRank(cards) {
  if (!cards.length) return false;

  const rank = cards[0].rank;

  return cards.every((card) => card.rank === rank);
}

function canDirectDrop(room, player, cards) {
  if (!cards.length) {
    return {
      valid: false,
      reason: "Select a card.",
    };
  }

  // Joker is never actually played.
  if (cards.some((card) => card.rank === "JOKER")) {
    return {
      valid: false,
      reason: "Joker cannot be dropped.",
    };
  }

  // Multiple cards must always have the same rank.
  if (cards.length > 1 && !sameRank(cards)) {
    return {
      valid: false,
      reason: "Multiple cards must be the same rank.",
    };
  }

  /*
    SPECIAL:
    If player has already taken penalty cards,
    they can choose ANY same-rank group.
  */
  if (room.penaltyCount > 0 && player.hasDrawn) {
    return {
      valid: true,
      reason: "",
    };
  }

  const top = room.discardPile[room.discardPile.length - 1];

  /*
    3 OR MORE same-rank cards:
    Can be dropped directly without draw.
  */
  if (cards.length >= 3 && sameRank(cards)) {
    return {
      valid: true,
      reason: "",
    };
  }

  /*
    DRAW-FIRST RULE:
    Once the player has drawn for this turn, they may drop
    any single non-Joker card, even if its rank does not
    match the open card. If multiple cards are selected,
    they must all have the same rank.
  */
  if (player.hasDrawn) {
    return {
      valid: true,
      reason: "",
    };
  }

  /*
    Single card without drawing:
    It must match the open card.
  */
  if (cards.length === 1) {
    if (top?.rank === cards[0].rank) {
      return {
        valid: true,
        reason: "",
      };
    }
  }

  /*
    Two same-rank cards without drawing require a draw first.
  */
  if (cards.length >= 2 && sameRank(cards)) {
    return {
      valid: false,
      reason: "Draw first before dropping this group.",
    };
  }

  return {
    valid: false,
    reason: "Invalid card. Match the open card or use 3+ same-rank cards.",
  };
}

/* -------------------------------------------------------
   BROADCAST
------------------------------------------------------- */

function broadcast(room) {
  room.players.forEach((viewer) => {
    const visiblePlayers = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      handSize: player.hand.length,
      hasDrawn: !!player.hasDrawn,
      isOffline: !!player.isOffline,
      lastRoundPoints: player.lastRoundPoints || 0,
      hand:
        player.id === viewer.id
          ? player.hand
          : [],
    }));

    io.to(viewer.socketId).emit("game_state", {
      roomId: room.roomId,
      gameType: room.gameType,
      hostId: room.hostId,
      youId: viewer.id,

      started: room.started,
      roundNumber: room.roundNumber,

      turnId: room.turnId,
      turnTimeLeft:
        room.turnTimeLeft || TURN_TIME_LIMIT,

      discardTop:
        room.discardPile[
          room.discardPile.length - 1
        ] || null,

      penaltyCount: room.penaltyCount || 0,

      roundHistory: room.roundHistory || [],

      players: visiblePlayers,
    });
  });
}

/* -------------------------------------------------------
   TIMEOUT
------------------------------------------------------- */

function handleTimeout(room) {
  const player = currentPlayer(room);

  if (!player) return;

  /*
    If 7 penalty is active, timeout means
    automatically take the entire penalty.
  */
  if (room.penaltyCount > 0) {
    const penaltyCards = room.penaltyCount * 2;

    drawMany(room, player, penaltyCards);

    room.penaltyCount = 0;
    player.hasDrawn = true;

    /*
      Player has taken penalty, but timeout ends
      the turn automatically.
    */
    resetPlayerTurnState(player);
    nextTurn(room, 1);
    startTurnTimer(room);
    broadcast(room);

    return;
  }

  /*
    Normal timeout:
    automatically draw one card if player hasn't drawn.
  */
  if (!player.hasDrawn) {
    drawOne(room, player);
  }

  resetPlayerTurnState(player);

  nextTurn(room, 1);
  startTurnTimer(room);
  broadcast(room);
}

/* -------------------------------------------------------
   SOCKET.IO
------------------------------------------------------- */

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* ---------------------------------------------------
     CREATE ROOM
  --------------------------------------------------- */

  socket.on("create_room", (data, callback) => {
    try {
      const roomId = Math.random()
        .toString(36)
        .substring(2, 6)
        .toUpperCase();

      const room = {
        roomId,

        gameType:
          data.gameType || "close_master",

        hostId: data.playerId,

        players: [
          {
            id: data.playerId,
            socketId: socket.id,
            name: data.name || "Player",
            score: 0,
            hand: [],
            hasDrawn: false,
            isOffline: false,
            lastRoundPoints: 0,
          },
        ],

        started: false,
        roundNumber: 0,

        drawPile: [],
        discardPile: [],

        penaltyCount: 0,

        currentIndex: 0,
        turnId: null,

        turnTimeLeft: TURN_TIME_LIMIT,
        timer: null,

        roundHistory: [],
      };

      rooms.set(roomId, room);

      socket.join(roomId);

      if (callback) {
        callback({
          ok: true,
          roomId,
        });
      }

      broadcast(room);
    } catch (error) {
      console.error("CREATE ROOM ERROR:", error);

      if (callback) {
        callback({
          ok: false,
          error: "Could not create room.",
        });
      }
    }
  });

  /* ---------------------------------------------------
     JOIN ROOM
  --------------------------------------------------- */

  socket.on("join_room", (data, callback) => {
    try {
      const room = rooms.get(data.roomId);

      if (!room) {
        return callback?.({
          ok: false,
          error: "Room Not Found",
        });
      }

      if (room.started) {
        return callback?.({
          ok: false,
          error: "Game already started!",
        });
      }

      const onlinePlayers = activePlayers(room);

      if (onlinePlayers.length >= 7) {
        return callback?.({
          ok: false,
          error: "Room is Full! Max 7 players.",
        });
      }

      let player = room.players.find(
        (p) => p.id === data.playerId
      );

      if (player) {
        player.socketId = socket.id;
        player.isOffline = false;
        player.name = data.name || player.name;
      } else {
        player = {
          id: data.playerId,
          socketId: socket.id,
          name: data.name || "Player",
          score: 0,
          hand: [],
          hasDrawn: false,
          isOffline: false,
          lastRoundPoints: 0,
        };

        room.players.push(player);
      }

      socket.join(room.roomId);

      callback?.({
        ok: true,
        roomId: room.roomId,
      });

      broadcast(room);
    } catch (error) {
      console.error("JOIN ROOM ERROR:", error);

      callback?.({
        ok: false,
        error: "Could not join room.",
      });
    }
  });

  /* ---------------------------------------------------
     START ROUND
  --------------------------------------------------- */

  socket.on("start_round", (data) => {
    const room = rooms.get(data.roomId);

    if (!room) return;

    const players = activePlayers(room);

    if (players.length < 2) {
      io.to(room.roomId).emit(
        "show_error",
        "Need at least 2 players to start!"
      );
      return;
    }

    room.started = true;
    room.roundNumber++;

    room.drawPile = createDeck();
    room.discardPile = [];

    room.penaltyCount = 0;

    /*
      Close Master = 7 cards
      Other two games = 13 cards
    */
    const startCards =
      room.gameType === "close_master"
        ? 7
        : 13;

    players.forEach((player) => {
      player.hand = [];
      player.hasDrawn = false;
      player.lastRoundPoints = 0;

      for (let i = 0; i < startCards; i++) {
        const card = room.drawPile.pop();

        if (card) {
          player.hand.push(card);
        }
      }
    });

    /*
      First/open card.
    */
    let initialCard = room.drawPile.pop();

    /*
      Avoid starting with an unusable situation if possible.
      Any card is technically allowed, including 7/J/Joker,
      because their rules are explicitly handled below.
    */
    if (!initialCard) {
      initialCard = {
        id: `initial-${Date.now()}`,
        rank: "A",
        suit: "♠",
        value: 1,
      };
    }

    room.discardPile = [initialCard];

    room.currentIndex = 0;
    room.turnId = players[0].id;

    /*
      OPEN 7:
      Current player receives +2 penalty.
    */
    if (
      room.gameType === "close_master" &&
      initialCard.rank === "7"
    ) {
      room.penaltyCount = 1;
    }

    /*
      OPEN J:
      Current player is skipped.
      Example:
      A turn initially
      Open J
      A skips
      B gets turn
    */
    if (
      room.gameType === "close_master" &&
      initialCard.rank === "J"
    ) {
      nextTurn(room, 1);
    }

    startTurnTimer(room);
    broadcast(room);
  });

  /* ---------------------------------------------------
     DRAW
  --------------------------------------------------- */

  socket.on("action_draw", (data) => {
    const room = rooms.get(data.roomId);

    if (!room || !room.started) return;

    const player = room.players.find(
      (p) => p.socketId === socket.id
    );

    if (!player) return;

    if (room.turnId !== player.id) {
      socket.emit(
        "show_error",
        "It is not your turn."
      );
      return;
    }

    if (player.hasDrawn) {
      socket.emit(
        "show_error",
        "You already drew."
      );
      return;
    }

    /*
      7 PENALTY
      Take all penalty cards at once.
    */
    if (
      room.gameType === "close_master" &&
      room.penaltyCount > 0
    ) {
      const amount = room.penaltyCount * 2;

      const drawn = drawMany(
        room,
        player,
        amount
      );

      if (drawn <= 0) {
        socket.emit(
          "show_error",
          "No cards available to draw."
        );
        return;
      }

      room.penaltyCount = 0;

      // Mark this as a completed draw. After taking the penalty,
      // the player may drop any single card or any same-rank group.
      player.hasDrawn = true;
      room._lastPenaltyDrawPlayer = player.id;

      broadcast(room);
      return;
    }

    /*
      DISCARD DRAW
      7 and J cannot be picked from discard.
    */
    if (data.fromDiscard) {
      const top =
        room.discardPile[
          room.discardPile.length - 1
        ];

      if (!top) return;

      if (
        room.gameType === "close_master" &&
        ["7", "J"].includes(top.rank)
      ) {
        socket.emit(
          "show_error",
          "Cannot pick 7 or J from discard pile."
        );
        return;
      }

      /*
        Joker can be picked or not.
        It behaves like a normal card for taking.
      */
      player.hand.push(
        room.discardPile.pop()
      );

      player.hasDrawn = true;

      broadcast(room);
      return;
    }

    /*
      NORMAL DRAW
    */
    const card = drawOne(room, player);

    if (!card) {
      socket.emit(
        "show_error",
        "No cards available."
      );
      return;
    }

    player.hasDrawn = true;

    broadcast(room);
  });

  /* ---------------------------------------------------
     DROP
  --------------------------------------------------- */

  socket.on("action_drop", (data) => {
    const room = rooms.get(data.roomId);

    if (!room || !room.started) return;

    const player = room.players.find(
      (p) => p.socketId === socket.id
    );

    if (!player) return;

    if (room.turnId !== player.id) {
      socket.emit(
        "show_error",
        "It is not your turn."
      );
      return;
    }

    const selectedIds = Array.isArray(
      data.selectedIds
    )
      ? data.selectedIds
      : [];

    const cards = player.hand.filter((card) =>
      selectedIds.includes(card.id)
    );

    if (!cards.length) {
      socket.emit(
        "show_error",
        "Select cards first."
      );
      return;
    }

    /*
      JOKER CANNOT BE DROPPED
    */
    if (
      cards.some(
        (card) => card.rank === "JOKER"
      )
    ) {
      socket.emit(
        "show_error",
        "Joker cannot be dropped."
      );
      return;
    }

    /*
      If penalty was taken, player can now
      drop ANY same-rank group.
    */
    if (
      room.gameType === "close_master" &&
      player.hasDrawn &&
      room._lastPenaltyDrawPlayer === player.id
    ) {
      if (!sameRank(cards)) {
        socket.emit(
          "show_error",
          "After penalty, multiple cards must have the same rank."
        );
        return;
      }

      room._lastPenaltyDrawPlayer = null;

      const droppedRank = cards[0].rank;

      cards.forEach((card) => {
        room.discardPile.push(card);
      });

      player.hand = player.hand.filter(
        (card) => !selectedIds.includes(card.id)
      );

      player.hasDrawn = false;

      /*
        J effect
      */
      if (droppedRank === "J") {
        nextTurn(room, cards.length);
      }

      /*
        7 effect
      */
      else if (droppedRank === "7") {
        room.penaltyCount += cards.length;
        nextTurn(room, 1);
      }

      else {
        nextTurn(room, 1);
      }

      startTurnTimer(room);
      broadcast(room);
      return;
    }

    /*
      If penalty is active and player has NOT drawn,
      only a 7 group can be used to counter it.
    */
    if (
      room.gameType === "close_master" &&
      room.penaltyCount > 0 &&
      !player.hasDrawn
    ) {
      if (
        !sameRank(cards) ||
        cards[0].rank !== "7"
      ) {
        socket.emit(
          "show_error",
          "You must play a 7 or draw the penalty."
        );
        return;
      }

      cards.forEach((card) => {
        room.discardPile.push(card);
      });

      player.hand = player.hand.filter(
        (card) => !selectedIds.includes(card.id)
      );

      room.penaltyCount += cards.length;

      player.hasDrawn = false;

      nextTurn(room, 1);

      startTurnTimer(room);
      broadcast(room);
      return;
    }

    /*
      NORMAL PLAY VALIDATION
    */
    const validation = canDirectDrop(
      room,
      player,
      cards
    );

    if (!validation.valid) {
      socket.emit(
        "show_error",
        validation.reason
      );
      return;
    }

    /*
      If this was a draw-first play,
      allow it.
    */
    cards.forEach((card) => {
      room.discardPile.push(card);
    });

    player.hand = player.hand.filter(
      (card) => !selectedIds.includes(card.id)
    );

    player.hasDrawn = false;

    /*
      SPECIAL J
      Number of J cards = number of players skipped.
    */
    if (
      room.gameType === "close_master" &&
      cards[0].rank === "J"
    ) {
      nextTurn(room, cards.length);
    }

    /*
      SPECIAL 7
      Number of 7 cards × 2 cards penalty.
    */
    else if (
      room.gameType === "close_master" &&
      cards[0].rank === "7"
    ) {
      room.penaltyCount += cards.length;

      nextTurn(room, 1);
    }

    else {
      nextTurn(room, 1);
    }

    startTurnTimer(room);
    broadcast(room);
  });

  /* ---------------------------------------------------
     CLOSE MASTER CLOSE
  --------------------------------------------------- */

  socket.on("action_close", (data) => {
    const room = rooms.get(data.roomId);

    if (
      !room ||
      !room.started ||
      room.gameType !== "close_master"
    ) {
      return;
    }

    const player = room.players.find(
      (p) => p.socketId === socket.id
    );

    if (!player) return;

    if (room.turnId !== player.id) {
      socket.emit(
        "show_error",
        "It is not your turn."
      );
      return;
    }

    /*
      Close is based on CURRENT HAND SCORES.
      No draw is required.
      No selected card is required.
    */
    const scores = room.players.map((p) => ({
      id: p.id,
      score: handScore(p),
    }));

    const myScore = handScore(player);

    const lowestOtherScore = Math.min(
      ...scores
        .filter((x) => x.id !== player.id)
        .map((x) => x.score)
    );

    /*
      Strictly lower than everybody = correct.
      If tied for lowest, it is NOT lower.
    */
    const correct =
      room.players.length <= 1 ||
      myScore < lowestOtherScore;

    let roundPointsMap = {};

    if (correct) {
      room.players.forEach((p) => {
        const points =
          p.id === player.id
            ? 0
            : handScore(p);

        p.lastRoundPoints = points;
        p.score += points;

        roundPointsMap[p.name] = points;
      });
    } else {
      /*
        Find highest hand score.
      */
      const highestScore = Math.max(
        ...room.players.map((p) =>
          handScore(p)
        )
      );

      room.players.forEach((p) => {
        let points;

        if (p.id === player.id) {
          /*
            Wrong close:
            highest hand score × 2
          */
          points = highestScore * 2;
        } else {
          points = handScore(p);
        }

        p.lastRoundPoints = points;
        p.score += points;

        roundPointsMap[p.name] = points;
      });
    }

    stopTimer(room);

    room.roundHistory.push({
      round: room.roundNumber,
      closer: player.name,
      correct,
      handScores: Object.fromEntries(
        room.players.map((p) => [
          p.name,
          handScore(p),
        ])
      ),
      points: roundPointsMap,
    });

    room.started = false;

    io.to(room.roomId).emit(
      "close_result",
      {
        winner: correct ? player.name : null,
        closer: player.name,
        correct,
        points: roundPointsMap,
      }
    );

    broadcast(room);
  });

  /* ---------------------------------------------------
     OTHER GAME PLACEHOLDERS
     Existing other game logic can remain separately.
  --------------------------------------------------- */

  socket.on("action_show_cards", (data) => {
    const room = rooms.get(data.roomId);
    const player = room?.players.find(
      (p) => p.socketId === socket.id
    );

    if (
      !room ||
      !player ||
      room.gameType !== "cards_show"
    ) {
      return;
    }

    socket.emit(
      "show_error",
      "Cards Show logic is unchanged in this Close Master update."
    );
  });

  socket.on("action_show_set", (data) => {
    const room = rooms.get(data.roomId);
    const player = room?.players.find(
      (p) => p.socketId === socket.id
    );

    if (
      !room ||
      !player ||
      room.gameType !== "set_show"
    ) {
      return;
    }

    socket.emit(
      "show_error",
      "Set Show logic is unchanged in this Close Master update."
    );
  });

  /* ---------------------------------------------------
     EXIT / DISCONNECT
  --------------------------------------------------- */

  function handleDisconnect() {
    rooms.forEach((room, roomId) => {
      const player = room.players.find(
        (p) => p.socketId === socket.id
      );

      if (!player) return;

      player.isOffline = true;

      const online = activePlayers(room);

      if (online.length === 0) {
        stopTimer(room);
        rooms.delete(roomId);
        return;
      }

      if (
        room.started &&
        room.turnId === player.id
      ) {
        nextTurn(room, 1);
        startTurnTimer(room);
      }

      broadcast(room);
    });
  }

  socket.on("exit_room", handleDisconnect);
  socket.on("disconnect", handleDisconnect);
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Close Master Server running on port ${PORT}`
  );
});
