import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc,
  collection, onSnapshot, runTransaction, increment,
  query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { RAW_MCQ_TEXT } from "./rawQuestions.js";

// ─── Firebase ─────────────────────────────────────────────────────────────────
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

// ─── Avatar Options ───────────────────────────────────────────────────────────
const AVATARS = ["🎮","🚀","🦊","🐯","🦁","🐸","🤖","👽","🦄","🐉",
                 "🔥","⚡","🌊","🍀","💎","🎯","🏆","🎪","🎭","🦋"];

// ─── Global State ─────────────────────────────────────────────────────────────
let uid, roomCode, roomRef;
let allQuestions  = [];
let gameData      = null;
let playerCount   = 0;
let myAvatar      = "🎮";   // selected avatar emoji
let myName        = "";

// Per-question local state (never synced to Firestore)
let mySelection   = null;
let hasAnswered   = false;
let revealLocked  = false;

// Timer
let timerRAF      = null;
let timerStart    = null;
const TIMER_MS    = 20_000;
let renderedQIndex = -1;

// Leaderboard live unsub
let lbUnsub = null;

// ─── Parse Questions ──────────────────────────────────────────────────────────
function parseQuestions() {
  return RAW_MCQ_TEXT
    .split("---")
    .filter(b => b.includes("**Answer:"))
    .map(block => {
      const lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean);
      const qLine = lines.find(l => l.startsWith("**") && !l.startsWith("**Answer"));
      const question = qLine
        ? qLine.replace(/^\*+/, "").replace(/\*+$/, "").replace(/^\d+\.\s*/, "").trim()
        : "";
      const options = lines
        .filter(l => /^-\s*[A-D]\)/.test(l))
        .map(l => l.replace(/^-\s*[A-D]\)\s*/, "").trim());
      const ansLine   = lines.find(l => l.startsWith("**Answer:"));
      const ansLetter = ansLine
        ? ansLine.replace(/\*+/g, "").replace("Answer:", "").trim().charAt(0).toUpperCase()
        : "A";
      const answerIndex = Math.max(0, ["A","B","C","D"].indexOf(ansLetter));
      return { question, options, answerIndex };
    })
    .filter(q => q.question && q.options.length === 4);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
