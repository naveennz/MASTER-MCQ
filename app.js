import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc,
  collection, onSnapshot, runTransaction, increment
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { RAW_MCQ_TEXT } from "./rawQuestions.js";

// ─── Firebase Init ────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ─── Global State ─────────────────────────────────────────────────────────────
let uid, roomCode, roomRef;
let allQuestions = [];

// Snapshot data (latest from Firestore)
let gameData    = null;
let playerCount = 0;

// Per-question LOCAL state — never written to Firestore
// This is the key fix: other players NEVER see your selection until showAnswer=true
let mySelection  = null;   // which option index this player picked (local only)
let hasAnswered  = false;   // did this player click something?
let revealLocked = false;   // prevent double-triggering reveal (host guard)

// Timer state
let timerRAF   = null;
let timerStart = null;
const TIMER_MS = 20_000;

// Track which question the current UI is showing to detect new questions
let renderedQIndex = -1;

// ─── Parse Questions ──────────────────────────────────────────────────────────
function parseQuestions() {
  return RAW_MCQ_TEXT
    .split("---")
    .filter(b => b.includes("**Answer:"))
    .map(block => {
      const lines = block.trim().split("\n");
      return {
        question:    lines.find(l => l.startsWith("**")).replace(/\*\*/g, ""),
        options:     lines.filter(l => l.startsWith("- ")).map(l => l.replace("- ", "")),
        answerIndex: ["A","B","C","D"].indexOf(
          lines.find(l => l.startsWith("**Answer:")).split(":")[1].trim()
        )
      };
    });
}

// ─── Auth Boot ────────────────────────────────────────────────────────────────
signInAnonymously(auth).then(res => {
  uid = res.user.uid;
  allQuestions = parseQuestions();
});

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(sectionId) {
  document.querySelectorAll("section").forEach(s => s.classList.add("hidden"));
  $(sectionId).classList.remove("hidden");
}
function renderRoomCode(code) {
  [...(code || "")].forEach((c, i) => {
    const el = $("m" + (i + 1));
    if (el) el.innerText = c;
  });
}

// ─── Host ─────────────────────────────────────────────────────────────────────
$("hostBtn").onclick = async () => {
  const name = $("nameInput").value.trim();
  if (!name) return;
  roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  roomRef  = doc(db, "rooms", roomCode);

  await setDoc(roomRef, {
    status:          "waiting",
    host:            uid,
    round:           1,
    currentQuestion: 0,
    questions:       pickQuestions(20),
    answersCount:    0,
    showAnswer:      false,
    playerCount:     0
  });
  await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0,0,0,0,0] });

  startLobby(name);
};

// ─── Join ─────────────────────────────────────────────────────────────────────
$("joinBtn").onclick = async () => {
  const code = $("roomInput").value.trim().toUpperCase();
  const name = $("nameInput").value.trim();
  if (!name || code.length !== 4) return;

  roomRef = doc(db, "rooms", code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Room not found!");
  roomCode = code;

  await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0,0,0,0,0] });
  startLobby(name);
};

// ─── Lobby Init ───────────────────────────────────────────────────────────────
function startLobby(name) {
  $("playerName").innerText = name;
  $("roomLabel").innerText  = "ROOM " + roomCode;
  renderRoomCode(roomCode);
  show("lobbyScreen");
  subscribeToRoom();
  subscribeToPlayers();
}

// ─── Room Subscription ───────────────────────────────────────────────────────
// Single source of truth for game state changes.
function subscribeToRoom() {
  onSnapshot(roomRef, snap => {
    const prev = gameData;
    gameData   = snap.data();
    if (!gameData) return;

    const isHost = gameData.host === uid;

    if (gameData.status === "waiting") {
      // Update lobby UI
      if (isHost) {
        $("startBtn").classList.remove("hidden");
        $("lobbyStatus").innerText = "You are the host.";
      } else {
        $("startBtn").classList.add("hidden");
        $("lobbyStatus").innerText = "Waiting for host to start...";
      }

    } else if (gameData.status === "playing") {
      show("gameScreen");

      const qIdx = gameData.currentQuestion;

      if (qIdx !== renderedQIndex) {
        // ── New question ──────────────────────────────────────────────────
        renderedQIndex = qIdx;
        mySelection    = null;
        hasAnswered    = false;
        revealLocked   = false;
        renderQuestion();
        if (!gameData.showAnswer) startTimer();

      } else if (gameData.showAnswer && prev && !prev.showAnswer) {
        // ── Answer just revealed ──────────────────────────────────────────
        stopTimer();
        revealQuestion();        // show correct/wrong states
        showAnswerToast();

      } else if (!gameData.showAnswer && prev && prev.showAnswer) {
        // ── Edge case: showAnswer reset (shouldn't happen but guard it) ───
        // Do nothing — new qIdx will handle it
      }

      // ── Host: check if all players have answered ──────────────────────
      // (runs on every room update, safe because of revealLocked guard)
      if (isHost && !gameData.showAnswer && gameData.answersCount >= playerCount && playerCount > 0) {
        doReveal();
      }

    } else if (gameData.status === "roundEnd") {
      stopTimer();
      show("roundWinnerScreen");
      $("nextLevelBtn").classList.toggle("hidden", !isHost);

    } else if (gameData.status === "seriesEnd") {
      stopTimer();
      showSeriesWinner();
    }
  });
}

