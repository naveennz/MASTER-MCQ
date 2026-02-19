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

// ---------- State ----------
let uid = null;
let currentRoomId = null;
let currentRoomCode = null;
let isHost = false;
let currentQuestionDoc = null;
let totalQuestions = 20;

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

// ---------- Parsing your MCQs ----------
function parseMcqText(raw) {
  // ignore answer key table if present
  const cut = raw.indexOf("## 📊");
  const text = cut > -1 ? raw.slice(0, cut) : raw;

  const blocks = [...text.matchAll(/\*\*(\d+)\.\s([\s\S]*?)\*\*([\s\S]*?)\*\*Answer:\s*([ABCD])\*\*/g)];
  const qs = [];

  for (const m of blocks) {
    const id = Number(m[1]);
    const q = m[2].trim();
    const optsRaw = m[3];

    const opts = [];
    const optMatches = [...optsRaw.matchAll(/-\s*[ABCD]\)\s*(.*)/g)];
    for (const om of optMatches) opts.push(om[1].trim());

    const ansLetter = m[4].trim();
    const answerIndex = { A: 0, B: 1, C: 2, D: 3 }[ansLetter];

    if (opts.length === 4) {
      qs.push({ id, question: q, options: opts, answerIndex });
    }
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
  const pRef = doc(db, "rooms", roomId, "players", uid); // doc id = uid (simplifies)
  await setDoc(pRef, {
    uid,
    name,
    score: 0,
    joinedAt: serverTimestamp(),
    isHost: !!hostFlag,
    answered: {} // map: { [qIndex]: true }
  }, { merge: true });
}

function attachRoomListeners(roomId) {
  const roomRef = doc(db, "rooms", roomId);

  onSnapshot(roomRef, async (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();

    roomStatusLabel.textContent = data.status || "waiting";
    currentRoomCode = data.roomCode;

    const cq = data.currentQuestion ?? 0;
    const tq = data.totalQuestions ?? totalQuestions;
    qNumLabel.textContent = data.status === "live" ? (cq + 1) : "-";
    qTotalLabel.textContent = tq;

    // host buttons
    if (isHost) {
      hostControls.classList.remove("hidden");
      startGameBtn.classList.toggle("hidden", data.status !== "waiting");
      nextQuestionBtn.classList.toggle("hidden", data.status !== "live");
      endGameBtn.classList.toggle("hidden", data.status !== "live");
    } else {
      hostControls.classList.add("hidden");
    }

    // show question when live
    questionArea.classList.toggle("hidden", data.status !== "live");

    // load current question doc
    if (data.status === "live") {
      const qRef = doc(db, "rooms", roomId, "questions", String(cq));
      const qSnap = await getDoc(qRef);
      if (qSnap.exists()) {
        currentQuestionDoc = { id: qSnap.id, ...qSnap.data() };
        renderQuestion(currentQuestionDoc, cq);
      }
    }
  });

  // players list
  const playersQ = query(collection(db, "rooms", roomId, "players"), orderBy("score", "desc"));
  onSnapshot(playersQ, (snap) => {
    const players = snap.docs.map(d => d.data());
    renderPlayers(players);
  });
}

function renderQuestion(q, qIndex) {
  qText.textContent = q.question;
  optionsArea.innerHTML = "";
  answerInfo.textContent = "";

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "opt";
    btn.textContent = `${String.fromCharCode(65 + idx)}) ${opt}`;
    btn.onclick = () => submitAnswer(qIndex, idx);
    optionsArea.appendChild(btn);
  });
}

async function submitAnswer(qIndex, chosenIndex) {
  if (!currentRoomId || !currentQuestionDoc) return;

  const playerRef = doc(db, "rooms", currentRoomId, "players", uid);
  const qCorrect = currentQuestionDoc.answerIndex;

  await runTransaction(db, async (tx) => {
    const pSnap = await tx.get(playerRef);
    if (!pSnap.exists()) return;

    const p = pSnap.data();
    const answered = p.answered || {};
    if (answered[String(qIndex)]) return; // already answered

    answered[String(qIndex)] = true;

    const isCorrect = chosenIndex === qCorrect;
    const newScore = (p.score || 0) + (isCorrect ? 1 : 0);

    tx.update(playerRef, { answered, score: newScore });
  });

  answerInfo.textContent = chosenIndex === qCorrect ? "✅ Correct!" : "❌ Wrong!";
}

// ---------- Create Room ----------
createRoomBtn.onclick = async () => {
  const name = nameInput.value.trim() || "Host";

  if (QUESTIONS_BANK.length < 100) {
    alert("MCQ parsing failed. Make sure you pasted questions 1–100 into rawQuestions.js exactly.");
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

  // create lookup doc: roomCodes/{ABCD} -> {roomId}
  await setDoc(doc(db, "roomCodes", code), {
    roomId: roomRef.id,
    createdAt: serverTimestamp()
  });

  await upsertPlayer(roomRef.id, name, true);

  roomCard.classList.remove("hidden");
  roomCodeLabel.textContent = code;

  attachRoomListeners(roomRef.id);
};

// ---------- Join Room by Code ----------
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

  // write selected 20 into rooms/{roomId}/questions/{0..19}
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
      tx.update(roomRef, { currentQuestion: next });
    }
  });
};

endGameBtn.onclick = async () => {
  if (!currentRoomId) return;
  await updateDoc(doc(db, "rooms", currentRoomId), { status: "finished" });
};
