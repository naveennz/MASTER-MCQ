import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc,
  collection, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { RAW_MCQ_TEXT } from "./rawQuestions.js";

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_DOMAIN",
  projectId: "YOUR_PROJECT_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- DOM ELEMENTS ---
const home = document.getElementById("homeScreen");
const lobby = document.getElementById("lobbyScreen");
const game = document.getElementById("gameScreen");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const playersList = document.getElementById("playersList");
const startBtn = document.getElementById("startBtn");
const questionText = document.getElementById("questionText");
const optionsContainer = document.getElementById("options");
const totalScoreEl = document.getElementById("totalScore");

let uid, roomCode, roomRef;
let questions = [];

// Parse the raw text into usable objects
function parseQuestions() {
  const blocks = RAW_MCQ_TEXT.split("---").filter(b => b.includes("**Answer:"));
  return blocks.map(block => {
    const lines = block.trim().split("\n");
    const question = lines.find(l => l.startsWith("**")).replace(/\*\*/g, "");
    const options = lines.filter(l => l.startsWith("- ")).map(l => l.replace("- ", ""));
    const answerChar = lines.find(l => l.startsWith("**Answer:")).split(":")[1].trim();
    const answerIndex = ["A", "B", "C", "D"].indexOf(answerChar);
    return { question, options, answerIndex };
  });
}

signInAnonymously(auth).then(res => {
    uid = res.user.uid;
    questions = parseQuestions();
});

// --- UTILS ---
function show(screen) {
  [home, lobby, game].forEach(s => s.classList.add("hidden"));
  screen.classList.remove("hidden");
}

function renderMatchId(code) {
  [...code].forEach((c, i) => {
    const el = document.getElementById("m" + (i + 1));
    if (el) el.innerText = c;
  });
}

// --- HOST MATCH ---
document.getElementById("hostBtn").onclick = async () => {
  const name = nameInput.value.trim();
  if (!name) return alert("Enter name");

  roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  roomRef = doc(db, "rooms", roomCode);

  await setDoc(roomRef, {
    status: "waiting",
    host: uid,
    currentQuestion: 0
  });

  await setDoc(doc(roomRef, "players", uid), { name, score: 0 });
  initLobby(name, roomCode);
};

// --- JOIN MATCH ---
document.getElementById("joinBtn").onclick = async () => {
  const code = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();
  if (code.length !== 4) return alert("Enter 4-letter room code");
  if (!name) return alert("Enter name");

  roomRef = doc(db, "rooms", code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Room not found");

  roomCode = code;
  await setDoc(doc(roomRef, "players", uid), { name, score: 0 });
  initLobby(name, roomCode);
};

function initLobby(name, code) {
  document.getElementById("playerName").innerText = name;
  document.getElementById("roomLabel").innerText = "ROOM " + code;
  renderMatchId(code);
  show(lobby);
  watchRoom();
}

// --- SYNC ENGINE ---
function watchRoom() {
  // Watch Players List & Scores
  onSnapshot(collection(roomRef, "players"), snap => {
    playersList.innerHTML = "";
    snap.forEach(d => {
      const p = d.data();
      const div = document.createElement("div");
      div.innerHTML = `${p.name}: <strong>${p.score}</strong>`;
      playersList.appendChild(div);
      if (d.id === uid) totalScoreEl.innerText = p.score;
    });

    if (snap.size >= 2) startBtn.disabled = false;
  });

  // Watch Room State (Game Start and Question Changes)
  onSnapshot(roomRef, snap => {
    const data = snap.data();
    if (data.status === "playing") {
      show(game);
      loadQuestion(data.currentQuestion);
    }
  });
}

// --- GAMEPLAY ---
startBtn.onclick = async () => {
  await updateDoc(roomRef, { status: "playing" });
};

function loadQuestion(index) {
  const q = questions[index];
  if (!q) {
    questionText.innerText = "Game Over! Final scores are on the left.";
    optionsContainer.innerHTML = "";
    return;
  }

  questionText.innerText = q.question;
  optionsContainer.innerHTML = "";

  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "option";
    div.innerText = opt;
    div.onclick = () => handleAnswer(i, q.answerIndex, div);
    optionsContainer.appendChild(div);
  });
}

async function handleAnswer(selected, correct, element) {
  const allOpts = optionsContainer.querySelectorAll(".option");
  allOpts.forEach(o => o.style.pointerEvents = "none");

  if (selected === correct) {
    element.classList.add("correct");
    const playerRef = doc(roomRef, "players", uid);
    const snap = await getDoc(playerRef);
    await updateDoc(playerRef, { score: snap.data().score + 10 });
  } else {
    element.classList.add("wrong");
    allOpts[correct].classList.add("correct");
  }

  // Only the host advances the question for everyone
  const roomSnap = await getDoc(roomRef);
  if (roomSnap.data().host === uid) {
    setTimeout(async () => {
      await updateDoc(roomRef, { 
        currentQuestion: roomSnap.data().currentQuestion + 1 
      });
    }, 3000);
  }
}
