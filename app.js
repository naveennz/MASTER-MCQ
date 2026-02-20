import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc,
  collection, onSnapshot, runTransaction
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { RAW_MCQ_TEXT } from "./rawQuestions.js";

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

// DOM Elements
const home = document.getElementById("homeScreen");
const lobby = document.getElementById("lobbyScreen");
const game = document.getElementById("gameScreen");
const timerBar = document.getElementById("timerBar");
const questionText = document.getElementById("questionText");
const optionsContainer = document.getElementById("options");

let uid, roomCode, roomRef, gameData;
let allQuestions = [];
let gameTimer;

function parseQuestions() {
  const blocks = RAW_MCQ_TEXT.split("---").filter(b => b.includes("**Answer:"));
  return blocks.map(block => {
    const lines = block.trim().split("\n");
    const question = lines.find(l => l.startsWith("**")).replace(/\*\*/g, "");
    const options = lines.filter(l => l.startsWith("- ")).map(l => l.replace("- ", ""));
    const answerChar = lines.find(l => l.startsWith("**Answer:")).split(":")[1].trim();
    return { question, options, answerIndex: ["A", "B", "C", "D"].indexOf(answerChar) };
  });
}

signInAnonymously(auth).then(res => {
  uid = res.user.uid;
  allQuestions = parseQuestions();
});

// Utils
const show = (s) => {
  document.querySelectorAll('section').forEach(sec => sec.classList.add('hidden'));
  s.classList.remove('hidden');
};

// Host Match
document.getElementById("hostBtn").onclick = async () => {
  const name = document.getElementById("nameInput").value.trim();
  if (!name) return alert("Enter name");

  roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  roomRef = doc(db, "rooms", roomCode);

  // Pick 20 random questions
  const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 20);

  await setDoc(roomRef, {
    status: "waiting",
    host: uid,
    round: 1,
    currentQuestion: 0,
    questions: shuffled,
    answersCount: 0,
    showAnswer: false
  });

  await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0, 0, 0, 0, 0], hasAnswered: false });
  initLobby(name, roomCode);
};

// Join Match (logic remains similar, but adds roundScores array)
document.getElementById("joinBtn").onclick = async () => {
  const code = document.getElementById("roomInput").value.trim().toUpperCase();
  const name = document.getElementById("nameInput").value.trim();
  roomRef = doc(db, "rooms", code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Room not found");

  roomCode = code;
  await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0, 0, 0, 0, 0], hasAnswered: false });
  initLobby(name, roomCode);
};

function initLobby(name, code) {
  document.getElementById("playerName").innerText = name;
  document.getElementById("roomLabel").innerText = "ROOM " + code;
  show(lobby);
  watchRoom();
}

function watchRoom() {
  onSnapshot(collection(roomRef, "players"), snap => {
    const list = document.getElementById("playersList");
    list.innerHTML = "";
    snap.forEach(d => {
      const p = d.data();
      list.innerHTML += `<div>${p.name} <span>${p.score} pts</span></div>`;
      if (d.id === uid) document.getElementById("totalScore").innerText = p.score;
    });
    if (snap.size >= 2) document.getElementById("startBtn").disabled = false;
  });

  onSnapshot(roomRef, snap => {
    gameData = snap.data();
    if (gameData.status === "playing") {
      show(game);
      renderGame();
    } else if (gameData.status === "roundEnd") {
      showRoundWinner();
    } else if (gameData.status === "seriesEnd") {
      showSeriesWinner();
    }
  });
}

function renderGame() {
  const q = gameData.questions[gameData.currentQuestion];
  questionText.innerText = q.question;
  optionsContainer.innerHTML = "";
  
  // Reset Timer Bar
  timerBar.style.width = "100%";
  
  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "option";
    div.innerText = opt;
    if (gameData.showAnswer) {
      if (i === q.answerIndex) div.classList.add("correct");
    }
    div.onclick = () => handleSelection(i, q.answerIndex);
    optionsContainer.appendChild(div);
  });

  if (!gameData.showAnswer) startTimer();
}

function startTimer() {
  clearInterval(gameTimer);
  let timeLeft = 20;
  gameTimer = setInterval(async () => {
    timeLeft -= 0.1;
    timerBar.style.width = (timeLeft / 20) * 100 + "%";
    
    if (timeLeft <= 0) {
      clearInterval(gameTimer);
      if (uid === gameData.host) triggerShowAnswer();
    }
  }, 100);
}

async function handleSelection(idx, correctIdx) {
  const options = document.querySelectorAll(".option");
  options.forEach(o => o.style.pointerEvents = "none");

  const isCorrect = idx === correctIdx;
  if (isCorrect) {
    // Update Score via transaction
    const pRef = doc(roomRef, "players", uid);
    await runTransaction(db, async (transaction) => {
      const pDoc = await transaction.get(pRef);
      const newScore = pDoc.data().score + 10;
      const rounds = pDoc.data().roundScores;
      rounds[gameData.round - 1] += 10;
      transaction.update(pRef, { score: newScore, roundScores: rounds, hasAnswered: true });
    });
  }

  // Tell room one more player answered
  await updateDoc(roomRef, { answersCount: gameData.answersCount + 1 });
  
  // If everyone answered, host triggers show answer immediately
  if (gameData.answersCount + 1 >= 2 && uid === gameData.host) {
    triggerShowAnswer();
  }
}

async function triggerShowAnswer() {
  await updateDoc(roomRef, { showAnswer: true });
  setTimeout(async () => {
    if (gameData.currentQuestion + 1 < 20) {
      await updateDoc(roomRef, { 
        currentQuestion: gameData.currentQuestion + 1, 
        showAnswer: false,
        answersCount: 0 
      });
    } else {
      await updateDoc(roomRef, { status: "roundEnd" });
    }
  }, 5000);
}

// Next Round Logic
document.getElementById("nextLevelBtn").onclick = async () => {
    if (gameData.round < 5) {
        const nextQuestions = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 20);
        await updateDoc(roomRef, {
            round: gameData.round + 1,
            currentQuestion: 0,
            status: "playing",
            questions: nextQuestions,
            answersCount: 0,
            showAnswer: false
        });
    } else {
        await updateDoc(roomRef, { status: "seriesEnd" });
    }
};

// Placeholder functions for Winner Screens
function showRoundWinner() { show(document.getElementById("roundWinnerScreen")); }
function showSeriesWinner() { show(document.getElementById("seriesWinnerScreen")); }
