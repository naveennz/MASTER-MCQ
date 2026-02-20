/* app.js (UPDATED to match your Firestore)
   ✅ rooms doc ID = auto (random)
   ✅ roomCode stored as field
   ✅ join uses query where roomCode == code
   ✅ players stored under rooms/{roomId}/players/{uid}
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  getDocs,
  query,
  where,
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

/* ========= Firebase config ========= */
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

/* ========= DOM helpers ========= */
const $ = (id) => document.getElementById(id);
function showScreen(screenId) {
  ["homeScreen", "lobbyScreen", "gameScreen", "resultsScreen"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("hidden", id !== screenId);
  });
}
function safeText(el, text) {
  if (!el) return;
  el.textContent = text ?? "";
}

/* ========= State ========= */
let myUid = null;
let myName = "Player";

let currentRoomId = null;     // 🔥 Firestore room doc ID (auto)
let currentRoomCode = null;   // 🔥 Display code ABCD

let roomState = null;
let playersState = {};

let roomUnsub = null;
let playersUnsub = null;

let localTimer = null;

/* ========= UI: Room code display ========= */
function setRoomCodeUI(code) {
  const c = (code || "----").toUpperCase();
  safeText($("roomCodePill"), c);

  const container = $("matchIdBoxes");
  if (container) {
    const boxes = Array.from(container.querySelectorAll("[data-matchbox]"));
    if (boxes.length === 4) {
      boxes.forEach((b, i) => (b.textContent = c[i] || "-"));
    } else {
      const kids = Array.from(container.children).slice(0, 4);
      if (kids.length === 4) kids.forEach((k, i) => (k.textContent = c[i] || "-"));
    }
  }
}

function setLeftTopUI() {
  const me = playersState?.[myUid];
  safeText($("leftPlayerName"), me?.name || myName || "PLAYER");
  safeText($("leftTotalScore"), String(me?.totalScore ?? 0));
  const lv = roomState?.level ?? 1;
  safeText($("leftLevelPill"), `Level ${lv}/5`);
}

