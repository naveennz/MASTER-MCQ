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

// Timings
const QUESTION_TIME = 30000;
const REVEAL_TIME = 6000;

let uid, currentRoomId, isHost = false;
let currentQuestionData = null;

// Auth
onAuthStateChanged(auth, (u) => { if(u) uid = u.uid; document.getElementById('authStatus').innerText = u ? "Connected" : "Error"; });
await signInAnonymously(auth);

// Parse Questions from rawQuestions.js
function parseQuestions(text) {
  const regex = /\*\*(\d+)\.\s([\s\S]*?)\*\*([\s\S]*?)\*\*Answer:\s*([ABCD])\*\*/g;
  const matches = [...text.matchAll(regex)];
  return matches.map(m => {
    const opts = [...m[3].matchAll(/-\s*[ABCD]\)\s*(.*)/g)].map(o => o[1].trim());
    return { id: m[1], q: m[2].trim(), opts, ans: {A:0, B:1, C:2, D:3}[m[4]] };
  });
}
const BANK = parseQuestions(RAW_MCQ_TEXT);

// Screens
function showScreen(id) {
  ['setupScreen', 'lobbyScreen', 'gameScreen', 'resultScreen'].forEach(s => document.getElementById(s).classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// Room Logic
async function joinRoom(roomId, name, hostFlag) {
  currentRoomId = roomId;
  isHost = hostFlag;
  await setDoc(doc(db, "rooms", roomId, "players", uid), { name, score: 0, isHost: hostFlag });
  showScreen('lobbyScreen');
  listenToRoom(roomId);
}

function listenToRoom(roomId) {
  // Listen to Players (So host can see who joined)
  onSnapshot(collection(db, "rooms", roomId, "players"), (snap) => {
    const list = document.getElementById('playersList');
    list.innerHTML = "";
    document.getElementById('playerCountLabel').innerText = `${snap.size} Player(s) Joined`;
    snap.forEach(d => {
      const p = d.data();
      list.innerHTML += `<div class="player-tag">${p.name} ${p.isHost ? '(Host)' : ''}</div>`;
    });
  });

  // Listen to Room Status
  onSnapshot(doc(db, "rooms", roomId), async (snap) => {
    const data = snap.data();
    if (!data) return;
    document.getElementById('roomCodeLabel').innerText = data.roomCode;
    
    if (isHost) {
        document.getElementById('hostControls').classList.remove('hidden');
        document.getElementById('waitingMsg').classList.add('hidden');
    }

    if (data.status === "live") {
      showScreen('gameScreen');
      loadQuestion(data.currentQuestion, data.questionStartAt?.toMillis());
    }
    if (data.status === "finished") {
      showScreen('resultScreen');
      showPodium();
    }
  });
}

async function loadQuestion(idx, startTs) {
  const qSnap = await getDoc(doc(db, "rooms", currentRoomId, "questions", String(idx)));
  currentQuestionData = qSnap.data();
  document.getElementById('qNumLabel').innerText = idx + 1;
  document.getElementById('qText').innerText = currentQuestionData.q;
  
  const opts = document.getElementById('optionsArea');
  opts.innerHTML = "";
  currentQuestionData.opts.forEach((o, i) => {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.innerText = o;
    btn.onclick = () => submitAnswer(idx, i, btn);
    opts.appendChild(btn);
  });

  runTimer(startTs);
}

function runTimer(startTs) {
  const timerLoop = setInterval(() => {
    const now = Date.now();
    const diff = (startTs + QUESTION_TIME) - now;
    const pct = Math.max(0, (diff / QUESTION_TIME) * 100);
    
    document.getElementById('timerFill').style.width = pct + "%";
    document.getElementById('timerLabel').innerText = Math.ceil(Math.max(0, diff/1000)) + "s";

    if (diff <= 0) {
      clearInterval(timerLoop);
      revealAnswer();
      if (isHost) setTimeout(nextQuestion, REVEAL_TIME);
    }
  }, 100);
}

function revealAnswer() {
  const btns = document.getElementById('optionsArea').querySelectorAll('button');
  btns.forEach((b, i) => {
    b.disabled = true;
    if (i === currentQuestionData.ans) b.classList.add('correct');
  });
}

async function submitAnswer(qIdx, choice, btn) {
  const isCorrect = choice === currentQuestionData.ans;
  if (!isCorrect) btn.classList.add('wrong');
  
  const pRef = doc(db, "rooms", currentRoomId, "players", uid);
  const pSnap = await getDoc(pRef);
  await updateDoc(pRef, { score: (pSnap.data().score || 0) + (isCorrect ? 100 : 0) });
  
  document.querySelectorAll('.opt').forEach(b => b.disabled = true);
}

async function nextQuestion() {
  const roomRef = doc(db, "rooms", currentRoomId);
  const snap = await getDoc(roomRef);
  const next = snap.data().currentQuestion + 1;
  if (next >= 20) await updateDoc(roomRef, { status: "finished" });
  else await updateDoc(roomRef, { currentQuestion: next, questionStartAt: serverTimestamp() });
}

async function showPodium() {
  const q = query(collection(db, "rooms", currentRoomId, "players"), orderBy("score", "desc"));
  const snap = await getDoc(q);
  const area = document.getElementById('podiumArea');
  area.innerHTML = "";
  snap.forEach(d => {
    const p = d.data();
    area.innerHTML += `<div class="podium-item"><span>${p.name}</span><span>${p.score} pts</span></div>`;
  });
}

// Button Events
document.getElementById('createRoomBtn').onclick = async () => {
  const code = Math.random().toString(36).substring(2,6).toUpperCase();
  const roomRef = doc(collection(db, "rooms"));
  await setDoc(roomRef, { roomCode: code, status: "waiting", currentQuestion: 0, totalQuestions: 20 });
  await setDoc(doc(db, "roomCodes", code), { roomId: roomRef.id });
  joinRoom(roomRef.id, document.getElementById('nameInput').value || "Host", true);
};

document.getElementById('joinRoomBtn').onclick = async () => {
  const code = document.getElementById('roomCodeInput').value.toUpperCase();
  const codeSnap = await getDoc(doc(db, "roomCodes", code));
  if (codeSnap.exists()) joinRoom(codeSnap.data().roomId, document.getElementById('nameInput').value || "Player", false);
  else alert("Room not found");
};

document.getElementById('startGameBtn').onclick = async () => {
  const selected = BANK.sort(() => 0.5 - Math.random()).slice(0, 20);
  const batch = writeBatch(db);
  selected.forEach((q, i) => batch.set(doc(db, "rooms", currentRoomId, "questions", String(i)), q));
  batch.update(doc(db, "rooms", currentRoomId), { status: "live", questionStartAt: serverTimestamp() });
  await batch.commit();
};
