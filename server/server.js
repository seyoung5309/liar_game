const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Game topics
const TOPICS = {
  음식: ['피자', '라면', '초밥', '떡볶이', '치킨', '삼겹살', '김치찌개', '파스타', '햄버거', '카레'],
  동물: ['강아지', '고양이', '토끼', '호랑이', '코끼리', '기린', '펭귄', '원숭이', '독수리', '돌고래'],
  직업: ['의사', '선생님', '요리사', '소방관', '경찰관', '파일럿', '디자이너', '유튜버', '변호사', '가수'],
  장소: ['놀이공원', '도서관', '수영장', '카페', '영화관', '병원', '학교', '마트', '공원', '헬스장'],
  스포츠: ['축구', '농구', '야구', '테니스', '수영', '복싱', '배구', '골프', '탁구', '스키'],
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});


app.post('/api/room', (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms[roomId] = {
    id: roomId,
    players: [],
    host: null,
    state: 'lobby', // lobby, playing, voting, result
    topic: null,
    liar: null,
    currentTurn: 0,
    turnOrder: [],
    votes: {},
    voteTimer: null,
    round: 1,
    chatMessages: [],
  };
  res.json({ roomId });
});

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, playerCount: room.players.length, state: room.state });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join_room', ({ roomId, nickname, avatar }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', { message: '방을 찾을 수 없습니다.' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('error', { message: '게임이 이미 진행 중입니다.' });
      return;
    }
    if (room.players.length >= 8) {
      socket.emit('error', { message: '방이 가득 찼습니다.' });
      return;
    }

    const player = { id: socket.id, nickname, avatar };
    room.players.push(player);
    if (!room.host) room.host = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    io.to(roomId).emit('room_update', {
      players: room.players,
      host: room.host,
      state: room.state,
    });
    socket.emit('joined', { roomId, isHost: room.host === socket.id });
  });

  socket.on('start_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) {
      socket.emit('error', { message: '최소 3명이 필요합니다.' });
      return;
    }

    const { category, word } = getRandomTopic();
    const liarIndex = Math.floor(Math.random() * room.players.length);
    const turnOrder = shuffle(room.players.map(p => p.id));

    room.topic = { category, word };
    room.liar = room.players[liarIndex].id;
    room.turnOrder = turnOrder;
    room.currentTurn = 0;
    room.state = 'playing';
    room.votes = {};
    room.chatMessages = [];
    room.round = 1;

    // Notify each player individually (liar gets no word)
    room.players.forEach(player => {
      const isLiar = player.id === room.liar;
      const turnIndex = turnOrder.indexOf(player.id) + 1;
      io.to(player.id).emit('game_started', {
        isLiar,
        category,
        word: isLiar ? null : word,
        turnOrder: turnOrder.map(id => {
          const p = room.players.find(pl => pl.id === id);
          return { id, nickname: p?.nickname, avatar: p?.avatar };
        }),
        currentTurnPlayerId: turnOrder[0],
      });
    });

    io.to(roomId).emit('room_update', {
      players: room.players,
      host: room.host,
      state: room.state,
      currentTurnPlayerId: turnOrder[0],
    });
  });

  socket.on('send_chat', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    const currentPlayerId = room.turnOrder[room.currentTurn];
    if (socket.id !== currentPlayerId) {
      socket.emit('error', { message: '지금은 당신의 차례가 아닙니다.' });
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    const chatMsg = {
      playerId: socket.id,
      nickname: player?.nickname,
      avatar: player?.avatar,
      message,
      timestamp: Date.now(),
    };
    room.chatMessages.push(chatMsg);
    io.to(roomId).emit('chat_message', chatMsg);

    // Advance turn
    room.currentTurn = (room.currentTurn + 1) % room.turnOrder.length;

    // If back to first player, round complete
    if (room.currentTurn === 0) {
      room.round++;
    }

    io.to(roomId).emit('turn_changed', {
      currentTurnPlayerId: room.turnOrder[room.currentTurn],
      round: room.round,
    });
  });

  socket.on('call_vote', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    room.state = 'voting';
    room.votes = {};
    io.to(roomId).emit('voting_started', {
      timeLimit: 60,
    });

    room.voteTimer = setTimeout(() => {
      endVoting(roomId);
    }, 60000);
  });

  socket.on('submit_vote', ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'voting') return;
    room.votes[socket.id] = targetId;

    io.to(roomId).emit('vote_update', {
      voteCount: Object.keys(room.votes).length,
      totalPlayers: room.players.length,
    });

    // Auto end if all voted
    if (Object.keys(room.votes).length >= room.players.length) {
      clearTimeout(room.voteTimer);
      endVoting(roomId);
    }
  });

  socket.on('skip_vote', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    // Continue playing
    io.to(roomId).emit('vote_skipped');
  });

  socket.on('next_turn', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    room.state = 'playing';
    io.to(roomId).emit('room_update', {
      players: room.players,
      host: room.host,
      state: 'playing',
      currentTurnPlayerId: room.turnOrder[room.currentTurn],
    });
  });

  socket.on('return_to_lobby', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    room.state = 'lobby';
    room.topic = null;
    room.liar = null;
    room.votes = {};
    room.chatMessages = [];
    io.to(roomId).emit('returned_to_lobby');
    io.to(roomId).emit('room_update', {
      players: room.players,
      host: room.host,
      state: 'lobby',
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }
    if (room.host === socket.id) {
      room.host = room.players[0]?.id;
    }
    io.to(roomId).emit('player_left', { playerId: socket.id });
    io.to(roomId).emit('room_update', {
      players: room.players,
      host: room.host,
      state: room.state,
    });
  });
});

function endVoting(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Tally votes
  const tally = {};
  Object.values(room.votes).forEach(targetId => {
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

  const eliminatedPlayer = room.players.find(p => p.id === eliminated);
  const isLiar = eliminated === room.liar;
  const liarPlayer = room.players.find(p => p.id === room.liar);

  room.state = 'result';

  io.to(roomId).emit('vote_result', {
    eliminated: eliminatedPlayer ? { id: eliminated, nickname: eliminatedPlayer.nickname, avatar: eliminatedPlayer.avatar } : null,
    isLiar,
    liar: liarPlayer ? { id: room.liar, nickname: liarPlayer.nickname, avatar: liarPlayer.avatar } : null,
    topic: room.topic,
    tally,
    votes: room.votes,
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
