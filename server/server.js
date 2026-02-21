const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Game topics
const TOPICS = {
  음식: [
    "피자",
    "라면",
    "초밥",
    "떡볶이",
    "치킨",
    "삼겹살",
    "김치찌개",
    "파스타",
    "햄버거",
    "카레",
  ],
  동물: [
    "강아지",
    "고양이",
    "토끼",
    "호랑이",
    "코끼리",
    "기린",
    "펭귄",
    "원숭이",
    "독수리",
    "돌고래",
  ],
  직업: [
    "의사",
    "선생님",
    "요리사",
    "소방관",
    "경찰관",
    "파일럿",
    "디자이너",
    "유튜버",
    "변호사",
    "가수",
  ],
  장소: [
    "놀이공원",
    "도서관",
    "수영장",
    "카페",
    "영화관",
    "병원",
    "학교",
    "마트",
    "공원",
    "헬스장",
  ],
  스포츠: [
    "축구",
    "농구",
    "야구",
    "테니스",
    "수영",
    "복싱",
    "배구",
    "골프",
    "탁구",
    "스키",
  ],
};

const rooms = {};

function getRandomTopic() {
  const categories = Object.keys(TOPICS);
  const category = categories[Math.floor(Math.random() * categories.length)];
  const words = TOPICS[category];
  const word = words[Math.floor(Math.random() * words.length)];
  return { category, word };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", rooms: Object.keys(rooms).length });
});

// 방 생성
app.post("/api/room", (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms[roomId] = {
    id: roomId,
    players: [],
    host: null,
    state: "lobby",
    topic: null,
    liar: null,
    currentTurn: 0,
    turnOrder: [],
    votes: {},
    voteTimer: null,
    round: 1,
    chatMessages: [],
    createdAt: Date.now(),
  };
  console.log(`Room created: ${roomId}`);
  res.json({ roomId });
});

// 방 존재 확인
app.get("/api/room/:roomId", (req, res) => {
  const roomId = req.params.roomId.toUpperCase();
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({
    exists: true,
    playerCount: room.players.length,
    state: room.state,
  });
});

