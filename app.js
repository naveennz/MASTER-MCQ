import { RAW_MCQ_TEXT } from "./rawQuestions.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, onSnapshot,
  updateDoc, serverTimestamp, writeBatch, runTransaction, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

/** ✅ Keeping your exact Firebase config */
const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b",
  measurementId: "G-SNP025BS5G"
};

// Updated Timings for Education
const QUESTION_TIME_MS = 30000;  // 30 seconds to read and answer
const REVEAL_TIME_MS = 6000;     // 6 seconds to show the correct answer
const AUTO_NEXT = true;

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---------- UI Elements ----------
const $ = (id) => document.getElementById(id);
const authStatus = $("authStatus");
const setupScreen = $("setupScreen");
const gameView = $("gameView");
const lobbyArea = $("lobbyArea");
const questionArea = $("questionArea");
const resultsArea = $("resultsArea");
const timerFill = $("timerFill");
const timerText = $("timerText");
const feedbackArea = $("feedbackArea");

// ---------- State ----------
let uid = null;
let currentRoomId = null;
let isHost = false;
let currentQuestionDoc = null;
let totalQuestions = 20;
let questionStartMs = null;
let localTick = null;
let revealed = false;

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) { uid = user.uid; authStatus.textContent = "ID: " + uid.slice(0, 4); }
  else { authStatus.textContent = "Connecting..."; }
});
await signInAnonymously(auth);

// ---------- Question Parsing ----------
function parseMcqText(raw) {
  const blocks = [...raw.matchAll(/\*\*(\d+)\.\s([\s\S]*?)\*\*([\s\S]*?)\*\*Answer:\s*([ABCD])\*\*/g)];
  return blocks.map(m => {
    const opts = [];
    for (const om of [...m[3].matchAll(/-\s*[ABCD]\)\s*(.*)/g)]) opts.push(om[1].trim());
    return { 
        id: Number(m[1]), 
        question: m[2].trim(), 
        options: opts, 
        answerIndex: { A:0, B:1, C:2, D:3 }[m[4].trim()] 
    };
  }).filter(q => q.options.length === 4).sort((a,b) => a.id - b.id);
}
const QUESTIONS_BANK = parseMcqText(RAW_MCQ_TEXT);

// ---------- Helpers ----------
function makeRoomCode() { return Math.random().toString(36).substring(2,6).toUpperCase(); }
function pickRandomN(arr, n) { return [...arr].sort(() => 0.5 - Math.random()).slice(0, n); }

function switchScreen(screen) {
    [setupScreen, lobbyArea, questionArea, resultsArea].forEach(el => el.classList.add("hidden"));
    if (screen === 'setup') setupScreen.classList.remove("hidden");
    if (screen === 'lobby') { gameView.classList.remove("hidden"); lobbyArea.classList.remove("hidden"); }
    if (screen === 'game') { gameView.classList.remove("hidden"); questionArea.classList.remove("hidden"); }
    if (screen === 'results') { gameView.classList.remove("hidden"); resultsArea.classList.remove("hidden"); }
}

// ---------- Game Logic ----------
async function submitAnswer(qIndex, chosenIndex) {
  if (!questionStartMs || Date.now() > questionStartMs + QUESTION_TIME_MS) return;
  
  const playerRef = doc(db, "rooms", currentRoomId, "players", uid);
  await runTransaction(db, async (tx) => {
    const pSnap = await tx.get(playerRef);
    const p = pSnap.data();
    if (p.answered?.[qIndex]) return;
    
    const isCorrect = chosenIndex === currentQuestionDoc.answerIndex;
    tx.update(playerRef, {
      [`answered.${qIndex}`]: true,
      score: (p.score || 0) + (isCorrect ? 100 : 0), // Education points!
      lastAnswer: { qIndex, chosenIndex }
    });
  });

  // visual feedback
  const btns = $("optionsArea").querySelectorAll("button");
  btns.forEach((b, i) => {
    b.disabled = true;
    if (i === chosenIndex) b.style.borderColor = "var(--accent)";
  });
  feedbackArea.classList.remove("hidden");
  feedbackArea.textContent = "Answer Locked. Waiting for reveal...";
  feedbackArea.style.color = "var(--muted)";
}

function revealCorrect() {
  const correct = currentQuestionDoc.answerIndex;
  const btns = $("optionsArea").querySelectorAll("button");
  
  btns.forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === correct) btn.classList.add("correct");
    else btn.classList.add("wrong");
  });

  feedbackArea.classList.remove("hidden");
  feedbackArea.textContent = `Correct Answer: ${String.fromCharCode(65 + correct)}`;
  feedbackArea.style.color = "var(--success)";
}

