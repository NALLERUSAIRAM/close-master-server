const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.use(cors());

app.get("/", (req, res) => {
  res.status(200).send("Gully Cards Server is Running");
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

const rooms = new Map();

const cardValue = (rank) => {
  if (rank === "JOKER") return 0;
  if (rank === "A") return 1;
  if (["J", "Q", "K"].includes(rank)) return 10;

  const n = parseInt(rank, 10);
  return Number.isNaN(n) ? 0 : n;
};

/* =========================================================
   DECK
========================================================= */

const createDeck = () => {
  const deck = [];

  let id = Date.now();

  for (let r = 1; r <= 13; r++) {
    for (let i = 0; i < 4; i++) {
      const rank =
        r === 1
          ? "A"
          : r === 11
          ? "J"
          : r === 12
          ? "Q"
          : r === 13
          ? "K"
          : String(r);

      deck.push({
        id: id++,
        rank,
        value: cardValue(rank),
      });
    }
  }

  deck.push(
    {
      id: id++,
      rank: "JOKER",
      suit: "🃏",
      value: 0,
    },
    {
      id: id++,
      rank: "JOKER",
      suit: "🃏",
      value: 0,
    }
  );

  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
};

/* =========================================================
   HELPERS
========================================================= */

const getPlayerBySocket = (room, socketId) => {
  return room.players.find((p) => p.socketId === socketId);
};

const getActivePlayers = (room) => {
  return room.players.filter((p) => !p.isOffline);
};

const clearRoomTimer = (room) => {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
};

const refillDrawPile = (room) => {
  if (
    room.drawPile.length === 0 &&
    room.discardPile.length > 1
  ) {
    const top = room.discardPile.pop();

    room.drawPile = room.discardPile;

    // Fisher-Yates shuffle
    for (let i = room.drawPile.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.drawPile[i], room.drawPile[j]] = [
        room.drawPile[j],
        room.drawPile[i],
      ];
    }

    room.discardPile = [top];
  }
};

const drawOneCard = (room, player) => {
  refillDrawPile(room);

  if (room.drawPile.length === 0) {
    return null;
  }

  const card = room.drawPile.pop();

  player.hand.push(card);

  return card;
};

/* =========================================================
   BROADCAST
========================================================= */

const broadcast = (room) => {
  if (!room) return;

  const publicPlayers = room.players.map((pl) => ({
    id: pl.id,
    name: pl.name,
    score: pl.score,
    handSize: pl.hand.length,
    hasDrawn: !!pl.hasDrawn,
    isOffline: !!pl.isOffline,
    lastRoundPoints: pl.lastRoundPoints || 0,
    bonusUnlocked: !!pl.bonusUnlocked,
  }));

  room.players.forEach((player) => {
    if (!player.socketId) return;

    io.to(player.socketId).emit("game_state", {
      roomId: room.roomId,
      gameType: room.gameType,
      hostId: room.hostId,
      youId: player.id,

      started: room.started,

      roundNumber: room.roundNumber,

      turnId: room.turnId,

      turnTimeLeft:
        typeof room.turnTimeLeft === "number"
          ? room.turnTimeLeft
          : TURN_TIME_LIMIT,

      discardTop:
        room.discardPile[room.discardPile.length - 1] || null,

      roundHistory: room.roundHistory || [],

      penaltyCount: room.penaltyCount || 0,

      players: room.players.map((pl) => ({
        ...publicPlayers.find((x) => x.id === pl.id),

        bonusCard:
          pl.id === player.id
            ? pl.bonusCard
            : pl.bonusUnlocked
            ? pl.bonusCard
            : null,

        hand:
          pl.id === player.id
            ? pl.hand
            : [],
      })),
    });
  });
};

/* =========================================================
   TURN TIMER
========================================================= */

const startTurnTimer = (room) => {
  clearRoomTimer(room);

  room.turnTimeLeft = TURN_TIME_LIMIT;

  room.timer = setInterval(() => {
    if (!rooms.has(room.roomId)) {
      clearRoomTimer(room);
      return;
    }

    if (!room.started) {
      clearRoomTimer(room);
      return;
    }

    room.turnTimeLeft--;

    io.to(room.roomId).emit("timer_tick", {
      turnTimeLeft: room.turnTimeLeft,
      turnId: room.turnId,
    });

    if (room.turnTimeLeft <= 0) {
      clearRoomTimer(room);

      handleTimeout(room);
    }
  }, 1000);
};

/* =========================================================
   NEXT TURN
========================================================= */

const moveToNextTurn = (room, steps = 1) => {
  const activePlayers = getActivePlayers(room);

  if (activePlayers.length === 0) return;

  let currentPlayerIndex = activePlayers.findIndex(
    (p) => p.id === room.turnId
  );

  if (currentPlayerIndex < 0) {
    currentPlayerIndex = 0;
  }

  const nextIndex =
    (currentPlayerIndex + steps) % activePlayers.length;

  const nextPlayer = activePlayers[nextIndex];

  room.currentIndex = room.players.findIndex(
    (p) => p.id === nextPlayer.id
  );

  room.turnId = nextPlayer.id;
};

/* =========================================================
   TIMEOUT
========================================================= */

const handleTimeout = (room) => {
  if (!room || !room.started) return;

  const currentPlayer = room.players.find(
    (p) => p.id === room.turnId
  );

  if (!currentPlayer) return;

  if (!currentPlayer.hasDrawn) {
    drawOneCard(room, currentPlayer);
  }

  /*
    IMPORTANT:
    Close Master has NO 8-card limit.
    Therefore we do NOT automatically discard
    when hand becomes 8+.
  */

  currentPlayer.hasDrawn = false;

  moveToNextTurn(room);

  startTurnTimer(room);

  broadcast(room);
};

/* =========================================================
   CONNECTION
========================================================= */

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /* =======================================================
     CREATE ROOM
  ======================================================= */

  socket.on("create_room", (data = {}, cb) => {
    const roomId = Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase();

    const playerId = data.playerId;

    const room = {
      roomId,

      gameType:
        data.gameType || "close_master",

      hostId: playerId,

      players: [
        {
          id: playerId,
          socketId: socket.id,
          name: data.name || "Player",

          score: 0,

          hand: [],

          bonusCard: null,

          bonusUnlocked: false,

          isOffline: false,

          hasDrawn: false,

          lastRoundPoints: 0,
        },
      ],

      started: false,

      roundNumber: 0,

      drawPile: [],

      discardPile: [],

      roundHistory: [],

      penaltyCount: 0,

      turnId: null,

      currentIndex: 0,

      turnTimeLeft: TURN_TIME_LIMIT,

      timer: null,
    };

    rooms.set(roomId, room);

    socket.join(roomId);

    if (typeof cb === "function") {
      cb({
        roomId,
      });
    }

    broadcast(room);
  });

  /* =======================================================
     JOIN ROOM
  ======================================================= */

  socket.on("join_room", (data = {}, cb) => {
    const roomId = String(data.roomId || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(roomId);

    if (!room) {
      if (typeof cb === "function") {
        cb({
          error: "Room Not Found",
        });
      }

      return;
    }

    if (room.started) {
      if (typeof cb === "function") {
        cb({
          error: "Game already started!",
        });
      }

      return;
    }

    const activeOnlinePlayers = room.players.filter(
      (p) => !p.isOffline
    );

    if (activeOnlinePlayers.length >= 7) {
      if (typeof cb === "function") {
        cb({
          error: "Room is Full! Max 7 players.",
        });
      }

      return;
    }

    const existingPlayer = room.players.find(
      (p) => p.id === data.playerId
    );

    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.isOffline = false;
    } else {
      room.players.push({
        id: data.playerId,

        socketId: socket.id,

        name: data.name || "Player",

        score: 0,

        hand: [],

        bonusCard: null,

        bonusUnlocked: false,

        isOffline: false,

        hasDrawn: false,

        lastRoundPoints: 0,
      });
    }

    socket.join(roomId);

    if (typeof cb === "function") {
      cb({
        roomId: room.roomId,
      });
    }

    broadcast(room);
  });

  /* =======================================================
     START ROUND
  ======================================================= */

  socket.on("start_round", (data = {}) => {
    const room = rooms.get(data.roomId);

    if (!room) return;

    const activePlayers = getActivePlayers(room);

    if (activePlayers.length < 2) {
      io.to(room.roomId).emit(
        "show_error",
        "Need at least 2 players to start!"
      );

      return;
    }

    room.started = true;

    room.roundNumber++;

    room.drawPile = createDeck();

    const initialCard = room.drawPile.pop();

    room.discardPile = [initialCard];

    room.penaltyCount = 0;

    const startCards =
      room.gameType === "close_master"
        ? 7
        : 13;

    room.players.forEach((player) => {
      if (player.isOffline) return;

      player.hand = [];

      for (let i = 0; i < startCards; i++) {
        const card = room.drawPile.pop();

        if (card) {
          player.hand.push(card);
        }
      }

      player.hasDrawn = false;

      player.lastRoundPoints = 0;

      const randomRank =
        RANKS[
          Math.floor(
            Math.random() * RANKS.length
          )
        ];

      player.bonusCard = {
        id: 9999 + Math.random(),

        rank: randomRank,

        value: cardValue(randomRank),
      };

      player.bonusUnlocked = false;
    });

    room.currentIndex = 0;

    room.turnId = activePlayers[0].id;

    /* ---------------------------------------------
       Close Master opening card
    --------------------------------------------- */

    if (room.gameType === "close_master") {
      if (initialCard.rank === "7") {
        /*
          Opening 7 = +2 penalty.
        */
        room.penaltyCount = 1;
      } else if (initialCard.rank === "J") {
        /*
          Opening J = first player skipped.
        */
        moveToNextTurn(room, 2);
      }
    }

    startTurnTimer(room);

    broadcast(room);
  });

  /* =======================================================
     DRAW
  ======================================================= */

  socket.on("action_draw", (data = {}) => {
    const room = rooms.get(data.roomId);

    if (!room) return;

    const player = getPlayerBySocket(
      room,
      socket.id
    );

    if (!player) return;

    if (room.turnId !== player.id) return;

    if (player.hasDrawn) return;

    if (data.fromDiscard) {
      const topDiscard =
        room.discardPile[
          room.discardPile.length - 1
        ];

      if (!topDiscard) return;

      if (
        room.gameType === "close_master" &&
        ["7", "J"].includes(topDiscard.rank)
      ) {
        socket.emit(
          "show_error",
          "Cannot pick 7 or J from discard pile!"
        );

        return;
      }

      player.hand.push(
        room.discardPile.pop()
      );
    } else {
      const card = drawOneCard(
        room,
        player
      );

      if (!card) return;
    }

    player.hasDrawn = true;

    broadcast(room);
  });

  /* =======================================================
     DROP
  ======================================================= */

  socket.on("action_drop", (data = {}) => {
    const room = rooms.get(data.roomId);

    if (!room) return;

    const player = getPlayerBySocket(
      room,
      socket.id
    );

    if (!player) return;

    if (room.turnId !== player.id) return;

    if (!player.hasDrawn) return;

    const selectedIds = Array.isArray(
      data.selectedIds
    )
      ? data.selectedIds
      : [];

    if (selectedIds.length === 0) return;

    const droppedCards = player.hand.filter(
      (card) =>
        selectedIds.includes(card.id)
    );

    if (droppedCards.length === 0) return;

    /* ---------------------------------------------
       Multiple cards must have same rank
    --------------------------------------------- */

    const firstRank =
      droppedCards[0].rank;

    const allSameRank =
      droppedCards.every(
        (card) => card.rank === firstRank
      );

    if (
      droppedCards.length > 1 &&
      !allSameRank
    ) {
      socket.emit(
        "show_error",
        "Can only drop multiple cards of the same rank!"
      );

      return;
    }

    /* ---------------------------------------------
       CLOSE MASTER
    --------------------------------------------- */

    if (
      room.gameType === "close_master"
    ) {
      /* -------------------------------------------
         7 PENALTY ACTIVE

         Player already took penalty cards.
         They DON'T need to play another 7.

         They can drop ANY valid card/group.
      ------------------------------------------- */

      if (room.penaltyCount > 0) {
        droppedCards.forEach((card) => {
          room.discardPile.push(card);
        });

        const droppedIds = new Set(
          droppedCards.map((c) => c.id)
        );

        player.hand =
          player.hand.filter(
            (card) =>
              !droppedIds.has(card.id)
          );

        /*
          Penalty is resolved.
        */

        room.penaltyCount = 0;

        /*
          If the dropped card is J,
          skip next player.
        */

        const lastDropped =
          droppedCards[
            droppedCards.length - 1
          ];

        player.hasDrawn = false;

        if (lastDropped.rank === "J") {
          moveToNextTurn(room, 2);
        } else if (
          lastDropped.rank === "7"
        ) {
          /*
            IMPORTANT:
            If player voluntarily plays a 7
            after taking the penalty, a new
            +2 penalty starts.
          */
          room.penaltyCount = 1;

          moveToNextTurn(room, 1);
        } else {
          moveToNextTurn(room, 1);
        }

        startTurnTimer(room);

        broadcast(room);

        return;
      }

      /* -------------------------------------------
         NO PENALTY

         SPECIAL 3+ SAME RANK RULE

         If player has 3 or more cards of the
         same rank, they can drop that group
         without taking the middle card when
         the matching top card/rank isn't available.

         This is handled client-side by allowing
         the valid same-rank group to be dropped.
      ------------------------------------------- */

      /*
        Normal cards are dropped.
      */

      droppedCards.forEach((card) => {
        room.discardPile.push(card);
      });

      const droppedIds = new Set(
        droppedCards.map((c) => c.id)
      );

      player.hand =
        player.hand.filter(
          (card) =>
            !droppedIds.has(card.id)
        );

      const lastDropped =
        droppedCards[
          droppedCards.length - 1
        ];

      /* -------------------------------------------
         7
      ------------------------------------------- */

      if (lastDropped.rank === "7") {
        room.penaltyCount = 1;

        player.hasDrawn = false;

        moveToNextTurn(room, 1);

        startTurnTimer(room);

        broadcast(room);

        return;
      }

      /* -------------------------------------------
         J
      ------------------------------------------- */

      if (lastDropped.rank === "J") {
        player.hasDrawn = false;

        /*
          Skip exactly one player.
        */
        moveToNextTurn(room, 2);

        startTurnTimer(room);

        broadcast(room);

        return;
      }

      player.hasDrawn = false;

      moveToNextTurn(room, 1);

      startTurnTimer(room);

      broadcast(room);

      return;
    }

    /* =====================================================
       CARDS SHOW
    ===================================================== */

    if (
      room.gameType === "cards_show"
    ) {
      if (droppedCards.length !== 1) {
        socket.emit(
          "show_error",
          "Select 1 card to discard."
        );

        return;
      }

      const dropCard =
        droppedCards[0];

      player.hand =
        player.hand.filter(
          (card) =>
            card.id !== dropCard.id
        );

      room.discardPile.push(
        dropCard
      );

      player.hasDrawn = false;

      moveToNextTurn(room, 1);

      startTurnTimer(room);

      broadcast(room);

      return;
    }

    /* =====================================================
       SET SHOW
    ===================================================== */

    if (
      room.gameType === "set_show"
    ) {
      droppedCards.forEach((card) => {
        room.discardPile.push(card);
      });

      const droppedIds = new Set(
        droppedCards.map((c) => c.id)
      );

      player.hand =
        player.hand.filter(
          (card) =>
            !droppedIds.has(card.id)
        );

      const ranks =
        player.hand.map(
          (card) => card.rank
        );

      const rankCounts = {};

      ranks.forEach((rank) => {
        if (rank !== "JOKER") {
          rankCounts[rank] =
            (rankCounts[rank] || 0) + 1;
        }
      });

      if (
        Object.values(rankCounts).some(
          (count) => count >= 4
        )
      ) {
        player.bonusUnlocked = true;
      }

      player.hasDrawn = false;

      moveToNextTurn(room, 1);

      startTurnTimer(room);

      broadcast(room);

      return;
    }
  });

  /* =======================================================
     CLOSE MASTER PENALTY RESOLUTION

     Kept as compatibility for existing frontend.

     Player takes penalty cards and then gets
     another opportunity to play according to
     the new rule.
  ======================================================= */

  socket.on(
    "resolve_penalty",
    (data = {}) => {
      const room = rooms.get(
        data.roomId
      );

      if (!room) return;

      const player =
        getPlayerBySocket(
          room,
          socket.id
        );

      if (!player) return;

      if (
        room.gameType !== "close_master"
      ) {
        return;
      }

      if (room.turnId !== player.id) {
        return;
      }

      if (room.penaltyCount <= 0) {
        return;
      }

      const totalCards =
        room.penaltyCount * 2;

      for (
        let i = 0;
        i < totalCards;
        i++
      ) {
        const card = drawOneCard(
          room,
          player
        );

        if (!card) break;
      }

      /*
        IMPORTANT:
        Do NOT end player's turn here.

        Player must be allowed to drop any
        valid card/group after taking penalty.
      */

      player.hasDrawn = true;

      room.penaltyCount = 0;

      broadcast(room);
    }
  );

  /* =======================================================
     CLOSE MASTER CLOSE
  ======================================================= */

  socket.on(
    "action_close",
    (data = {}) => {
      const room = rooms.get(
        data.roomId
      );

      if (!room) return;

      const player =
        getPlayerBySocket(
          room,
          socket.id
        );

      if (!player) return;

      if (
        room.gameType !== "close_master"
      ) {
        return;
      }

      if (
        room.turnId !== player.id ||
        !player.hasDrawn
      ) {
        return;
      }

      const selectedIds =
        Array.isArray(data.selectedIds)
          ? data.selectedIds
          : [];

      if (selectedIds.length !== 1) {
        socket.emit(
          "show_error",
          "Select 1 card to close/discard."
        );

        return;
      }

      const dropCard =
        player.hand.find(
          (card) =>
            card.id ===
            selectedIds[0]
        );

      if (!dropCard) return;

      clearRoomTimer(room);

      player.hand =
        player.hand.filter(
          (card) =>
            card.id !== dropCard.id
        );

      room.discardPile.push(
        dropCard
      );

      const roundPointsMap = {};

      room.players.forEach(
        (pl) => {
          const points =
            pl.id === player.id
              ? 0
              : pl.hand.reduce(
                  (sum, card) => {
                    if (
                      card.rank === "J"
                    ) {
                      return sum + 20;
                    }

                    if (
                      card.rank === "7"
                    ) {
                      return sum + 15;
                    }

                    return (
                      sum +
                      cardValue(
                        card.rank
                      )
                    );
                  },
                  0
                );

          pl.lastRoundPoints =
            points;

          pl.score += points;

          roundPointsMap[
            pl.name
          ] = points;
        }
      );

      room.roundHistory.push({
        round: room.roundNumber,
        points: roundPointsMap,
      });

      room.started = false;

      room.penaltyCount = 0;

      player.hasDrawn = false;

      io.to(room.roomId).emit(
        "close_result",
        {
          winner: player.name,
        }
      );

      broadcast(room);
    }
  );

  /* =======================================================
     CARDS SHOW RESULT
  ======================================================= */

  socket.on(
    "action_show_cards",
    (data = {}) => {
      const room = rooms.get(
        data.roomId
      );

      if (!room) return;

      const player =
        getPlayerBySocket(
          room,
          socket.id
        );

      if (
        !player ||
        room.gameType !==
          "cards_show" ||
        room.turnId !== player.id ||
        !player.hasDrawn
      ) {
        return;
      }

      const selectedIds =
        Array.isArray(data.selectedIds)
          ? data.selectedIds
          : [];

      if (selectedIds.length !== 1) {
        socket.emit(
          "show_error",
          "Select 1 card to discard."
        );

        return;
      }

      const dropCard =
        player.hand.find(
          (card) =>
            card.id ===
            selectedIds[0]
        );

      if (!dropCard) return;

      clearRoomTimer(room);

      player.hand =
        player.hand.filter(
          (card) =>
            card.id !== dropCard.id
        );

      room.discardPile.push(
        dropCard
      );

      const roundPointsMap = {};

      room.players.forEach(
        (pl) => {
          const points =
            pl.id === player.id
              ? 0
              : pl.hand.reduce(
                  (sum, card) =>
                    sum +
                    cardValue(
                      card.rank
                    ),
                  0
                );

          pl.lastRoundPoints =
            points;

          pl.score += points;

          roundPointsMap[
            pl.name
          ] = points;
        }
      );

      room.roundHistory.push({
        round: room.roundNumber,
        points: roundPointsMap,
      });

      room.started = false;

      player.hasDrawn = false;

      io.to(room.roomId).emit(
        "close_result",
        {
          winner: player.name,
        }
      );

      broadcast(room);
    }
  );

  /* =======================================================
     SET SHOW
  ======================================================= */

  socket.on(
    "action_show_set",
    (data = {}) => {
      const room = rooms.get(
        data.roomId
      );

      if (!room) return;

      const player =
        getPlayerBySocket(
          room,
          socket.id
        );

      if (
        !player ||
        room.gameType !==
          "set_show" ||
        room.turnId !== player.id ||
        !player.hasDrawn
      ) {
        return;
      }

      const selectedIds =
        Array.isArray(data.selectedIds)
          ? data.selectedIds
          : [];

      if (selectedIds.length !== 1) {
        socket.emit(
          "show_error",
          "Select 1 card to discard."
        );

        return;
      }

      const dropCard =
        player.hand.find(
          (card) =>
            card.id ===
            selectedIds[0]
        );

      if (!dropCard) return;

      const finalHand =
        player.hand.filter(
          (card) =>
            card.id !== dropCard.id
        );

      const rankCounts = {};

      finalHand.forEach(
        (card) => {
          if (card.rank !== "JOKER") {
            rankCounts[card.rank] =
              (rankCounts[card.rank] ||
                0) + 1;
          }
        }
      );

      const hasValid4CardGroup =
        Object.values(
          rankCounts
        ).some(
          (count) => count >= 4
        );

      if (
        !hasValid4CardGroup &&
        !player.bonusUnlocked
      ) {
        socket.emit(
          "show_error",
          "Invalid Sets! 4-card set cannot contain Jokers."
        );

        return;
      }

      clearRoomTimer(room);

      room.discardPile.push(
        dropCard
      );

      player.hand = finalHand;

      const roundPointsMap = {};

      room.players.forEach(
        (pl) => {
          const points =
            pl.id === player.id
              ? 0
              : pl.hand.reduce(
                  (sum, card) =>
                    sum +
                    cardValue(
                      card.rank
                    ),
                  0
                );

          pl.lastRoundPoints =
            points;

          pl.score += points;

          roundPointsMap[
            pl.name
          ] = points;
        }
      );

      room.roundHistory.push({
        round: room.roundNumber,
        points: roundPointsMap,
      });

      room.started = false;

      player.hasDrawn = false;

      io.to(room.roomId).emit(
        "close_result",
        {
          winner: player.name,
        }
      );

      broadcast(room);
    }
  );

  /* =======================================================
     SAFE DISCONNECT
  ======================================================= */

  let cleanedUp = false;

  const handleDisconnect = () => {
    if (cleanedUp) return;

    cleanedUp = true;

    rooms.forEach(
      (room, roomId) => {
        const player =
          room.players.find(
            (p) =>
              p.socketId === socket.id
          );

        if (!player) return;

        player.isOffline = true;

        const activePlayers =
          getActivePlayers(room);

        if (activePlayers.length === 0) {
          clearRoomTimer(room);

          rooms.delete(roomId);

          return;
        }

        /*
          If disconnected player was
          current player, move turn.
        */
        if (
          room.started &&
          room.turnId === player.id
        ) {
          moveToNextTurn(room, 1);

          startTurnTimer(room);
        }

        broadcast(room);
      }
    );
  };

  /* =======================================================
     EXIT
  ======================================================= */

  socket.on("exit_room", () => {
    handleDisconnect();
  });

  /* =======================================================
     DISCONNECT
  ======================================================= */

  socket.on("disconnect", () => {
    console.log(
      "Socket disconnected:",
      socket.id
    );

    handleDisconnect();
  });
});

/* =========================================================
   SERVER START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server Running on ${PORT}`
    );
  }
);