// 오래된 방 정리 (1시간 이상 된 방)
setInterval(
  () => {
    const now = Date.now();
    for (const [id, room] of Object.entries(rooms)) {
      if (now - room.createdAt > 60 * 60 * 1000) {
        delete rooms[id];
        console.log(`Room expired and removed: ${id}`);
      }
    }
  },
  10 * 60 * 1000,
);

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join_room", ({ roomId, nickname, avatar, createIfNotExists }) => {
    // roomId 대소문자 통일
    const rid = (roomId || "").toUpperCase().trim();
    let room = rooms[rid];

    // 서버 재시작 후 방장이 재연결할 때 방을 재생성
    if (!room && createIfNotExists) {
      rooms[rid] = {
        id: rid,
        players: [],
        host: null,
        state: "lobby",
        topic: null,
        liar: null,
        currentTurn: 0,
        turnOrder: [],
        votes: {},
        voteTimer: null,
        round: 1,
        chatMessages: [],
        createdAt: Date.now(),
      };
      room = rooms[rid];
      console.log(`Room re-created by host: ${rid}`);
    }

    if (!room) {
      socket.emit("error", {
        message: `방 코드 "${rid}"를 찾을 수 없습니다. 방이 만료되었거나 코드가 틀렸습니다.`,
      });
      return;
    }
    if (room.state !== "lobby") {
      socket.emit("error", { message: "게임이 이미 진행 중입니다." });
      return;
    }
    if (room.players.length >= 8) {
      socket.emit("error", { message: "방이 가득 찼습니다. (최대 8명)" });
      return;
    }

    // 같은 닉네임 중복 방지
    const duplicate = room.players.find((p) => p.nickname === nickname);
    if (duplicate) {
      socket.emit("error", {
        message: `'${nickname}' 닉네임이 이미 사용 중입니다.`,
      });
      return;
    }

    const player = { id: socket.id, nickname, avatar };
    room.players.push(player);
    if (!room.host) room.host = socket.id;

    socket.join(rid);
    socket.data.roomId = rid;
    socket.data.nickname = nickname;

    console.log(
      `Player "${nickname}" joined room ${rid} (${room.players.length} players)`,
    );

    io.to(rid).emit("room_update", {
      players: room.players,
      host: room.host,
      state: room.state,
    });
    socket.emit("joined", { roomId: rid, isHost: room.host === socket.id });
  });

  socket.on("start_game", ({ roomId }) => {
    const rid = (roomId || "").toUpperCase();
    const room = rooms[rid];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) {
      socket.emit("error", { message: "최소 3명이 필요합니다." });
      return;
    }

    const { category, word } = getRandomTopic();
    const liarIndex = Math.floor(Math.random() * room.players.length);
    const turnOrder = shuffle(room.players.map((p) => p.id));

    room.topic = { category, word };
    room.liar = room.players[liarIndex].id;
    room.turnOrder = turnOrder;
    room.currentTurn = 0;
    room.state = "playing";
    room.votes = {};
    room.chatMessages = [];
    room.round = 1;

    console.log(
      `Game started in room ${rid}. Liar: ${room.players[liarIndex].nickname}, Word: ${word}`,
    );

    room.players.forEach((player) => {
      const isLiar = player.id === room.liar;
      io.to(player.id).emit("game_started", {
        isLiar,
        category,
        word: isLiar ? null : word,
        turnOrder: turnOrder.map((id) => {
          const p = room.players.find((pl) => pl.id === id);
          return { id, nickname: p?.nickname, avatar: p?.avatar };
        }),
        currentTurnPlayerId: turnOrder[0],
      });
    });

    io.to(rid).emit("room_update", {
      players: room.players,
      host: room.host,
      state: room.state,
      currentTurnPlayerId: turnOrder[0],
    });
  });

  socket.on("send_chat", ({ roomId, message }) => {
    const rid = (roomId || "").toUpperCase();
    const room = rooms[rid];
    if (!room || room.state !== "playing") return;

    const currentPlayerId = room.turnOrder[room.currentTurn];
    if (socket.id !== currentPlayerId) {
      socket.emit("error", { message: "지금은 당신의 차례가 아닙니다." });
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    const chatMsg = {
      playerId: socket.id,
      nickname: player?.nickname,
      avatar: player?.avatar,
      message: message.slice(0, 200), // 최대 200자
      timestamp: Date.now(),
    };
    room.chatMessages.push(chatMsg);
    io.to(rid).emit("chat_message", chatMsg);

    // 턴 진행
    room.currentTurn = (room.currentTurn + 1) % room.turnOrder.length;
    if (room.currentTurn === 0) room.round++;

    io.to(rid).emit("turn_changed", {
      currentTurnPlayerId: room.turnOrder[room.currentTurn],
      round: room.round,
    });
  });

  socket.on("call_vote", ({ roomId }) => {
    const rid = (roomId || "").toUpperCase();
    const room = rooms[rid];
    if (!room || room.state !== "playing") return;

    room.state = "voting";
    room.votes = {};
    io.to(rid).emit("voting_started", { timeLimit: 60 });

    room.voteTimer = setTimeout(() => {
      endVoting(rid);
    }, 62000); // 2초 여유
  });

  socket.on("submit_vote", ({ roomId, targetId }) => {
    const rid = (roomId || "").toUpperCase();
    const room = rooms[rid];
    if (!room || room.state !== "voting") return;
    if (room.votes[socket.id]) return; // 이미 투표함

    room.votes[socket.id] = targetId;
    io.to(rid).emit("vote_update", {
      voteCount: Object.keys(room.votes).length,
      totalPlayers: room.players.length,
    });

    if (Object.keys(room.votes).length >= room.players.length) {
      clearTimeout(room.voteTimer);
      endVoting(rid);
    }
  });

  socket.on("next_turn", ({ roomId }) => {
    const rid = (roomId || "").toUpperCase();
    const room = rooms[rid];
    if (!room || room.host !== socket.id) return;
    room.state = "playing";
    io.to(rid).emit("room_update", {
      players: room.players,
      host: room.host,
      state: "playing",
      currentTurnPlayerId: room.turnOrder[room.currentTurn],
    });
  });

  socket.on("return_to_lobby", ({ roomId }) => {
    const rid = (roomId || "").toUpperCase();
    const room = rooms[rid];
    if (!room || room.host !== socket.id) return;
    clearTimeout(room.voteTimer);
    room.state = "lobby";
    room.topic = null;
    room.liar = null;
    room.votes = {};
    room.chatMessages = [];
    room.turnOrder = [];
    io.to(rid).emit("returned_to_lobby");
    io.to(rid).emit("room_update", {
      players: room.players,
      host: room.host,
      state: "lobby",
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const leaving = room.players.find((p) => p.id === socket.id);
    room.players = room.players.filter((p) => p.id !== socket.id);

    console.log(
      `Player "${leaving?.nickname}" left room ${roomId} (${room.players.length} remaining)`,
    );

    if (room.players.length === 0) {
      clearTimeout(room.voteTimer);
      delete rooms[roomId];
      return;
    }
    if (room.host === socket.id) {
      room.host = room.players[0]?.id;
      io.to(room.host).emit("became_host");
    }
    io.to(roomId).emit("player_left", {
      playerId: socket.id,
      nickname: leaving?.nickname,
    });
    io.to(roomId).emit("room_update", {
      players: room.players,
      host: room.host,
      state: room.state,
    });
  });
});

function endVoting(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const tally = {};
  Object.values(room.votes).forEach((targetId) => {
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let eliminated = null;
  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count;
      eliminated = id;
    }
  }

  // 동점 처리: 동점이면 아무도 처치 안 함
  const topCount = Object.values(tally).filter((c) => c === maxVotes).length;
  if (topCount > 1) eliminated = null;

  const eliminatedPlayer = eliminated
    ? room.players.find((p) => p.id === eliminated)
    : null;
  const isLiar = eliminated === room.liar;
  const liarPlayer = room.players.find((p) => p.id === room.liar);

  room.state = "result";

  io.to(roomId).emit("vote_result", {
    eliminated: eliminatedPlayer
      ? {
          id: eliminated,
          nickname: eliminatedPlayer.nickname,
          avatar: eliminatedPlayer.avatar,
        }
      : null,
    isLiar,
    liar: liarPlayer
      ? {
          id: room.liar,
          nickname: liarPlayer.nickname,
          avatar: liarPlayer.avatar,
        }
      : null,
    topic: room.topic,
    tally,
    votes: room.votes,
    tied: topCount > 1,
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Liar Game Server running on port ${PORT}`);
});
