import { RAW_MCQ_TEXT } from "./rawQuestions.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, onSnapshot,
  updateDoc, serverTimestamp, writeBatch, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b",
  measurementId: "G-SNP025BS5G"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Timing Constants
const QUESTION_TIME = 15000; // 15s
const REVEAL_TIME = 5000;    // 5s

let uid, currentRoomId, isHost = false;
let currentQ = null;
let timerInterval = null;
let hasRevealed = false;

// Helpers
const $ = (id) => document.getElementById(id);
const hideAll = () => ['setupScreen','lobbyScreen','gameScreen','resultScreen'].forEach(s => $(s).classList.add('hidden'));

// Auth
onAuthStateChanged(auth, u => { if(u) uid = u.uid; });
await signInAnonymously(auth);

function parseQs(text) {
  const blocks = [...text.matchAll(/\*\*(\d+)\.\s([\s\S]*?)\*\*([\s\S]*?)\*\*Answer:\s*([ABCD])\*\*/g)];
  return blocks.map(m => ({
    id: m[1], q: m[2].trim(), 
    opts: [...m[3].matchAll(/-\s*[ABCD]\)\s*(.*)/g)].map(o => o[1].trim()),
    ans: {A:0, B:1, C:2, D:3}[m[4]]
  }));
}
const BANK = parseQs(RAW_MCQ_TEXT);

// Room Sync
function initListeners(roomId) {
  // 1. Players & Scores (Persistent Score Card)
  onSnapshot(collection(db, "rooms", roomId, "players"), (snap) => {
    const scoreList = $('scoreList');
    const lobbyPlayers = $('playersGrid');
    scoreList.innerHTML = "";
    lobbyPlayers.innerHTML = "";
    
    let allFinished = true;
    let players = [];
    
    snap.forEach(d => {
      const p = d.data();
      players.push(p);
      scoreList.innerHTML += `<div class="score-entry"><span>${p.name}</span><span>${p.score}</span></div>`;
      lobbyPlayers.innerHTML += `<div style="padding:10px; background:#f9fafb; border-radius:8px; font-size:12px; font-weight:700">${p.name}</div>`;
      
      // Check if everyone answered current question
      if (currentQ !== null && (!p.answered || !p.answered[currentQ])) allFinished = false;
    });

    $('playerStatus').innerText = `${snap.size} Player(s) in room`;
    
    // Quick Reveal: If everyone answered, trigger early reveal
    if (snap.size > 1 && allFinished && !hasRevealed && currentQ !== null) {
        revealAnswer();
    }
  });

  // 2. Room State
  onSnapshot(doc(db, "rooms", roomId), async (snap) => {
    const data = snap.data();
    if (!data) return;
    
    if (data.status === "waiting") { hideAll(); $('lobbyScreen').classList.remove('hidden'); }
    if (data.status === "live") { 
        hideAll(); 
        $('gameScreen').classList.remove('hidden'); 
        $('liveScoreCard').classList.remove('hidden');
        syncQuestion(data.currentQuestion, data.questionStartAt?.toMillis());
    }
    if (data.status === "finished") { hideAll(); $('resultScreen').classList.remove('hidden'); showFinal(); }
    
    if (isHost) $('hostControls').classList.remove('hidden');
    $('roomCodeLabel').innerText = data.roomCode;
  });
}

async function syncQuestion(idx, startMs) {
  if (currentQ === idx) return; // Prevent duplicate loads
  currentQ = idx;
  hasRevealed = false;
  
  const qDoc = await getDoc(doc(db, "rooms", currentRoomId, "questions", String(idx)));
  const data = qDoc.data();
  
  $('qNum').innerText = idx + 1;
  $('qText').innerText = data.q;
  $('optionsArea').innerHTML = "";
  
  data.opts.forEach((o, i) => {
    const btn = document.createElement('button');
    btn.className = 'opt-btn';
    btn.innerText = o;
    btn.onclick = () => submit(idx, i, data.ans, btn);
    $('optionsArea').appendChild(btn);
  });

  startTimer(startMs);
}