function attachRoomListeners(roomId) {
  const roomRef = doc(db, "rooms", roomId);

  onSnapshot(roomRef, async (snap) => {
    const data = snap.data();
    if (!data) return;

    if (data.status === "waiting") switchScreen('lobby');
    if (data.status === "live") switchScreen('game');
    if (data.status === "finished") {
        switchScreen('results');
        renderPodium(roomId);
        return;
    }

    $("roomCodeLabel").textContent = data.roomCode;
    $("qNumLabel").textContent = data.currentQuestion + 1;
    $("qTotalLabel").textContent = data.totalQuestions;

    if (isHost) $("hostControls").classList.remove("hidden");

    const startMs = data.questionStartAt?.toMillis();
    if (data.status === "live" && startMs && startMs !== questionStartMs) {
      questionStartMs = startMs;
      revealed = false;
      const qSnap = await getDoc(doc(db, "rooms", roomId, "questions", String(data.currentQuestion)));
      currentQuestionDoc = qSnap.data();
      renderQuestion(data.currentQuestion);
      startTimer();
    }
  });

  // Live Scores
  const playersQ = query(collection(db, "rooms", roomId, "players"), orderBy("score", "desc"));
  onSnapshot(playersQ, (snap) => {
    const players = snap.docs.map(d => d.data());
    const list = $("playersList");
    list.innerHTML = "";
    players.forEach(p => {
        list.innerHTML += `
            <li class="player-item">
                <span class="player-name">${p.name}</span>
                <span class="player-score">${p.score}</span>
            </li>
        `;
    });
  });
}

function renderQuestion(idx) {
    $("qText").textContent = currentQuestionDoc.question;
    feedbackArea.classList.add("hidden");
    const area = $("optionsArea");
    area.innerHTML = "";
    currentQuestionDoc.options.forEach((opt, i) => {
        const btn = document.createElement("button");
        btn.className = "opt-btn";
        btn.textContent = opt;
        btn.onclick = () => submitAnswer(idx, i);
        area.appendChild(btn);
    });
}

function startTimer() {
  if (localTick) clearInterval(localTick);
  localTick = setInterval(async () => {
    const elapsed = Date.now() - questionStartMs;
    const remaining = QUESTION_TIME_MS - elapsed;
    
    timerText.textContent = Math.max(0, Math.ceil(remaining / 1000));
    timerFill.style.width = `${(remaining / QUESTION_TIME_MS) * 100}%`;

    if (remaining <= 0 && !revealed) {
      revealed = true;
      revealCorrect();
      if (isHost) setTimeout(nextQuestion, REVEAL_TIME_MS);
    }
  }, 100);
}

async function nextQuestion() {
    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);
    const data = snap.data();
    const next = data.currentQuestion + 1;

    if (next >= data.totalQuestions) {
        await updateDoc(roomRef, { status: "finished" });
    } else {
        await updateDoc(roomRef, {
            currentQuestion: next,
            questionStartAt: serverTimestamp()
        });
    }
}

async function renderPodium(roomId) {
    const snap = await getDoc(collection(db, "rooms", roomId, "players"));
    // Since we need them ordered, query again
    const q = query(collection(db, "rooms", roomId, "players"), orderBy("score", "desc"));
    const playersSnap = await getDoc(q);
    const top = playersSnap.docs.map(d => d.data());

    const podium = $("podiumArea");
    podium.innerHTML = "";
    
    // Order: 2nd, 1st, 3rd for visual effect
    const spots = [
        { data: top[1], class: "place-2", label: "2nd" },
        { data: top[0], class: "place-1", label: "Winner" },
        { data: top[2], class: "place-3", label: "3rd" }
    ];

    spots.forEach(s => {
        if (!s.data) return;
        podium.innerHTML += `
            <div class="podium-place ${s.class}">
                <div class="winner-name">${s.data.name}</div>
                <div style="margin-top:auto; padding-bottom:10px; font-weight:800;">${s.label}</div>
            </div>
        `;
    });
}

// ---------- UI Actions ----------
$("createRoomBtn").onclick = async () => {
  const name = $("nameInput").value.trim() || "Host";
  const code = makeRoomCode();
  const roomRef = doc(collection(db, "rooms"));
  currentRoomId = roomRef.id;
  isHost = true;

  await setDoc(roomRef, {
    roomCode: code,
    hostId: uid,
    status: "waiting",
    currentQuestion: 0,
    totalQuestions,
    createdAt: serverTimestamp()
  });
  await setDoc(doc(db, "roomCodes", code), { roomId: roomRef.id });
  await setDoc(doc(db, "rooms", currentRoomId, "players", uid), {
    name, score: 0, isHost: true
  });

  attachRoomListeners(currentRoomId);
};

$("joinRoomBtn").onclick = async () => {
    const code = $("roomCodeInput").value.trim().toUpperCase();
    const name = $("nameInput").value.trim() || "Player";
    if (!code) return alert("Enter Code");

    const codeSnap = await getDoc(doc(db, "roomCodes", code));
    if (!codeSnap.exists()) return alert("Room not found");

    currentRoomId = codeSnap.data().roomId;
    await setDoc(doc(db, "rooms", currentRoomId, "players", uid), {
        name, score: 0, isHost: false
    });
    attachRoomListeners(currentRoomId);
};

$("startGameBtn").onclick = async () => {
  const selected = pickRandomN(QUESTIONS_BANK, totalQuestions);
  const batch = writeBatch(db);
  selected.forEach((q, idx) => {
    batch.set(doc(db, "rooms", currentRoomId, "questions", String(idx)), q);
  });
  batch.update(doc(db, "rooms", currentRoomId), {
    status: "live",
    questionStartAt: serverTimestamp()
  });
  await batch.commit();
};
