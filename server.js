// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

// Route propre /host (sans extension)
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

const rooms = new Map(); // roomCode -> state

function newRoomState() {
  return {
    hostId: null,
    players: new Map(), // socket.id -> {name, score, answeredAt, lastCorrect, choiceIndex}
    pin: null,
    quiz: [], // [{question, options:["A","B","C","D"], correctIndex, time}]
    currentIndex: -1,
    questionStartTs: null,
    acceptingAnswers: false,
    responses: [0,0,0,0],
    endAtMs: null,
    history: [] // [{index, question, correctIndex, perPlayer:[{name, correct, timeMs, earned}]}]
  };
}

function generatePIN() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function leaderboard(state) {
  return Array.from(state.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 50);
}

function roomCsv(state) {
  const players = Array.from(state.players.values()).map(p => ({name:p.name, score:p.score})).sort((a,b)=>b.score-a.score);
  let lines = [];
  lines.push("Classement,Nom,Score");
  players.forEach((p,i)=>{
    lines.push(`${i+1},${p.name.replaceAll(',',' ')},${p.score}`);
  });
  lines.push("");
  lines.push("Détails par question");
  lines.push("Index,Question,Bonne réponse,Nom,Correct,Temps(ms),Points");
  state.history.forEach(h=>{
    const correctLetter = "ABCD"[h.correctIndex];
    h.perPlayer.forEach(pp=>{
      lines.push(`${h.index+1},"${h.question.replaceAll('"','""')}",${correctLetter},${pp.name.replaceAll(',',' ')},${pp.correct ? "oui":"non"},${pp.timeMs ?? ""},${pp.earned ?? 0}`);
    });
  });
  return lines.join("\n");
}

io.on('connection', (socket) => {
  // Host creates a room
  socket.on('host:createRoom', () => {
    const roomCode = generatePIN();
    const state = newRoomState();
    state.hostId = socket.id;
    state.pin = roomCode;
    rooms.set(roomCode, state);
    socket.join(roomCode);
    socket.emit('host:roomCreated', roomCode);
  });

  // Host loads quiz
  socket.on('host:loadQuiz', ({ roomCode, quiz }) => {
    const state = rooms.get(roomCode);
    if (!state || state.hostId !== socket.id) return;
    const safe = Array.isArray(quiz) ? quiz.filter(q => q && q.question && Array.isArray(q.options) && q.options.length === 4 && typeof q.correctIndex === 'number') : [];
    state.quiz = safe;
    io.to(roomCode).emit('room:quizLoaded', { count: safe.length });
  });

  // Player joins room
  socket.on('player:join', ({ roomCode, name }) => {
    const state = rooms.get(roomCode);
    if (!state) {
      socket.emit('player:error', 'Salon introuvable.');
      return;
    }
    socket.join(roomCode);
    state.players.set(socket.id, { name: (name || 'Anonyme').trim() || 'Anonyme', score: 0, answeredAt: null, lastCorrect: null, choiceIndex: null });
    io.to(state.hostId).emit('host:players', Array.from(state.players.values()).map(p => ({ name: p.name, score: p.score })));
    socket.emit('player:joined', { roomCode, name });
  });

  // Host starts next question
  socket.on('host:nextQuestion', ({ roomCode }) => {
    const state = rooms.get(roomCode);
    if (!state || state.hostId !== socket.id) return;
    state.currentIndex += 1;
    if (state.currentIndex >= state.quiz.length) {
      io.to(roomCode).emit('room:gameOver', { leaderboard: leaderboard(state) });
      state.acceptingAnswers = false;
      return;
    }
    state.responses = [0,0,0,0];
    for (const p of state.players.values()) { p.answeredAt = null; p.lastCorrect = null; p.choiceIndex = null; }
    state.acceptingAnswers = true;
    state.questionStartTs = Date.now();
    const q = state.quiz[state.currentIndex];
    const duration = (q.time ?? 20) * 1000;
    state.endAtMs = state.questionStartTs + duration;

    io.to(roomCode).emit('room:question', {
      index: state.currentIndex,
      total: state.quiz.length,
      question: q.question,
      options: q.options,
      time: q.time ?? 20,
      endAt: state.endAtMs
    });
  });

  // Player answers
  socket.on('player:answer', ({ roomCode, choiceIndex }) => {
    const state = rooms.get(roomCode);
    if (!state || !state.acceptingAnswers) return;
    const player = state.players.get(socket.id);
    if (!player || player.answeredAt !== null) return;

    player.answeredAt = Date.now();
    player.choiceIndex = choiceIndex;
    state.responses[choiceIndex] = (state.responses[choiceIndex] || 0) + 1;

    io.to(roomCode).emit('room:liveResponses', { responses: state.responses });
  });

  // Host reveals correct & scores
  socket.on('host:reveal', ({ roomCode }) => {
    const state = rooms.get(roomCode);
    if (!state || state.hostId !== socket.id) return;
    const q = state.quiz[state.currentIndex];
    state.acceptingAnswers = false;

    const duration = (q.time ?? 20) * 1000;
    const perPlayer = [];
    for (const p of state.players.values()) {
      let earned = 0;
      let timeMs = null;
      if (p.answeredAt !== null && p.choiceIndex !== null) {
        const correct = p.choiceIndex === q.correctIndex;
        p.lastCorrect = !!correct;
        if (correct) {
          const t = Math.max(0, Math.min(duration, p.answeredAt - state.questionStartTs));
          timeMs = t;
          const speedFactor = 1 - (t / duration);
          earned = Math.round(200 + 800 * speedFactor);
          p.score += earned;
        }
      } else {
        p.lastCorrect = false;
      }
      perPlayer.push({ name: p.name, correct: p.lastCorrect, score: p.score, timeMs, earned });
    }

    state.history.push({
      index: state.currentIndex,
      question: q.question,
      correctIndex: q.correctIndex,
      perPlayer
    });

    io.to(roomCode).emit('room:reveal', {
      correctIndex: q.correctIndex,
      leaderboard: leaderboard(state),
      perPlayer
    });
  });

  // Export CSV route
  app.get('/export/:room', (req, res) => {
    const state = rooms.get(req.params.room);
    if (!state) {
      return res.status(404).send('Salon introuvable.');
    }
    const csv = roomCsv(state);
    const fileName = `scores_${req.params.room}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    for (const [roomCode, state] of rooms) {
      if (state.hostId === socket.id) {
        io.to(roomCode).emit('room:ended');
        rooms.delete(roomCode);
        break;
      }
      if (state.players.has(socket.id)) {
        state.players.delete(socket.id);
        io.to(state.hostId).emit('host:players', Array.from(state.players.values()).map(p => ({ name: p.name, score: p.score })));
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Quiz server running on http://localhost:' + PORT);
});