// ─── Players Subscription ────────────────────────────────────────────────────
function subscribeToPlayers() {
  onSnapshot(collection(roomRef, "players"), snap => {
    playerCount = snap.size;

    // Sort by score
    const players = [];
    snap.forEach(d => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => b.score - a.score);

    const list = $("playersList");
    list.innerHTML = "";
    players.forEach(p => {
      const row = document.createElement("div");
      row.className = "player-row" + (p.id === uid ? " is-me" : "");
      row.innerHTML = `<span>${p.name}</span><span class="pts">${p.score}</span>`;
      list.appendChild(row);
      if (p.id === uid) $("totalScore").innerText = p.score;
    });

    // Enable/disable start button
    const isHost = gameData && gameData.host === uid;
    $("startBtn").disabled = !(isHost && snap.size >= 2);

    // Host: check if all answered (in case players sub fires after room sub)
    if (gameData && gameData.host === uid && gameData.status === "playing"
        && !gameData.showAnswer && gameData.answersCount >= playerCount && playerCount > 0) {
      doReveal();
    }
  });
}

// ─── Render Question (pre-reveal, no answer shown) ───────────────────────────
function renderQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];

  $("roundIndicator").innerText = `ROUND ${gameData.round}  ·  Q ${gameData.currentQuestion + 1}/20`;
  $("qBadge").innerText         = `Question ${gameData.currentQuestion + 1} of 20`;
  $("questionText").innerText   = q.question;

  const container = $("options");
  container.innerHTML = "";

  q.options.forEach((opt, i) => {
    const div        = document.createElement("div");
    div.className    = "option";
    div.dataset.letter = letters[i];
    div.innerText    = opt;

    // Only show THIS player's selection (never others')
    if (hasAnswered && i === mySelection) div.classList.add("marked");
    if (hasAnswered) div.dataset.locked = "true"; // prevent re-clicking

    if (!hasAnswered) div.onclick = () => handleAnswer(i);
    container.appendChild(div);
  });
}

// ─── Reveal Question (post-reveal, show correct/wrong) ───────────────────────
function revealQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];

  const container = $("options");
  container.innerHTML = "";

  q.options.forEach((opt, i) => {
    const div        = document.createElement("div");
    div.className    = "option";
    div.dataset.letter = letters[i];
    div.dataset.locked = "true";
    div.innerText    = opt;

    if (i === q.answerIndex) {
      div.classList.add("correct");
    } else if (i === mySelection) {
      div.classList.add("wrong");
    } else {
      div.classList.add("dimmed");
    }

    container.appendChild(div);
  });
}

// ─── Handle Answer ────────────────────────────────────────────────────────────
async function handleAnswer(idx) {
  if (hasAnswered || gameData.showAnswer) return;

  hasAnswered = true;
  mySelection = idx;

  // Immediately show selection locally (only for this player!)
  renderQuestion();

  const q = gameData.questions[gameData.currentQuestion];

  // Score if correct — use runTransaction to safely read+write roundScores
  if (idx === q.answerIndex) {
    const pRef = doc(roomRef, "players", uid);
    await runTransaction(db, async t => {
      const snap   = await t.get(pRef);
      const p      = snap.data();
      const rounds = [...p.roundScores];
      rounds[gameData.round - 1] += 10;
      t.update(pRef, { score: increment(10), roundScores: rounds });
    });
  }

  // Atomically increment answer count — host's listener checks this
  await updateDoc(roomRef, { answersCount: increment(1) });
}