/* ========= Room code generator ========= */
function randRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/* ========= Questions ========= */
const TOTAL_QUESTIONS = 100;
async function getAllQuestionIds() {
  // assumes /questions collection exists (q1..q100 OR any 100 docs)
  try {
    const snap = await getDocs(collection(db, "questions"));
    const ids = [];
    snap.forEach((d) => ids.push(d.id));
    if (ids.length >= 100) return ids.slice(0, 100);
  } catch (e) {
    console.warn("Could not fetch /questions, fallback q1..q100", e);
  }
  const ids = [];
  for (let i = 1; i <= TOTAL_QUESTIONS; i++) ids.push(`q${i}`);
  return ids;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickRandomUnique(fromIds, count, exclude = []) {
  const ex = new Set(exclude);
  const pool = fromIds.filter((x) => !ex.has(x));
  return shuffle(pool).slice(0, count);
}

/* ========= Refs (ROOM ID based) ========= */
function roomRefById(roomId) {
  return doc(db, "rooms", roomId);
}
function playersColById(roomId) {
  return collection(db, "rooms", roomId, "players");
}
function playerDocById(roomId, uid) {
  return doc(db, "rooms", roomId, "players", uid);
}

/* ========= Start button enable ========= */
function updateStartButton() {
  const btn = $("startBtn");
  if (!btn || !roomState) return;

  const playersCount = Object.keys(playersState || {}).length;
  const isHost = roomState.hostId === myUid;
  const canStart = isHost && roomState.status === "waiting" && playersCount >= 2;

  btn.disabled = !canStart;
}

/* ========= Players UI ========= */
function renderPlayers() {
  const list = $("playersList");
  if (list) {
    list.innerHTML = "";
    Object.entries(playersState || {}).forEach(([uid, p]) => {
      const tag = uid === roomState?.hostId ? " (Host)" : "";
      const div = document.createElement("div");
      div.className = "playerRow";
      div.innerHTML = `<strong>${p.name || "Player"}${tag}</strong><div class="muted">Total: ${p.totalScore ?? 0}</div>`;
      list.appendChild(div);
    });
  }
  setLeftTopUI();
}

/* ========= Game UI ========= */
function getOptionButtons() {
  const byData = Array.from(document.querySelectorAll("[data-opt]"));
  if (byData.length >= 4) {
    return [0, 1, 2, 3].map((i) => byData.find((b) => String(b.dataset.opt) === String(i)));
  }
  return [$("opt0"), $("opt1"), $("opt2"), $("opt3")].filter(Boolean);
}

async function renderCurrentQuestion() {
  if (!roomState) return;

  const idx = roomState.currentIndex ?? 0;
  const qid = (roomState.questionIds || [])[idx];
  if (!qid) return;

  const snap = await getDoc(doc(db, "questions", qid));
  if (!snap.exists()) return;

  const q = snap.data();
  safeText($("qIndexText"), `Question ${idx + 1}/20`);
  safeText($("qText"), q.question || "");

  const opts = q.options || [];
  const btns = getOptionButtons();
  btns.forEach((b, i) => {
    b.textContent = opts[i] || "";
    b.disabled = false;
    b.classList.remove("picked", "correct", "wrong", "reveal");
  });

  startTimerFromRoom();
}

function clearTimer() {
  if (localTimer) clearInterval(localTimer);
  localTimer = null;
}

function startTimerFromRoom() {
  clearTimer();

  const QUESTION_MS = 20000;
  const REVEAL_MS = 5000;

  const phase = roomState.phase || "question";
  const startedAt = roomState.questionStartedAt;
  const startMs = startedAt?.toMillis ? startedAt.toMillis() : Date.now();
  const duration = phase === "reveal" ? REVEAL_MS : QUESTION_MS;

  const tick = () => {
    const elapsed = Date.now() - startMs;
    const remaining = Math.max(0, duration - elapsed);

    safeText($("timerText"), String(Math.ceil(remaining / 1000)));
    const bar = $("timerBar");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (remaining / duration) * 100))}%`;

    if (remaining <= 0) clearTimer();
  };

  tick();
  localTimer = setInterval(tick, 120);
}

async function renderReveal() {
  const idx = roomState.currentIndex ?? 0;
  const qid = (roomState.questionIds || [])[idx];
  if (!qid) return;

  const snap = await getDoc(doc(db, "questions", qid));
  if (!snap.exists()) return;

  const q = snap.data();
  const correct = q.answerIndex;

  const btns = getOptionButtons();
  btns.forEach((b, i) => {
    b.disabled = true;
    b.classList.add("reveal");
    if (i === correct) b.classList.add("correct");
  });

  const myAns = playersState?.[myUid]?.answers?.[idx];
  if (typeof myAns === "number" && myAns !== correct && btns[myAns]) {
    btns[myAns].classList.add("wrong");
  }
}

/* ========= Answer submit ========= */
async function submitAnswer(optIdx) {
  if (!currentRoomId || !roomState) return;
  if (roomState.status !== "playing") return;
  if ((roomState.phase || "question") !== "question") return;

  const idx = roomState.currentIndex ?? 0;

  await updateDoc(playerDocById(currentRoomId, myUid), {
    [`answers.${idx}`]: optIdx
  });

  const btns = getOptionButtons();
  btns.forEach((b) => (b.disabled = true));
  if (btns[optIdx]) btns[optIdx].classList.add("picked");
}

/* ========= Host: early reveal + scoring + next ========= */
async function hostMaybeRevealEarly() {
  if (!roomState || roomState.hostId !== myUid) return;
  if (roomState.phase !== "question") return;

  const ids = Object.keys(playersState || {});
  if (ids.length < 2) return;

  const idx = roomState.currentIndex ?? 0;
  const a1 = playersState[ids[0]]?.answers?.[idx];
  const a2 = playersState[ids[1]]?.answers?.[idx];

  if (typeof a1 === "number" && typeof a2 === "number") {
    await updateDoc(roomRefById(currentRoomId), {
      phase: "reveal",
      questionStartedAt: serverTimestamp()
    });
  }
}

async function hostScoreAndNext() {
  if (!roomState || roomState.hostId !== myUid) return;
  if (roomState.phase !== "reveal") return;

  const idx = roomState.currentIndex ?? 0;
  const qid = (roomState.questionIds || [])[idx];
  if (!qid) return;

  const qSnap = await getDoc(doc(db, "questions", qid));
  if (!qSnap.exists()) return;

  const correct = qSnap.data().answerIndex;

  const uids = Object.keys(playersState || {});
  for (const uid of uids) {
    const ans = playersState[uid]?.answers?.[idx];
    if (typeof ans === "number" && ans === correct) {
      await updateDoc(playerDocById(currentRoomId, uid), {
        score: increment(10),
        totalScore: increment(10),
        [`levelScores.${roomState.level || 1}`]: increment(10)
      });
    }
  }

  const nextIndex = idx + 1;
  if (nextIndex < 20) {
    await updateDoc(roomRefById(currentRoomId), {
      currentIndex: nextIndex,
      phase: "question",
      questionStartedAt: serverTimestamp()
    });
  } else {
    const lv = roomState.level || 1;
    if (lv < 5) {
      await updateDoc(roomRefById(currentRoomId), { status: "level_finished" });
    } else {
      await updateDoc(roomRefById(currentRoomId), { status: "finished" });
    }
  }
}

/* ========= Results ========= */
function renderResults() {
  const box = $("leaderboardBox");
  if (!box) return;

  const entries = Object.entries(playersState || {}).map(([uid, p]) => ({
    uid,
    name: p.name || "Player",
    total: p.totalScore ?? 0,
    levelScores: p.levelScores || {}
  }));

  entries.sort((a, b) => b.total - a.total);

  const winner = entries[0];
  const runner = entries[1];

  safeText($("resultsTitle"), winner ? `Winner: ${winner.name}` : "Match finished");

  box.innerHTML = `
    <div class="lbRow"><div class="rank">#1</div><div class="pname">${winner?.name || "-"}</div><div class="pts">${winner?.total ?? 0} pts</div></div>
    <div class="lbRow"><div class="rank">#2</div><div class="pname">${runner?.name || "-"}</div><div class="pts">${runner?.total ?? 0} pts</div></div>
    <hr style="opacity:.2;margin:14px 0">
    ${entries.map(e=>{
      const ls = e.levelScores;
      return `
        <div class="lbMini">
          <strong>${e.name}</strong>
          <div class="muted">Total: ${e.total}</div>
          <div class="chips">
            <span>L1 ${ls?.[1] ?? 0}</span><span>L2 ${ls?.[2] ?? 0}</span><span>L3 ${ls?.[3] ?? 0}</span><span>L4 ${ls?.[4] ?? 0}</span><span>L5 ${ls?.[5] ?? 0}</span>
          </div>
        </div>
      `;
    }).join("")}
  `;

  const lv = roomState?.level ?? 1;
  const btn = $("rematchBtn");
  if (btn) {
    if (lv < 5) {
      btn.textContent = `Rematch to Level ${lv + 1}`;
      btn.disabled = roomState.hostId !== myUid;
    } else {
      btn.textContent = "All levels completed";
      btn.disabled = true;
    }
  }
}

/* ========= Routing ========= */
function renderByRoomStatus() {
  if (!roomState) return;

  if (roomState.status === "waiting") showScreen("lobbyScreen");
  if (roomState.status === "playing") showScreen("gameScreen");
  if (roomState.status === "level_finished") showScreen("resultsScreen");
  if (roomState.status === "finished") showScreen("resultsScreen");

  setRoomCodeUI(currentRoomCode);
  setLeftTopUI();
  updateStartButton();
}

/* ========= Listeners ========= */
function stopListeners() {
  if (roomUnsub) roomUnsub();
  if (playersUnsub) playersUnsub();
  roomUnsub = null;
  playersUnsub = null;
}

function startListeners(roomId, roomCode) {
  stopListeners();

  currentRoomId = roomId;
  currentRoomCode = roomCode;
  setRoomCodeUI(roomCode);

  roomUnsub = onSnapshot(roomRefById(roomId), async (snap) => {
    if (!snap.exists()) return;
    roomState = snap.data();

    renderByRoomStatus();

    if (roomState.status === "playing") {
      if (roomState.phase === "question") {
        await renderCurrentQuestion();
      } else if (roomState.phase === "reveal") {
        await renderReveal();
        if (roomState.hostId === myUid) {
          setTimeout(() => hostScoreAndNext().catch(console.error), 5200);
        }
      }
    } else if (roomState.status === "level_finished" || roomState.status === "finished") {
      renderResults();
    }
  });

  playersUnsub = onSnapshot(playersColById(roomId), (snap) => {
    playersState = {};
    snap.forEach((d) => (playersState[d.id] = d.data()));

    renderPlayers();
    updateStartButton();
    hostMaybeRevealEarly().catch(console.error);
  });
}

/* ========= Auth ========= */
async function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const off = onAuthStateChanged(auth, async (user) => {
      if (user) {
        myUid = user.uid;
        off();
        resolve(user);
      } else {
        try {
          await signInAnonymously(auth);
        } catch (e) {
          off();
          reject(e);
        }
      }
    });
  });
}

/* ========= Host / Join ========= */
async function createRoom() {
  myName = ($("playerNameInput")?.value || "Host").trim() || "Host";
  const code = randRoomCode();

  // ✅ create room with AUTO ID
  const roomDoc = await addDoc(collection(db, "rooms"), {
    roomCode: code,
    hostId: myUid,
    status: "waiting",
    level: 1,
    createdAt: serverTimestamp(),
    usedQuestionIds: []
  });

  // host player doc
  await setDoc(playerDocById(roomDoc.id, myUid), {
    name: myName,
    joinedAt: serverTimestamp(),
    score: 0,
    totalScore: 0,
    levelScores: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    answers: {}
  });

  startListeners(roomDoc.id, code);
  showScreen("lobbyScreen");
}

async function joinRoom() {
  myName = ($("playerNameInput")?.value || "Player").trim() || "Player";
  const code = ($("joinCodeInput")?.value || "").trim().toUpperCase();
  if (code.length !== 4) return alert("Enter 4-letter room code");

  // ✅ find room by roomCode field
  const qy = query(collection(db, "rooms"), where("roomCode", "==", code));
  const snap = await getDocs(qy);

  if (snap.empty) return alert("Room not found");

  const roomDoc = snap.docs[0];
  const roomId = roomDoc.id;

  // check count
  const ps = await getDocs(playersColById(roomId));
  if (ps.size >= 2) return alert("Room full (2 players)");

  await setDoc(playerDocById(roomId, myUid), {
    name: myName,
    joinedAt: serverTimestamp(),
    score: 0,
    totalScore: 0,
    levelScores: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    answers: {}
  });

  startListeners(roomId, code);
  showScreen("lobbyScreen");
}

/* ========= Start match (host) ========= */
async function startMatch() {
  if (!roomState || roomState.hostId !== myUid) return;

  const allIds = await getAllQuestionIds();
  const picked = pickRandomUnique(allIds, 20, roomState.usedQuestionIds || []);

  // reset both players
  for (const uid of Object.keys(playersState || {})) {
    await updateDoc(playerDocById(currentRoomId, uid), { score: 0, answers: {} });
  }

  await updateDoc(roomRefById(currentRoomId), {
    status: "playing",
    level: 1,
    questionIds: picked,
    usedQuestionIds: picked,
    currentIndex: 0,
    phase: "question",
    questionStartedAt: serverTimestamp()
  });
}

/* ========= Next level ========= */
async function hostStartNextLevel() {
  if (!roomState || roomState.hostId !== myUid) return;

  const nextLevel = (roomState.level || 1) + 1;
  if (nextLevel > 5) return;

  const allIds = await getAllQuestionIds();
  const used = roomState.usedQuestionIds || [];
  const picked = pickRandomUnique(allIds, 20, used);

  for (const uid of Object.keys(playersState || {})) {
    await updateDoc(playerDocById(currentRoomId, uid), { score: 0, answers: {} });
  }

  await updateDoc(roomRefById(currentRoomId), {
    status: "playing",
    level: nextLevel,
    questionIds: picked,
    usedQuestionIds: [...used, ...picked],
    currentIndex: 0,
    phase: "question",
    questionStartedAt: serverTimestamp()
  });
}

/* ========= Leave ========= */
function leaveMatch() {
  stopListeners();
  roomState = null;
  playersState = {};
  currentRoomId = null;
  currentRoomCode = null;
  clearTimer();
  showScreen("homeScreen");
}

/* ========= Wire UI ========= */
function wireUI() {
  $("hostBtn")?.addEventListener("click", async () => {
    await ensureSignedIn();
    await createRoom();
  });

  $("joinBtn")?.addEventListener("click", async () => {
    await ensureSignedIn();
    await joinRoom();
  });

  $("startBtn")?.addEventListener("click", startMatch);
  $("leaveBtn")?.addEventListener("click", leaveMatch);

  $("copyCodeBtn")?.addEventListener("click", async () => {
    if (!currentRoomCode) return;
    try {
      await navigator.clipboard.writeText(currentRoomCode);
      alert("Room code copied!");
    } catch {
      alert("Copy failed. Room: " + currentRoomCode);
    }
  });

  getOptionButtons().forEach((btn, i) => btn?.addEventListener("click", () => submitAnswer(i)));
  $("rematchBtn")?.addEventListener("click", hostStartNextLevel);
}

/* ========= Init ========= */
(async function init() {
  wireUI();
  showScreen("homeScreen");
  try {
    await ensureSignedIn();
  } catch (e) {
    console.error("Auth failed", e);
  }
})();
