import { RAW_MCQ_TEXT } from "./rawQuestions.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, onSnapshot,
  updateDoc, serverTimestamp, writeBatch, runTransaction, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

/** ✅ Your Firebase config */
const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b",
  measurementId: "G-SNP025BS5G"
};

const QUESTION_TIME_MS = 20000;  // 20 seconds
const REVEAL_TIME_MS = 4500;     // show answer for 4.5 seconds then host auto-next
const AUTO_NEXT = true;

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const authStatus = $("authStatus");
const nameInput = $("nameInput");
const roomCodeInput = $("roomCodeInput");
const createRoomBtn = $("createRoomBtn");
const joinRoomBtn = $("joinRoomBtn");

const scoreBadge = $("scoreBadge");
const myScoreEl = $("myScore");

const roomCard = $("roomCard");
const roomCodeLabel = $("roomCodeLabel");
const roomStatusLabel = $("roomStatusLabel");
const qNumLabel = $("qNumLabel");
const qTotalLabel = $("qTotalLabel");
const playersList = $("playersList");

const hostControls = $("hostControls");
const startGameBtn = $("startGameBtn");
const nextQuestionBtn = $("nextQuestionBtn");
const endGameBtn = $("endGameBtn");

const questionArea = $("questionArea");
const qText = $("qText");
const optionsArea = $("optionsArea");
const answerInfo = $("answerInfo");
const hintLine = $("hintLine");

const timerText = $("timerText");
const timerFill = $("timerFill");

// ---------- State ----------
let uid = null;
let currentRoomId = null;
let isHost = false;

let currentQuestionDoc = null;
let totalQuestions = 20;

// timing
let questionStartMs = null;   // local ms derived from Firestore Timestamp
let localTick = null;
let revealed = false;

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    authStatus.textContent = `Signed in (anon): ${uid.slice(0, 6)}…`;
  } else {
    authStatus.textContent = "Signing in...";
  }
});
await signInAnonymously(auth);

// ---------- Parse your MCQs ----------
function parseMcqText(raw) {
  const cut = raw.indexOf("## 📊");
  const text = cut > -1 ? raw.slice(0, cut) : raw;

  const blocks = [...text.matchAll(/\*\*(\d+)\.\s([\s\S]*?)\*\*([\s\S]*?)\*\*Answer:\s*([ABCD])\*\*/g)];
  const qs = [];

  for (const m of blocks) {
    const id = Number(m[1]);
    const q = m[2].trim();

    const opts = [];
    for (const om of [...m[3].matchAll(/-\s*[ABCD]\)\s*(.*)/g)]) opts.push(om[1].trim());

    const ansLetter = m[4].trim();
    const answerIndex = { A: 0, B: 1, C: 2, D: 3 }[ansLetter];

    if (opts.length === 4) qs.push({ id, question: q, options: opts, answerIndex });
  }

  return qs.sort((a,b) => a.id - b.id);
}

const QUESTIONS_BANK = parseMcqText(RAW_MCQ_TEXT);
console.log("Loaded questions:", QUESTIONS_BANK.length);

// ---------- Helpers ----------
function makeRoomCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function pickRandomN(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function renderPlayers(players) {
  playersList.innerHTML = "";
  players
    .sort((a,b) => (b.score ?? 0) - (a.score ?? 0))
    .forEach(p => {
      const li = document.createElement("li");
      li.textContent = `${p.name} — ${p.score ?? 0}`;
      playersList.appendChild(li);
    });
}

async function upsertPlayer(roomId, name, hostFlag) {
  const pRef = doc(db, "rooms", roomId, "players", uid);
  await setDoc(pRef, {
    uid,
    name,
    score: 0,
    joinedAt: serverTimestamp(),
    isHost: !!hostFlag,
    answered: {} // map: { [qIndex]: true }
  }, { merge: true });
}

function tsToMs(ts) {
  // Firestore Timestamp has toMillis()
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  return null;
}

function setTimerUI(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  timerText.textContent = String(s).padStart(2, "0");

  const frac = Math.max(0, Math.min(1, msLeft / QUESTION_TIME_MS));
  timerFill.style.transform = `scaleX(${frac})`;
}

function stopTick() {
  if (localTick) clearInterval(localTick);
  localTick = null;
}

// ---------- Question rendering ----------
function renderQuestion(q, qIndex) {
  qText.textContent = q.question;
  optionsArea.innerHTML = "";
  answerInfo.textContent = "";
  hintLine.textContent = "Choose an option before the timer ends.";

  revealed = false;

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "optBtn";
    btn.dataset.idx = String(idx);
    btn.textContent = `${String.fromCharCode(65 + idx)}) ${opt}`;
    btn.onclick = () => submitAnswer(qIndex, idx);
    optionsArea.appendChild(btn);
  });
}