// ─── Host: Trigger Reveal ────────────────────────────────────────────────────
async function doReveal() {
  if (revealLocked || !gameData || gameData.showAnswer) return;
  revealLocked = true;
  await updateDoc(roomRef, { showAnswer: true });

  setTimeout(async () => {
    if (!gameData) return;
    const nextQ = gameData.currentQuestion + 1;
    if (nextQ < 20) {
      await updateDoc(roomRef, {
        currentQuestion: nextQ,
        showAnswer:      false,
        answersCount:    0
      });
    } else {
      // Round over — check if series is also over
      const nextRound = gameData.round + 1;
      await updateDoc(roomRef, {
        status: nextRound > 5 ? "seriesEnd" : "roundEnd"
      });
    }
  }, 4000); // Show answer for 4 seconds
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  timerStart = performance.now();
  const bar  = $("timerBar");
  const txt  = $("timerText");

  function tick(now) {
    const elapsed   = now - timerStart;
    const remaining = Math.max(0, TIMER_MS - elapsed);
    const pct       = remaining / TIMER_MS;
    const secs      = Math.ceil(remaining / 1000);

    bar.style.width = pct * 100 + "%";
    bar.classList.toggle("low", pct < 0.3);
    if (txt) txt.innerText = secs;

    if (remaining > 0) {
      timerRAF = requestAnimationFrame(tick);
    } else {
      // Time's up — host triggers reveal
      if (gameData && gameData.host === uid && !gameData.showAnswer) {
        doReveal();
      }
    }
  }

  timerRAF = requestAnimationFrame(tick);
}

function stopTimer() {
  if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; }
  const bar = $("timerBar");
  const txt = $("timerText");
  if (bar) { bar.style.width = "0%"; bar.classList.remove("low"); }
  if (txt) txt.innerText = "0";
}

// ─── Answer Toast ─────────────────────────────────────────────────────────────
function showAnswerToast() {
  const toast = $("answerToast");
  if (!toast) return;

  const q = gameData.questions[gameData.currentQuestion];
  toast.className = "";

  if (!hasAnswered) {
    toast.innerText = "⏱  Time's up!";
    toast.className = "timeout-toast show";
  } else if (mySelection === q.answerIndex) {
    toast.innerText = "✓  Correct  +10";
    toast.className = "correct-toast show";
  } else {
    toast.innerText = "✗  Wrong answer";
    toast.className = "wrong-toast show";
  }

  setTimeout(() => toast.classList.remove("show"), 3500);
}

// ─── Series Winner ────────────────────────────────────────────────────────────
function showSeriesWinner() {
  show("seriesWinnerScreen");
  onSnapshot(collection(roomRef, "players"), snap => {
    const players = [];
    snap.forEach(d => players.push(d.data()));
    players.sort((a, b) => b.score - a.score);

    let html = `<table>
      <tr><th>Player</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th><th>Total</th></tr>`;
    players.forEach((p, rank) => {
      const medal = rank === 0 ? "🥇 " : rank === 1 ? "🥈 " : rank === 2 ? "🥉 " : "";
      html += `<tr>
        <td>${medal}${p.name}</td>
        <td>${p.roundScores[0]}</td>
        <td>${p.roundScores[1]}</td>
        <td>${p.roundScores[2]}</td>
        <td>${p.roundScores[3]}</td>
        <td>${p.roundScores[4]}</td>
        <td><strong>${p.score}</strong></td>
      </tr>`;
    });
    $("seriesStats").innerHTML = html + `</table>`;
  });
}

// ─── Buttons ──────────────────────────────────────────────────────────────────
$("startBtn").onclick = () => {
  if (!gameData || gameData.host !== uid) return;
  updateDoc(roomRef, { status: "playing" });
};

$("nextLevelBtn").onclick = async () => {
  if (!gameData || gameData.host !== uid) return;
  await updateDoc(roomRef, {
    round:           gameData.round + 1,
    currentQuestion: 0,
    status:          "playing",
    questions:       pickQuestions(20),
    answersCount:    0,
    showAnswer:      false
  });
};

// ─── Utility ──────────────────────────────────────────────────────────────────
function pickQuestions(n) {
  return [...allQuestions].sort(() => Math.random() - 0.5).slice(0, n);
}