signInAnonymously(auth).then(res => {
  uid = res.user.uid;
  allQuestions = parseQuestions();
  buildAvatarPicker();
  startLeaderboardLive(); // live leaderboard always running in sidebar
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

// ─── Avatar Picker ────────────────────────────────────────────────────────────
function buildAvatarPicker() {
  const grid = $("avatarGrid");
  if (!grid) return;
  AVATARS.forEach(emoji => {
    const btn = document.createElement("button");
    btn.className  = "av-btn";
    btn.innerText  = emoji;
    btn.onclick    = () => selectAvatar(emoji);
    if (emoji === myAvatar) btn.classList.add("av-selected");
    grid.appendChild(btn);
  });
}

function selectAvatar(emoji) {
  myAvatar = emoji;
  // Update sidebar avatar display
  const av = $("sidebarAvatar");
  if (av) av.innerText = emoji;
  // Update picker highlight
  document.querySelectorAll(".av-btn").forEach(b => {
    b.classList.toggle("av-selected", b.innerText === emoji);
  });
}

// ─── Global Leaderboard (live) ────────────────────────────────────────────────
function startLeaderboardLive() {
  const lbRef = query(
    collection(db, "leaderboard"),
    orderBy("score", "desc"),
    limit(20)
  );
  lbUnsub = onSnapshot(lbRef, snap => {
    renderLeaderboard(snap);
  });
}

function renderLeaderboard(snap) {
  const list = $("lbList");
  if (!list) return;
  list.innerHTML = "";

  if (snap.empty) {
    list.innerHTML = `<div class="lb-empty">No scores yet.<br>Play a game to appear here!</div>`;
    return;
  }

  const medals = ["🥇","🥈","🥉"];
  let rank = 0;
  snap.forEach(d => {
    const p    = d.data();
    const item = document.createElement("div");
    item.className = "lb-row" + (d.id === uid ? " lb-me" : "");
    item.innerHTML = `
      <span class="lb-rank">${medals[rank] || (rank + 1)}</span>
      <span class="lb-av">${p.avatar || "🎮"}</span>
      <span class="lb-name">${p.name}</span>
      <span class="lb-score">${p.score}</span>`;
    list.appendChild(item);
    rank++;
  });
}

// ─── Write/Update Global Leaderboard entry ────────────────────────────────────
async function pushToLeaderboard(name, avatar, score) {
  if (!uid || !name) return;
  const ref = doc(db, "leaderboard", uid);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().score < score) {
    // Only update if new score is higher (or first time)
    await setDoc(ref, {
      name,
      avatar: avatar || "🎮",
      score,
      updatedAt: serverTimestamp()
    });
  }
}

// ─── Sidebar tab switcher ──────────────────────────────────────────────────────
$("tabPlayers").onclick  = () => switchTab("players");
$("tabLeaderboard").onclick = () => switchTab("leaderboard");

function switchTab(tab) {
  $("tabPlayers").classList.toggle("tab-active", tab === "players");
  $("tabLeaderboard").classList.toggle("tab-active", tab === "leaderboard");
  $("panelPlayers").classList.toggle("hidden", tab !== "players");
  $("panelLeaderboard").classList.toggle("hidden", tab !== "leaderboard");
}

// ─── Host ─────────────────────────────────────────────────────────────────────
$("hostBtn").onclick = async () => {
  const name = $("nameInput").value.trim();
  if (!name) return;
  myName   = name;
  roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  roomRef  = doc(db, "rooms", roomCode);

  await setDoc(roomRef, {
    status: "waiting", host: uid, round: 1,
    currentQuestion: 0, questions: pickQuestions(20),
    answersCount: 0, showAnswer: false
  });
  await setDoc(doc(roomRef, "players", uid), {
    name, avatar: myAvatar, score: 0, roundScores: [0,0,0,0,0]
  });
  startLobby(name);
};

// ─── Join ─────────────────────────────────────────────────────────────────────
$("joinBtn").onclick = async () => {
  const code = $("roomInput").value.trim().toUpperCase();
  const name = $("nameInput").value.trim();
  if (!name || code.length !== 4) return;
  myName  = name;
  roomRef = doc(db, "rooms", code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Room not found!");
  roomCode = code;
  await setDoc(doc(roomRef, "players", uid), {
    name, avatar: myAvatar, score: 0, roundScores: [0,0,0,0,0]
  });
  startLobby(name);
};

// ─── Lobby ────────────────────────────────────────────────────────────────────
function startLobby(name) {
  $("playerName").innerText   = name;
  $("sidebarAvatar").innerText = myAvatar;
  $("roomLabel").innerText    = "ROOM " + roomCode;
  renderRoomCode(roomCode);

  const display = $("copyCodeDisplay");
  if (display) display.innerText = roomCode || "----";

  show("lobbyScreen");
  subscribeToRoom();
  subscribeToPlayers();
  setupCopyBtn();
}

function setupCopyBtn() {
  const btn = $("copyCodeBtn");
  if (!btn) return;
  const doCopy = () => {
    navigator.clipboard.writeText(roomCode || "").catch(() => {
      const el = document.createElement("textarea");
      el.value = roomCode;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }).finally(() => {
      btn.classList.add("copied");
      $("copyLabel").innerText = "Copied!";
      setTimeout(() => { btn.classList.remove("copied"); $("copyLabel").innerText = "Copy Code"; }, 2000);
    });
  };
  // Handle both clipboard success and failure with feedback
  btn.onclick = () => {
    try {
      navigator.clipboard.writeText(roomCode || "").then(() => {
        btn.classList.add("copied");
        $("copyLabel").innerText = "Copied!";
        setTimeout(() => { btn.classList.remove("copied"); $("copyLabel").innerText = "Copy Code"; }, 2000);
      }).catch(doCopy);
    } catch { doCopy(); }
  };
}

// ─── Room Subscription ────────────────────────────────────────────────────────
function subscribeToRoom() {
  onSnapshot(roomRef, snap => {
    const prev = gameData;
    gameData   = snap.data();
    if (!gameData) return;

    const isHost = gameData.host === uid;

    if (gameData.status === "waiting") {
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
        renderedQIndex = qIdx;
        mySelection = null;
        hasAnswered = false;
        revealLocked = false;
        renderQuestion();
        if (!gameData.showAnswer) startTimer();

      } else if (gameData.showAnswer && prev && !prev.showAnswer) {
        stopTimer();
        revealQuestion();
        showAnswerToast();
      }

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

// ─── Players Subscription ─────────────────────────────────────────────────────
function subscribeToPlayers() {
  onSnapshot(collection(roomRef, "players"), snap => {
    playerCount = snap.size;
    const players = [];
    snap.forEach(d => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => b.score - a.score);

    const list = $("playersList");
    list.innerHTML = "";
    players.forEach(p => {
      const row = document.createElement("div");
      row.className = "player-row" + (p.id === uid ? " me" : "");
      row.innerHTML = `
        <span class="pr-av">${p.avatar || "🎮"}</span>
        <span class="pr-name">${p.name}</span>
        <span class="pts">${p.score}</span>`;
      list.appendChild(row);
      if (p.id === uid) {
        $("totalScore").innerText    = p.score;
        $("sidebarAvatar").innerText = p.avatar || myAvatar;
      }
    });

    const isHost = gameData && gameData.host === uid;
    $("startBtn").disabled = !(isHost && snap.size >= 2);

    if (gameData && gameData.host === uid && gameData.status === "playing"
        && !gameData.showAnswer && gameData.answersCount >= playerCount && playerCount > 0) {
      doReveal();
    }
  });
}

// ─── Render Question ──────────────────────────────────────────────────────────
function renderQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];

  $("roundIndicator").innerText = `ROUND ${gameData.round}  ·  Q ${gameData.currentQuestion + 1}/20`;
  $("qTag").innerText           = `Question ${gameData.currentQuestion + 1} of 20`;
  $("questionText").innerText   = q.question;

  const container = $("options");
  container.innerHTML = "";

  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "opt";

    const badge = document.createElement("span");
    badge.className = "opt-letter";
    badge.innerText = letters[i];
    div.appendChild(badge);

    const txt = document.createElement("span");
    txt.innerText = opt;
    div.appendChild(txt);

    if (hasAnswered && i === mySelection) div.classList.add("marked");
    if (hasAnswered) div.dataset.locked = "true";
    if (!hasAnswered) div.onclick = () => handleAnswer(i);
    container.appendChild(div);
  });
}

// ─── Reveal Question ──────────────────────────────────────────────────────────
function revealQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];
  const container = $("options");
  container.innerHTML = "";

  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "opt";
    div.dataset.locked = "true";

    const badge = document.createElement("span");
    badge.className = "opt-letter";
    badge.innerText = letters[i];
    div.appendChild(badge);

    const txt = document.createElement("span");
    txt.innerText = opt;
    div.appendChild(txt);

    if (i === q.answerIndex)    div.classList.add("correct");
    else if (i === mySelection) div.classList.add("wrong");
    else                        div.classList.add("dimmed");

    container.appendChild(div);
  });
}