function lockOptions() {
  for (const btn of optionsArea.querySelectorAll("button")) {
    btn.disabled = true;
    btn.classList.add("locked");
  }
}

function revealCorrect(chosenIndex) {
  if (!currentQuestionDoc) return;

  const correct = currentQuestionDoc.answerIndex;

  for (const btn of optionsArea.querySelectorAll("button")) {
    const idx = Number(btn.dataset.idx);
    btn.disabled = true;
    btn.classList.add("locked");
    if (idx === correct) btn.classList.add("correct");
    if (chosenIndex != null && idx === chosenIndex && chosenIndex !== correct) btn.classList.add("wrong");
  }

  if (chosenIndex == null) {
    answerInfo.textContent = `⏱️ Time up! Correct answer: ${String.fromCharCode(65 + correct)}`;
  } else if (chosenIndex === correct) {
    answerInfo.textContent = `✅ Correct! (${String.fromCharCode(65 + correct)})`;
  } else {
    answerInfo.textContent = `❌ Wrong. Correct: ${String.fromCharCode(65 + correct)}`;
  }
  hintLine.textContent = "Next question will start soon.";
}

// ---------- Answer submit (with timer lock) ----------
async function submitAnswer(qIndex, chosenIndex) {
  if (!currentRoomId || !currentQuestionDoc) return;

  // prevent late answers
  if (!questionStartMs) return;
  const now = Date.now();
  if (now > questionStartMs + QUESTION_TIME_MS) return;

  const playerRef = doc(db, "rooms", currentRoomId, "players", uid);
  const correct = currentQuestionDoc.answerIndex;

  await runTransaction(db, async (tx) => {
    const pSnap = await tx.get(playerRef);
    if (!pSnap.exists()) return;

    const p = pSnap.data();
    const answered = p.answered || {};
    if (answered[String(qIndex)]) return;

    answered[String(qIndex)] = true;

    const isCorrect = chosenIndex === correct;
    const newScore = (p.score || 0) + (isCorrect ? 1 : 0);

    tx.update(playerRef, {
      answered,
      score: newScore,
      lastAnswer: { qIndex, chosenIndex, at: serverTimestamp() }
    });
  });

  // small UX: show chosen immediately (final reveal happens at 20s)
  hintLine.textContent = "Answer saved ✅ (Wait for reveal)";
}

// ---------- Attach listeners ----------
function attachRoomListeners(roomId) {
  const roomRef = doc(db, "rooms", roomId);

  // room doc
  onSnapshot(roomRef, async (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();

    roomStatusLabel.textContent = data.status || "waiting";

    const cq = data.currentQuestion ?? 0;
    const tq = data.totalQuestions ?? totalQuestions;
    qNumLabel.textContent = data.status === "live" ? (cq + 1) : "-";
    qTotalLabel.textContent = tq;

    // host controls
    if (isHost) {
      hostControls.classList.remove("hidden");
      startGameBtn.classList.toggle("hidden", data.status !== "waiting");
      nextQuestionBtn.classList.toggle("hidden", data.status !== "live");
      endGameBtn.classList.toggle("hidden", data.status !== "live");
    } else {
      hostControls.classList.add("hidden");
    }

    // question on/off
    questionArea.classList.toggle("hidden", data.status !== "live");

    // timer start time
    const startMs = tsToMs(data.questionStartAt);
    if (data.status === "live" && startMs && startMs !== questionStartMs) {
      questionStartMs = startMs;
      // reset timer tick
      stopTick();
      revealed = false;

      // load question doc
      const qRef = doc(db, "rooms", roomId, "questions", String(cq));
      const qSnap = await getDoc(qRef);
      if (qSnap.exists()) {
        currentQuestionDoc = { id: qSnap.id, ...qSnap.data() };
        renderQuestion(currentQuestionDoc, cq);
        startLocalTimer(cq);
      }
    }

    if (data.status !== "live") {
      stopTick();
      timerText.textContent = "--";
      timerFill.style.transform = "scaleX(1)";
      questionStartMs = null;
      revealed = false;
    }
  });

  // players list (scoreboard)
  const playersQ = query(collection(db, "rooms", roomId, "players"), orderBy("score", "desc"));
  onSnapshot(playersQ, (snap) => {
    const players = snap.docs.map(d => d.data());
    renderPlayers(players);
  });

  // my own score (top-left)
  onSnapshot(doc(db, "rooms", roomId, "players", uid), (snap) => {
    if (!snap.exists()) return;
    const me = snap.data();
    scoreBadge.classList.remove("hidden");
    myScoreEl.textContent = String(me.score ?? 0);
  });
}

