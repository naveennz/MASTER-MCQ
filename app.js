import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { RAW_MCQ_TEXT } from "./rawQuestions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let uid, roomCode, roomRef, gameData, gameTimer;
let allQuestions = [];

function parseQuestions() {
  const blocks = RAW_MCQ_TEXT.split("---").filter(b => b.includes("**Answer:"));
  return blocks.map(block => {
    const lines = block.trim().split("\n");
    return {
      question: lines.find(l => l.startsWith("**")).replace(/\*\*/g, ""),
      options: lines.filter(l => l.startsWith("- ")).map(l => l.replace("- ", "")),
      answerIndex: ["A", "B", "C", "D"].indexOf(lines.find(l => l.startsWith("**Answer:")).split(":")[1].trim())
    };
  });
}

signInAnonymously(auth).then(res => { uid = res.user.uid; allQuestions = parseQuestions(); });

const show = (s) => { document.querySelectorAll('section').forEach(sec => sec.classList.add('hidden')); s.classList.remove('hidden'); };

function renderMatchId(code) {
  [...code].forEach((c, i) => { const el = document.getElementById("m" + (i + 1)); if (el) el.innerText = c; });
}

// Host logic
document.getElementById("hostBtn").onclick = async () => {
  const name = document.getElementById("nameInput").value.trim();
  if (!name) return alert("Enter name");
  roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  roomRef = doc(db, "rooms", roomCode);
  const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 20);
  await setDoc(roomRef, { status: "waiting", host: uid, round: 1, currentQuestion: 0, questions: shuffled, answersCount: 0, showAnswer: false });
  await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0, 0, 0, 0, 0] });
  initLobby(name, roomCode);
};

// Join logic
document.getElementById("joinBtn").onclick = async () => {
  const code = document.getElementById("roomInput").value.trim().toUpperCase();
  const name = document.getElementById("nameInput").value.trim();
  if (!name || code.length !== 4) return alert("Fill details");
  roomRef = doc(db, "rooms", code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Not found");
  roomCode = code;
  await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0, 0, 0, 0, 0] });
  initLobby(name, roomCode);
};

function initLobby(name, code) {
  document.getElementById("playerName").innerText = name;
  document.getElementById("roomLabel").innerText = "ROOM " + code;
  renderMatchId(code);
  show(document.getElementById("lobbyScreen"));
  watchRoom();
}

function watchRoom() {
  onSnapshot(collection(roomRef, "players"), snap => {
    const list = document.getElementById("playersList");
    list.innerHTML = "";
    snap.forEach(d => {
      list.innerHTML += `<div>${d.data().name} <span>${d.data().score} pts</span></div>`;
      if (d.id === uid) document.getElementById("totalScore").innerText = d.data().score;
    });
    const isHost = gameData?.host === uid;
    document.getElementById("startBtn").disabled = snap.size < 2 || !isHost;
    document.getElementById("lobbyStatus").innerText = isHost ? (snap.size < 2 ? "Waiting for players..." : "Ready to Start!") : "Waiting for Host to start...";
  });

  onSnapshot(roomRef, snap => {
    gameData = snap.data();
    if (!gameData) return;
    if (gameData.status === "playing") { show(document.getElementById("gameScreen")); renderGame(); }
    else if (gameData.status === "roundEnd") { show(document.getElementById("roundWinnerScreen")); document.getElementById("nextLevelBtn").classList.toggle("hidden", gameData.host !== uid); }
    else if (gameData.status === "seriesEnd") { showSeriesWinner(); }
  });
}

function renderGame() {
  const q = gameData.questions[gameData.currentQuestion];
  document.getElementById("roundIndicator").innerText = `ROUND ${gameData.round} - ${gameData.currentQuestion + 1}/20`;
  document.getElementById("questionText").innerText = q.question;
  const container = document.getElementById("options");
  container.innerHTML = "";
  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "option" + (gameData.showAnswer && i === q.answerIndex ? " correct" : "");
    div.innerText = opt;
    div.onclick = () => handleAnswer(i, q.answerIndex);
    container.appendChild(div);
  });
  if (!gameData.showAnswer) startTimer();
}

function startTimer() {
  clearInterval(gameTimer);
  let timeLeft = 20;
  gameTimer = setInterval(async () => {
    timeLeft -= 0.1;
    document.getElementById("timerBar").style.width = (timeLeft / 20) * 100 + "%";
    if (timeLeft <= 0) { clearInterval(gameTimer); if (uid === gameData.host) triggerNext(); }
  }, 100);
}

async function handleAnswer(idx, correct) {
  document.querySelectorAll(".option").forEach(o => o.style.pointerEvents = "none");
  if (idx === correct) {
    const pRef = doc(roomRef, "players", uid);
    await runTransaction(db, async (t) => {
      const p = (await t.get(pRef)).data();
      const rounds = p.roundScores; rounds[gameData.round - 1] += 10;
      t.update(pRef, { score: p.score + 10, roundScores: rounds });
    });
  }
  await updateDoc(roomRef, { answersCount: gameData.answersCount + 1 });
  if (gameData.answersCount + 1 >= 2 && uid === gameData.host) triggerNext();
}

async function triggerNext() {
  clearInterval(gameTimer);
  await updateDoc(roomRef, { showAnswer: true });
  setTimeout(async () => {
    if (gameData.currentQuestion + 1 < 20) {
      await updateDoc(roomRef, { currentQuestion: gameData.currentQuestion + 1, showAnswer: false, answersCount: 0 });
    } else {
      await updateDoc(roomRef, { status: "roundEnd" });
    }
  }, 3000);
}

document.getElementById("startBtn").onclick = () => updateDoc(roomRef, { status: "playing" });

document.getElementById("nextLevelBtn").onclick = async () => {
  if (gameData.round < 5) {
    const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 20);
    await updateDoc(roomRef, { round: gameData.round + 1, currentQuestion: 0, status: "playing", questions: shuffled, answersCount: 0, showAnswer: false });
  } else {
    await updateDoc(roomRef, { status: "seriesEnd" });
  }
};

async function showSeriesWinner() {
  show(document.getElementById("seriesWinnerScreen"));
  const pSnap = await getDoc(collection(roomRef, "players"));
  let html = `<table><tr><th>Player</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th><th>Total</th></tr>`;
  const players = [];
  const querySnap = await onSnapshot(collection(roomRef, "players"), (snap) => {
      let tableHtml = html;
      snap.forEach(d => {
          const p = d.data();
          tableHtml += `<tr><td>${p.name}</td><td>${p.roundScores[0]}</td><td>${p.roundScores[1]}</td><td>${p.roundScores[2]}</td><td>${p.roundScores[3]}</td><td>${p.roundScores[4]}</td><td><strong>${p.score}</strong></td></tr>`;
      });
      document.getElementById("seriesStats").innerHTML = tableHtml + `</table>`;
  });
}