function startTimer(startMs) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.max(0, (startMs + QUESTION_TIME) - now);
    const pct = (remaining / QUESTION_TIME) * 100;
    
    $('timerFill').style.width = pct + "%";
    $('timerText').innerText = Math.ceil(remaining/1000) + "s";

    if (remaining <= 0 && !hasRevealed) {
      revealAnswer();
    }
  }, 50); // High frequency for smooth bar
}

function revealAnswer() {
  hasRevealed = true;
  if (timerInterval) clearInterval(timerInterval);
  
  // Disable and highlight correct
  getDoc(doc(db, "rooms", currentRoomId, "questions", String(currentQ))).then(s => {
    const correctIdx = s.data().ans;
    const btns = $('optionsArea').querySelectorAll('button');
    btns.forEach((b, i) => {
        b.disabled = true;
        if (i === correctIdx) b.classList.add('correct');
    });
    
    if (isHost) setTimeout(moveNext, REVEAL_TIME);
  });
}

async function submit(qIdx, choice, correct, btn) {
  if (hasRevealed) return;
  const isCorrect = choice === correct;
  if (!isCorrect) btn.classList.add('wrong');
  
  const pRef = doc(db, "rooms", currentRoomId, "players", uid);
  const snap = await getDoc(pRef);
  const currentScore = snap.data().score || 0;
  
  await updateDoc(pRef, { 
    score: currentScore + (isCorrect ? 100 : 0),
    [`answered.${qIdx}`]: true 
  });
  
  $('optionsArea').querySelectorAll('button').forEach(b => b.disabled = true);
}

async function moveNext() {
  const roomRef = doc(db, "rooms", currentRoomId);
  const snap = await getDoc(roomRef);
  const next = snap.data().currentQuestion + 1;
  if (next >= 20) await updateDoc(roomRef, { status: "finished" });
  else await updateDoc(roomRef, { currentQuestion: next, questionStartAt: serverTimestamp() });
}

async function showFinal() {
  const q = query(collection(db, "rooms", currentRoomId, "players"), orderBy("score", "desc"));
  const snap = await getDoc(q);
  $('podiumArea').innerHTML = "";
  snap.forEach(d => {
    const p = d.data();
    $('podiumArea').innerHTML += `<div class="podium-row"><b>${p.name}</b> <span>${p.score} pts</span></div>`;
  });
}

// UI Events
$('createRoomBtn').onclick = async () => {
  const code = Math.random().toString(36).substring(2,6).toUpperCase();
  const roomRef = doc(collection(db, "rooms"));
  await setDoc(roomRef, { roomCode: code, status: "waiting", currentQuestion: 0, totalQuestions: 20 });
  await setDoc(doc(db, "roomCodes", code), { roomId: roomRef.id });
  isHost = true;
  currentRoomId = roomRef.id;
  await setDoc(doc(db, "rooms", currentRoomId, "players", uid), { name: $('nameInput').value || "Host", score: 0, isHost: true });
  initListeners(currentRoomId);
};

$('joinRoomBtn').onclick = async () => {
  const code = $('roomCodeInput').value.toUpperCase();
  const cSnap = await getDoc(doc(db, "roomCodes", code));
  if (cSnap.exists()) {
    currentRoomId = cSnap.data().roomId;
    await setDoc(doc(db, "rooms", currentRoomId, "players", uid), { name: $('nameInput').value || "Player", score: 0, isHost: false });
    initListeners(currentRoomId);
  } else alert("Room not found");
};

$('startGameBtn').onclick = async () => {
  const batch = writeBatch(db);
  pickRandom(BANK, 20).forEach((q, i) => batch.set(doc(db, "rooms", currentRoomId, "questions", String(i)), q));
  batch.update(doc(db, "rooms", currentRoomId), { status: "live", questionStartAt: serverTimestamp() });
  await batch.commit();
};

function pickRandom(arr, n) { return [...arr].sort(() => 0.5 - Math.random()).slice(0, n); }
