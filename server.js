// server.js — quiz server with resume support (minimal changes)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static('public'));
app.use(express.json());

app.get('/host', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host.html')));

// ---- Courses API (list subfolders & CSV files in public/courses) ----
function listDirs(dir){
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch { return []; }
}
function listCsvs(dir){
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.csv'))
      .map(d => d.name)
      .sort();
  } catch { return []; }
}
app.get('/api/courses', (req, res) => {
  const base = path.join(PUBLIC_DIR, 'courses');
  return res.json({ courses: listDirs(base) });
});
app.get('/api/courses/:course/files', (req, res) => {
  const course = (req.params.course || '').replace(/[^a-zA-Z0-9_\-]/g, '');
  const dir = path.join(PUBLIC_DIR, 'courses', course);
  if (!dir.startsWith(path.join(PUBLIC_DIR, 'courses'))) return res.status(400).json({ error: 'Chemin invalide' });
  return res.json({ files: listCsvs(dir) });
});

// ---- Game state ----
const rooms = new Map(); // pin -> state

function newRoomState() {
  return {
    hostId: null,
    resumeScores: new Map(), // name -> score (used on resume)
    players: new Map(), // socket.id -> {name, score, answeredAt, lastCorrect, choiceIndex}
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

// Simple CSV export of current leaderboard (name,score)
app.get('/export/:room', (req, res) => {
  const state = rooms.get(req.params.room);
  if (!state) return res.status(404).send('Salon introuvable');
  const rows = [['name','score']].concat(leaderboard(state).map(r => [r.name, r.score]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="scores_${req.params.room}.csv"`);
  res.send(csv);
});

// ---- RESUME support ----
function loadSnapshot(pin){
  try {
    const file = path.join(SAVE_DIR, `autosave_${pin}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data;
  } catch(e){ console.error('loadSnapshot failed:', e.message); return null; }
}

// POST /resume/:pin -> reconstruct a room from snapshot (scores + last index)
app.post('/resume/:pin', (req, res) => {
  const pin = (req.params.pin || '').trim();
  if (!pin) return res.status(400).json({ ok:false, error:'PIN manquant' });
  ensureSaveDir();
  const snap = loadSnapshot(pin);
  if (!snap) return res.status(404).json({ ok:false, error:'Aucun snapshot pour ce PIN' });

  const state = newRoomState();
  state.pin = pin;
  // last revealed question index (we'll continue with next)
  state.currentIndex = typeof snap?.history?.length === 'number' && snap.history.length > 0
    ? (snap.history[snap.history.length - 1].index)
    : -1;
  state.acceptingAnswers = false;
  state.endAtMs = null;

  // preload scores by name
  if (Array.isArray(snap.leaderboard)) {
    for (const entry of snap.leaderboard) {
      if (entry && entry.name) state.resumeScores.set(entry.name, entry.score || 0);
    }
  }

  rooms.set(pin, state);
  return res.json({ ok:true, pin, currentIndex: state.currentIndex, playersKnown: Array.from(state.resumeScores.entries()) });
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

// ---- Sockets ----
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

  // Host attaches to an existing room (after /resume)
  socket.on('host:attach', ({ roomCode }) => {
    const state = rooms.get(roomCode);
    if (!state) return socket.emit('host:error', 'Salon introuvable pour reprise.');
    state.hostId = socket.id;
    socket.join(roomCode);
    io.to(state.hostId).emit('host:status', { totals: { players: totalPlayers(state), answered: totalAnswered(state) }, accepting: state.acceptingAnswers, endAt: state.endAtMs });
    io.to(state.hostId).emit('host:players', Array.from(state.players.values()).map(p => ({ name: p.name, score: p.score })));
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
    const pname = (name||'Anonyme').trim() || 'Anonyme';
    const resumeScore = state.resumeScores.get(pname) || 0;
    state.players.set(socket.id, { name: pname, score: resumeScore, answeredAt: null, lastCorrect: null, choiceIndex: null });
    io.to(state.hostId).emit('host:players', Array.from(state.players.values()).map(p => ({ name: p.name, score: p.score })));
    io.to(state.hostId).emit('host:status', { totals: { players: totalPlayers(state), answered: totalAnswered(state) }, accepting: state.acceptingAnswers, endAt: state.endAtMs });
    socket.emit('player:joined', { roomCode, name: pname });
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
          const raw = 200 + 800 * speedFactor; // 200..1000
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz server running on http://localhost:' + PORT));