// ─── Handle Answer ────────────────────────────────────────────────────────────
async function handleAnswer(idx) {
  if (hasAnswered || gameData.showAnswer) return;
  hasAnswered = true;
  mySelection = idx;
  renderQuestion();

  const q = gameData.questions[gameData.currentQuestion];

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

  await updateDoc(roomRef, { answersCount: increment(1) });
}

// ─── Reveal (host) ────────────────────────────────────────────────────────────
async function doReveal() {
  if (revealLocked || !gameData || gameData.showAnswer) return;
  revealLocked = true;
  await updateDoc(roomRef, { showAnswer: true });

  setTimeout(async () => {
    if (!gameData) return;
    const nextQ = gameData.currentQuestion + 1;
    if (nextQ < 20) {
      await updateDoc(roomRef, { currentQuestion: nextQ, showAnswer: false, answersCount: 0 });
    } else {
      const nextRound = gameData.round + 1;
      await updateDoc(roomRef, { status: nextRound > 5 ? "seriesEnd" : "roundEnd" });
    }
  }, 4000);
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  timerStart = performance.now();
  const bar = $("timerBar");
  const txt = $("timerText");

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
      if (gameData && gameData.host === uid && !gameData.showAnswer) doReveal();
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

// ─── Series Winner + push leaderboard ────────────────────────────────────────
function showSeriesWinner() {
  show("seriesWinnerScreen");

  onSnapshot(collection(roomRef, "players"), snap => {
    const players = [];
    snap.forEach(d => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => b.score - a.score);

    let html = `<table>
      <tr><th></th><th>Player</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th><th>Total</th></tr>`;
    players.forEach((p, rank) => {
      const medal = ["🥇","🥈","🥉"][rank] || "";
      html += `<tr class="${p.id === uid ? "my-row" : ""}">
        <td>${p.avatar || "🎮"}</td>
        <td style="text-align:left;font-weight:700">${medal} ${p.name}</td>
        <td>${p.roundScores[0]}</td>
        <td>${p.roundScores[1]}</td>
        <td>${p.roundScores[2]}</td>
        <td>${p.roundScores[3]}</td>
        <td>${p.roundScores[4]}</td>
        <td><strong>${p.score}</strong></td>
      </tr>`;

      // Push every player's score to global leaderboard
      pushToLeaderboard(p.name, p.avatar, p.score);
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
    round: gameData.round + 1, currentQuestion: 0,
    status: "playing", questions: pickQuestions(20),
    answersCount: 0, showAnswer: false
  });
};

// ─── Utility ──────────────────────────────────────────────────────────────────
function pickQuestions(n) {
  return [...allQuestions].sort(() => Math.random() - 0.5).slice(0, n);
}
