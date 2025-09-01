// server.js — Auto-reveal, live players counter, persistent PIN
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

const rooms = new Map(); // roomCode -> state

function newRoomState() {
  return {
    hostId: null,
    players: new Map(),
    pin: null,
    quiz: [],
    currentIndex: -1,
    questionStartTs: null,
    acceptingAnswers: false,
    responses: [0,0,0,0],
    endAtMs: null,
    history: [],
  };
}

const SAVE_DIR = path.join(__dirname, 'data');
function ensureSaveDir(){ try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch {} }
function leaderboard(state) {
  return Array.from(state.players.values()).map(p => ({ name: p.name, score: p.score }))
    .sort((a,b) => b.score - a.score).slice(0, 100);
}
function totalPlayers(state){ return state ? state.players.size : 0; }
function totalAnswered(state){
  let n = 0;
  if (!state) return 0;
  for (const p of state.players.values()) if (p.answeredAt !== null) n++;
  return n;
}
function snapshotState(state){
  return { pin: state.pin, currentIndex: state.currentIndex, leaderboard: leaderboard(state), history: state.history, timestamp: new Date().toISOString() };
}
function autosave(roomCode, state){
  ensureSaveDir();
  const file = path.join(SAVE_DIR, `autosave_${roomCode}.json`);
  try { fs.writeFileSync(file, JSON.stringify(snapshotState(state), null, 2), 'utf-8'); } catch(e){ console.error('Autosave failed:', e.message); }
}
app.get('/snapshot/:room', (req, res) => {
  const state = rooms.get(req.params.room);
  if (!state) return res.status(404).json({ error: 'Salon introuvable' });
  res.json(snapshotState(state));
});
function safeQuizArray(quiz){
  const safe = Array.isArray(quiz) ? quiz.filter(q => q && q.question && Array.isArray(q.options) && q.options.length === 4 && typeof q.correctIndex === 'number') : [];
  return safe.map(q => ({
    question: q.question,
    options: q.options.slice(0,4),
    correctIndex: q.correctIndex,
    time: typeof q.time === 'number' && q.time > 0 ? q.time : 20,
    explanation: (q.explanation || '').toString()
  }));
}

io.on('connection', (socket) => {
  socket.on('host:createRoom', () => {
    const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const state = newRoomState();
    state.hostId = socket.id;
    state.pin = roomCode;
    rooms.set(roomCode, state);
    socket.join(roomCode);
    socket.emit('host:roomCreated', roomCode);
    io.to(state.hostId).emit('host:status', { totals: { players: 0, answered: 0 }, accepting: false, endAt: null });
  });

  socket.on('host:loadQuiz', ({ roomCode, quiz }) => {
    const state = rooms.get(roomCode);
    if (!state || state.hostId !== socket.id) return;
    state.quiz = safeQuizArray(quiz);
    io.to(roomCode).emit('room:quizLoaded', { count: state.quiz.length });
  });

  socket.on('player:join', ({ roomCode, name }) => {
    const state = rooms.get(roomCode);
    if (!state) return socket.emit('player:error', 'Salon introuvable.');
    socket.join(roomCode);
    state.players.set(socket.id, { name: (name||'Anonyme').trim() || 'Anonyme', score: 0, answeredAt: null, lastCorrect: null, choiceIndex: null });
    io.to(state.hostId).emit('host:players', Array.from(state.players.values()).map(p => ({ name: p.name, score: p.score })));
    io.to(state.hostId).emit('host:status', { totals: { players: totalPlayers(state), answered: totalAnswered(state) }, accepting: state.acceptingAnswers, endAt: state.endAtMs });
    socket.emit('player:joined', { roomCode, name });
  });

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
      endAt: state.endAtMs,
      totals: { players: totalPlayers(state), answered: 0 }
    });
    io.to(state.hostId).emit('host:status', { totals: { players: totalPlayers(state), answered: 0 }, accepting: true, endAt: state.endAtMs });
  });

  function doReveal(roomCode, state){
    if (!state || state.acceptingAnswers === false) return;
    if (state.currentIndex < 0 || state.currentIndex >= state.quiz.length) return;
    const q = state.quiz[state.currentIndex];
    if (!q) return;
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
          const raw = 200 + 800 * speedFactor;
          earned = Math.round(raw / 50) * 50;
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
      perPlayer,
      explanation: q.explanation || ''
    });

    io.to(roomCode).emit('room:reveal', {
      correctIndex: q.correctIndex,
      leaderboard: leaderboard(state),
      perPlayer,
      explanation: q.explanation || ''
    });
    io.to(state.hostId).emit('host:counts', {
      counts: state.responses,
      correctIndex: q.correctIndex,
      totals: { players: totalPlayers(state), answered: totalAnswered(state) }
    });
    autosave(roomCode, state);
  }

  socket.on('player:answer', ({ roomCode, choiceIndex }) => {
    const state = rooms.get(roomCode);
    if (!state || !state.acceptingAnswers) return;
    const player = state.players.get(socket.id);
    if (!player || player.answeredAt !== null) return;
    player.answeredAt = Date.now();
    player.choiceIndex = choiceIndex;
    if (choiceIndex >= 0 && choiceIndex < 4) state.responses[choiceIndex] = (state.responses[choiceIndex] || 0) + 1;
    const totals = { players: totalPlayers(state), answered: totalAnswered(state) };
    io.to(state.hostId).emit('host:status', { totals, accepting: state.acceptingAnswers, endAt: state.endAtMs });
    if (totals.answered >= totals.players && totals.players > 0) { doReveal(roomCode, state); }
  });

  socket.on('host:reveal', ({ roomCode }) => {
    const state = rooms.get(roomCode);
    if (!state || state.hostId !== socket.id) return;
    doReveal(roomCode, state);
  });

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
        io.to(state.hostId).emit('host:status', {
          totals: { players: totalPlayers(state), answered: totalAnswered(state) },
          accepting: state.acceptingAnswers,
          endAt: state.endAtMs
        });
        break;
      }
    }
  });
});

process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz server running on http://localhost:' + PORT));