async function maybeHostAutoNext() {
  if (!AUTO_NEXT || !isHost || !currentRoomId) return;
  // wait REVEAL_TIME_MS then advance
  await new Promise(r => setTimeout(r, REVEAL_TIME_MS));
  // only advance if still live
  const roomRef = doc(db, "rooms", currentRoomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.status !== "live") return;

  // advance via transaction
  await runTransaction(db, async (tx) => {
    const s = await tx.get(roomRef);
    if (!s.exists()) return;
    const d = s.data();
    const cq = d.currentQuestion ?? 0;
    const tq = d.totalQuestions ?? totalQuestions;

    const next = cq + 1;
    if (next >= tq) {
      tx.update(roomRef, { status: "finished" });
    } else {
      tx.update(roomRef, {
        currentQuestion: next,
        questionStartAt: serverTimestamp()
      });
    }
  });
}

function startLocalTimer(qIndex) {
  stopTick();

  localTick = setInterval(async () => {
    if (!questionStartMs) return;

    const now = Date.now();
    const msLeft = (questionStartMs + QUESTION_TIME_MS) - now;
    setTimerUI(msLeft);

    if (msLeft <= 0 && !revealed) {
      revealed = true;

      // find my last answer for this question (if any) from buttons state is unknown,
      // so we just reveal with "null" locally; score is already in Firestore anyway.
      lockOptions();
      revealCorrect(null);

      stopTick();
      await maybeHostAutoNext();
    }
  }, 120);
}

// ---------- Create Room ----------
createRoomBtn.onclick = async () => {
  const name = nameInput.value.trim() || "Host";

  if (QUESTIONS_BANK.length !== 100) {
    alert("MCQ parsing issue. Ensure rawQuestions.js contains the full 1–100 bank.");
    return;
  }

  const code = makeRoomCode(4);
  roomCodeInput.value = code;

  const roomRef = doc(collection(db, "rooms")); // auto ID
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

  // lookup: roomCodes/{ABCD} -> {roomId}
  await setDoc(doc(db, "roomCodes", code), {
    roomId: roomRef.id,
    createdAt: serverTimestamp()
  });

  await upsertPlayer(roomRef.id, name, true);

  roomCard.classList.remove("hidden");
  roomCodeLabel.textContent = code;

  attachRoomListeners(roomRef.id);
};

// ---------- Join Room ----------
joinRoomBtn.onclick = async () => {
  const name = nameInput.value.trim() || "Player";
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) return alert("Enter room code");

  const codeSnap = await getDoc(doc(db, "roomCodes", code));
  if (!codeSnap.exists()) return alert("Room not found");

  const { roomId } = codeSnap.data();
  currentRoomId = roomId;
  isHost = false;

  await upsertPlayer(roomId, name, false);

  roomCard.classList.remove("hidden");
  roomCodeLabel.textContent = code;

  attachRoomListeners(roomId);
};

// ---------- Host controls ----------
startGameBtn.onclick = async () => {
  if (!currentRoomId) return;

  const selected = pickRandomN(QUESTIONS_BANK, totalQuestions);

  const batch = writeBatch(db);
  selected.forEach((q, idx) => {
    batch.set(doc(db, "rooms", currentRoomId, "questions", String(idx)), {
      question: q.question,
      options: q.options,
      answerIndex: q.answerIndex,
      sourceId: q.id
    });
  });

  batch.update(doc(db, "rooms", currentRoomId), {
    status: "live",
    currentQuestion: 0,
    questionStartAt: serverTimestamp(),
    startedAt: serverTimestamp()
  });

  await batch.commit();
};

nextQuestionBtn.onclick = async () => {
  if (!currentRoomId) return;
  const roomRef = doc(db, "rooms", currentRoomId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const cq = data.currentQuestion ?? 0;
    const tq = data.totalQuestions ?? totalQuestions;

    const next = cq + 1;
    if (next >= tq) {
      tx.update(roomRef, { status: "finished" });
    } else {
      tx.update(roomRef, {
        currentQuestion: next,
        questionStartAt: serverTimestamp()
      });
    }
  });
};

endGameBtn.onclick = async () => {
  if (!currentRoomId) return;
  await updateDoc(doc(db, "rooms", currentRoomId), { status: "finished" });
};
