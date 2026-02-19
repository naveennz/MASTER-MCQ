import { RAW_MCQ_TEXT } from "./rawQuestions.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, onSnapshot,
  updateDoc, serverTimestamp, writeBatch, runTransaction, query, orderBy, getDocs, arrayUnion
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

/* =========================
   CONFIG
========================= */
const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b",
  measurementId: "G-SNP025BS5G"
};

const QUESTION_MS = 20000;     // ✅ 20s question time (updated)
const REVEAL_MS   = 5000;      // 5s reveal
const Q_PER_LEVEL = 20;
const MAX_LEVELS  = 5;         // ✅ 5 levels = 100 questions total

/* =========================
   FIREBASE INIT
========================= */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* =========================
   UI HELPERS
========================= */
const $ = (id) => document.getElementById(id);

const homeScreen = $("homeScreen");
const lobbyScreen = $("lobbyScreen");
const gameScreen = $("gameScreen");
const resultsScreen = $("resultsScreen");

const authStatus = $("authStatus");
const nameInput = $("nameInput");
const roomCodeInput = $("roomCodeInput");
const hostBtn = $("hostBtn");
const joinBtn = $("joinBtn");

const lobbyCode = $("lobbyCode");
const lobbyStatus = $("lobbyStatus");
const lobbyPlayers = $("lobbyPlayers");
const lobbyHostControls = $("lobbyHostControls");
const startBtn = $("startBtn");

const scoreList = $("scoreList");
const qNum = $("qNum");
const phaseText = $("phaseText");

const roomCodePill = $("roomCodePill");
const phasePill = $("phasePill");
const timerFill = $("timerFill");
const timerText = $("timerText");

const questionText = $("questionText");
const optionsArea = $("optionsArea");
const answerInfo = $("answerInfo");

const leaderboardBox = $("leaderboardBox");
const backHomeBtn = $("backHomeBtn");

// ✅ new (optional) IDs if you add them to HTML (safe if missing)
const levelPill = $("levelPill");                 // shows "Level 1/5"
const rematchBtn = $("rematchBtn");               // button in results
const rematchLabel = $("rematchLabel");           // span inside button

function show(screen) {
  homeScreen.classList.add("hidden");
  lobbyScreen.classList.add("hidden");
  gameScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  screen.classList.remove("hidden");
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* =========================
   AUTH
========================= */
let uid = null;

onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    authStatus.textContent = `Signed in: ${uid.slice(0, 6)}…`;
  }
});
await signInAnonymously(auth);

/* =========================
   PARSE MCQ TEXT
========================= */
function parseMcqText(raw) {
  const cut = raw.indexOf("## 📊");
  const text = cut > -1 ? raw.slice(0, cut) : raw;

  const blocks = [...text.matchAll(/\*\*(\d+)\.\s([\s\S]*?)\*\*([\s\S]*?)\*\*Answer:\s*([ABCD])\*\*/g)];
  const qs = [];

  for (const m of blocks) {
    const id = Number(m[1]);
    const q = m[2].trim();
    const opts = [...m[3].matchAll(/-\s*[ABCD]\)\s*(.*)/g)].map(x => x[1].trim());
    const answerIndex = { A:0, B:1, C:2, D:3 }[m[4].trim()];
    if (opts.length === 4) qs.push({ id, question: q, options: opts, answerIndex });
  }
  return qs.sort((a,b) => a.id - b.id);
}

const BANK = parseMcqText(RAW_MCQ_TEXT);
console.log("Loaded questions:", BANK.length);

/* =========================
   GAME STATE
========================= */
let currentRoomId = null;
let currentRoomCode = null;
let isHost = false;

let currentQuestionDoc = null;
let tick = null;

let lastStartAtMs = null;
let lastRevealAtMs = null;

function stopTick(){
  if(tick) clearInterval(tick);
  tick = null;
}

function tsToMs(ts){ return ts?.toMillis?.() ?? null; }

function setTimer(msLeft, total){
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  timerText.textContent = String(s).padStart(2, "0");
  const frac = Math.max(0, Math.min(1, msLeft / total));
  timerFill.style.transform = `scaleX(${frac})`;
}

/* =========================
   RANDOM PICK (NO REPEAT)
========================= */
function makeCode(len=4){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s=""; for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function shuffle(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function pickNextLevelQuestions(usedSourceIds){
  const used = new Set(usedSourceIds || []);
  const available = BANK.filter(q => !used.has(q.id));
  if(available.length < Q_PER_LEVEL) return null;
  return shuffle(available).slice(0, Q_PER_LEVEL);
}

/* =========================
   UI RENDERERS
========================= */
function renderScoreboard(players){
  scoreList.innerHTML = "";
  players.forEach(p => {
    const div = document.createElement("div");
    div.className = "scoreItem";

    const lvlScores = p.levelScores || {};
    const total = p.totalScore ?? p.score ?? 0;

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="scoreName">${escapeHtml(p.name || "Player")}${p.isHost ? " (Host)" : ""}</div>
      <div style="font-size:12px;color:rgba(15,31,51,0.60)">Total: <b>${total}</b></div>
    `;

    const right = document.createElement("div");
    right.className = "scoreNum";
    right.textContent = String(total);

    div.appendChild(left);
    div.appendChild(right);
    scoreList.appendChild(div);
  });
}

function renderQuestion(q){
  questionText.textContent = q.question;
  optionsArea.innerHTML = "";
  answerInfo.textContent = "";

  q.options.forEach((opt, idx) => {
    const b = document.createElement("button");
    b.className = "optBtn";
    b.dataset.idx = String(idx);
    b.textContent = `${String.fromCharCode(65+idx)}) ${opt}`;
    b.onclick = () => submitAnswer(idx);
    optionsArea.appendChild(b);
  });
}

function lockOptions(){
  for(const b of optionsArea.querySelectorAll("button")){
    b.disabled = true;
    b.classList.add("locked");
  }
}

function markSelectedNeutral(chosenIdx){
  for(const b of optionsArea.querySelectorAll("button")){
    const idx = Number(b.dataset.idx);
    if(idx === chosenIdx){
      b.classList.add("locked");
      b.style.outline = "2px solid rgba(74,141,255,0.45)";
    }
  }
}

function revealCorrectUI(chosenIdx){
  if(!currentQuestionDoc) return;
  const correct = currentQuestionDoc.answerIndex;

  for(const b of optionsArea.querySelectorAll("button")){
    const idx = Number(b.dataset.idx);
    b.disabled = true;
    b.classList.add("locked");

    // ✅ correct always green
    if(idx === correct) b.classList.add("correct");

    // ✅ if player selected wrong -> show selected red
    if(chosenIdx != null && idx === chosenIdx && chosenIdx !== correct){
      b.classList.add("wrong");
    }
  }

  if(chosenIdx == null){
    answerInfo.textContent = `⏱️ Time up! Correct: ${String.fromCharCode(65+correct)}`;
  } else if(chosenIdx === correct){
    answerInfo.textContent = `✅ Correct! (${String.fromCharCode(65+correct)})`;
  } else {
    answerInfo.textContent = `❌ Wrong. Correct: ${String.fromCharCode(65+correct)}`;
  }
}

/* =========================
   FIRESTORE: PLAYER
========================= */
async function upsertPlayer(roomId, name, hostFlag){
  await setDoc(doc(db,"rooms",roomId,"players",uid), {
    uid,
    name,
    score: 0,             // legacy (still ok)
    totalScore: 0,        // ✅ total across levels
    levelScores: {},      // ✅ {1: x, 2: y, ...}
    isHost: !!hostFlag,
    joinedAt: serverTimestamp(),
    answered: {},         // answered map per question index within a level
    lastAnswer: null
  }, { merge:true });
}

/* =========================
   ROOM LISTENERS
========================= */
function attachRoom(roomId){
  const roomRef = doc(db,"rooms",roomId);

  // players list
  const playersQ = query(collection(db,"rooms",roomId,"players"), orderBy("totalScore","desc"));
  onSnapshot(playersQ, (snap)=>{
    const players = snap.docs.map(d => d.data());
    renderScoreboard(players.slice(0,2));

    lobbyPlayers.innerHTML = players.map(p => `• ${escapeHtml(p.name)}${p.isHost?" (Host)":""}`).join("<br/>");
    window.__playerCount = players.length;
  });

  // room doc
  onSnapshot(roomRef, async (snap)=>{
    if(!snap.exists()) return;
    const r = snap.data();

    currentRoomCode = r.roomCode;
    lobbyCode.textContent = r.roomCode;
    roomCodePill.textContent = r.roomCode;

    lobbyStatus.textContent = r.status || "waiting";

    const level = r.level || 1;
    if(levelPill) levelPill.textContent = `Level ${level}/${MAX_LEVELS}`;

    // screen routing
    if (r.status === "waiting") show(lobbyScreen);
    if (r.status === "live") show(gameScreen);
    if (r.status === "level_done" || r.status === "finished_all") {
      show(resultsScreen);
      renderResults(r);
    }

    lobbyHostControls.classList.toggle("hidden", !isHost);

    const qIndex = r.currentQuestion ?? 0;
    qNum.textContent = String(qIndex + 1);
    phasePill.textContent = r.phase || "-";
    phaseText.textContent =
      r.phase === "question" ? "Answer now!"
    : r.phase === "reveal" ? "Showing correct answer…"
    : "—";

    // Load question doc
    if (r.status === "live") {
      const qRef = doc(db,"rooms",roomId,"questions", String(qIndex));
      const qSnap = await getDoc(qRef);
      if(qSnap.exists()){
        currentQuestionDoc = { id:qSnap.id, ...qSnap.data() };
        renderQuestion(currentQuestionDoc);
      }
    }

    // Timing triggers
    const startAtMs = tsToMs(r.questionStartAt);
    const revealAtMs = tsToMs(r.revealAt);

    if(startAtMs && startAtMs !== lastStartAtMs){
      lastStartAtMs = startAtMs;
      lastRevealAtMs = null;
      startTick(roomId);
    }
    if(revealAtMs && revealAtMs !== lastRevealAtMs){
      lastRevealAtMs = revealAtMs;
    }

    // Rematch button label
    if(rematchBtn && rematchLabel){
      const canRematch = isHost && (r.status === "level_done") && ((r.level || 1) < MAX_LEVELS);
      rematchBtn.classList.toggle("hidden", !canRematch);
      if(canRematch){
        rematchLabel.textContent = `Rematch to Level ${(r.level || 1) + 1}`;
      }
    }
  });

  // my player doc
  onSnapshot(doc(db,"rooms",roomId,"players",uid), (snap)=>{
    if(!snap.exists()) return;
    window.__me = snap.data();
  });
}

/* =========================
   TIMER LOOP + HOST AUTOMATION
========================= */
function startTick(roomId){
  stopTick();

  tick = setInterval(async ()=>{
    const roomRef = doc(db,"rooms",roomId);
    const snap = await getDoc(roomRef);
    if(!snap.exists()) return;
    const r = snap.data();
    if(r.status !== "live") return;

    const phase = r.phase;
    const startAt = tsToMs(r.questionStartAt);
    const revealAt = tsToMs(r.revealAt);
    const now = Date.now();

    // QUESTION PHASE
    if(phase === "question"){
      const msLeft = (startAt + QUESTION_MS) - now;
      setTimer(msLeft, QUESTION_MS);

      // if I already answered, show waiting message
      const me = window.__me;
      const qIndex = r.currentQuestion ?? 0;
      const iAnswered = !!me?.answered?.[String(qIndex)];
      if(iAnswered){
        answerInfo.textContent = "✅ Answer locked. Waiting for other player…";
      }

      // early reveal if all answered
      const answeredCount = r.answeredCount ?? 0;
      const playerCount = window.__playerCount ?? 0;
      if (isHost && playerCount > 0 && answeredCount >= playerCount) {
        await updateDoc(roomRef, { phase:"reveal", revealAt: serverTimestamp() });
        return;
      }

      // time ended -> host move to reveal
      if (msLeft <= 0){
        lockOptions();
        revealCorrectUI(null);
        if(isHost){
          await updateDoc(roomRef, { phase:"reveal", revealAt: serverTimestamp() });
        }
      }
    }

    // REVEAL PHASE
    if(phase === "reveal"){
      if(!revealAt) return;
      const msLeft = (revealAt + REVEAL_MS) - now;
      setTimer(msLeft, REVEAL_MS);

      const me = window.__me;
      const qIndex = r.currentQuestion ?? 0;
      let chosen = null;
      if (me?.lastAnswer?.qIndex === qIndex) chosen = me.lastAnswer.chosenIndex;

      lockOptions();
      revealCorrectUI(chosen);

      if(msLeft <= 0 && isHost){
        await nextOrLevelDone(roomId);
      }
    }
  }, 350);
}

/* =========================
   MOVE NEXT QUESTION OR END LEVEL
========================= */
async function nextOrLevelDone(roomId){
  const roomRef = doc(db,"rooms",roomId);

  await runTransaction(db, async (tx)=>{
    const s = await tx.get(roomRef);
    if(!s.exists()) return;
    const r = s.data();

    const q = r.currentQuestion ?? 0;
    const next = q + 1;

    if(next >= Q_PER_LEVEL){
      tx.update(roomRef, {
        status: "level_done",
        phase: "done",
        revealAt: null
      });
    } else {
      tx.update(roomRef, {
        currentQuestion: next,
        phase: "question",
        questionStartAt: serverTimestamp(),
        answeredCount: 0,
        revealAt: null
      });
    }
  });

  // if level ended, host saves leaderboard snapshot
  const s2 = await getDoc(roomRef);
  if(s2.exists() && s2.data().status === "level_done" && isHost){
    await computeLevelLeaderboard(roomId);
  }
}

/* =========================
   SUBMIT ANSWER
========================= */
async function submitAnswer(chosenIndex){
  if(!currentRoomId || !currentQuestionDoc) return;

  const roomRef = doc(db,"rooms",currentRoomId);
  const playerRef = doc(db,"rooms",currentRoomId,"players",uid);

  // optimistic UI: mark selected and disable
  lockOptions();
  markSelectedNeutral(chosenIndex);
  answerInfo.textContent = "✅ Answer locked. Waiting for other player…";

  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    const pSnap = await tx.get(playerRef);
    if(!roomSnap.exists() || !pSnap.exists()) return;

    const r = roomSnap.data();
    if(r.status !== "live" || r.phase !== "question") return;

    const startMs = tsToMs(r.questionStartAt);
    if(!startMs) return;
    if(Date.now() > startMs + QUESTION_MS) return;

    const qIndex = r.currentQuestion ?? 0;
    const p = pSnap.data();
    const answered = p.answered || {};
    if(answered[String(qIndex)]) return; // already answered

    answered[String(qIndex)] = true;

    const correct = currentQuestionDoc.answerIndex;
    const isCorrect = chosenIndex === correct;

    const level = r.level || 1;
    const levelScores = p.levelScores || {};
    const prevLevelScore = levelScores[String(level)] || 0;
    const newLevelScore = prevLevelScore + (isCorrect ? 1 : 0);
    levelScores[String(level)] = newLevelScore;

    const totalScore = (p.totalScore || 0) + (isCorrect ? 1 : 0);

    tx.update(playerRef, {
      answered,
      levelScores,
      totalScore,
      lastAnswer: { qIndex, chosenIndex, at: serverTimestamp() }
    });

    // increment room answeredCount
    tx.update(roomRef, { answeredCount: (r.answeredCount || 0) + 1 });
  });
}

/* =========================
   HOST/ JOIN FLOW
========================= */
hostBtn.onclick = async ()=>{
  const name = nameInput.value.trim() || "Host";

  if(BANK.length !== 100){
    alert("Your MCQ bank did not load as 100. Check rawQuestions.js");
    return;
  }

  isHost = true;
  const code = makeCode(4);
  roomCodeInput.value = code;

  const roomDoc = doc(collection(db,"rooms"));
  currentRoomId = roomDoc.id;

  await setDoc(doc(db,"roomCodes", code), { roomId: roomDoc.id, createdAt: serverTimestamp() });

  await setDoc(roomDoc, {
    roomCode: code,
    hostId: uid,
    status: "waiting",
    level: 1,
    usedSourceIds: [],
    currentQuestion: 0,
    createdAt: serverTimestamp()
  });

  await upsertPlayer(roomDoc.id, name, true);

  show(lobbyScreen);
  attachRoom(roomDoc.id);
};

joinBtn.onclick = async ()=>{
  const name = nameInput.value.trim() || "Player";
  const code = roomCodeInput.value.trim().toUpperCase();
  if(!code) return alert("Enter room code");

  isHost = false;

  const codeSnap = await getDoc(doc(db,"roomCodes", code));
  if(!codeSnap.exists()) return alert("Room not found");

  const { roomId } = codeSnap.data();
  currentRoomId = roomId;

  await upsertPlayer(roomId, name, false);

  show(lobbyScreen);
  attachRoom(roomId);
};

/* =========================
   START LEVEL 1 (HOST)
========================= */
startBtn.onclick = async ()=>{
  if(!currentRoomId) return;

  const roomRef = doc(db,"rooms",currentRoomId);
  const roomSnap = await getDoc(roomRef);
  if(!roomSnap.exists()) return;

  const r = roomSnap.data();
  const level = r.level || 1;
  const used = r.usedSourceIds || [];

  const selected = pickNextLevelQuestions(used);
  if(!selected){
    alert("Not enough unused questions left.");
    return;
  }

  // write questions
  const batch = writeBatch(db);

  selected.forEach((q, idx)=>{
    batch.set(doc(db,"rooms",currentRoomId,"questions", String(idx)), {
      question: q.question,
      options: q.options,
      answerIndex: q.answerIndex,
      sourceId: q.id
    });
  });

  // update used list
  const newUsed = [...used, ...selected.map(q => q.id)];

  // reset players answered map (new level)
  const playersSnap = await getDocs(collection(db,"rooms",currentRoomId,"players"));
  playersSnap.forEach(pdoc=>{
    batch.update(doc(db,"rooms",currentRoomId,"players", pdoc.id), {
      answered: {},
      lastAnswer: null
    });
  });

  batch.update(roomRef, {
    status: "live",
    phase: "question",
    currentQuestion: 0,
    questionStartAt: serverTimestamp(),
    answeredCount: 0,
    revealAt: null,
    usedSourceIds: newUsed,
    startedAt: serverTimestamp()
  });

  await batch.commit();
};

/* =========================
   LEVEL LEADERBOARD
========================= */
async function computeLevelLeaderboard(roomId){
  const roomRef = doc(db,"rooms",roomId);
  const roomSnap = await getDoc(roomRef);
  if(!roomSnap.exists()) return;
  const r = roomSnap.data();
  const level = r.level || 1;

  const snap = await getDocs(collection(db,"rooms",roomId,"players"));
  const players = snap.docs.map(d => d.data())
    .sort((a,b)=> (b.totalScore||0)-(a.totalScore||0));

  const top2 = players.slice(0,2).map(p => ({
    name: p.name,
    uid: p.uid,
    totalScore: p.totalScore || 0,
    levelScores: p.levelScores || {}
  }));

  await updateDoc(roomRef, {
    lastLevelLeaderboard: top2,
    lastLevel: level
  });
}

/* =========================
   REMATCH / NEXT LEVEL (HOST)
========================= */
if(rematchBtn){
  rematchBtn.onclick = async ()=>{
    if(!currentRoomId) return;

    const roomRef = doc(db,"rooms",currentRoomId);
    const roomSnap = await getDoc(roomRef);
    if(!roomSnap.exists()) return;

    const r = roomSnap.data();
    const level = r.level || 1;
    if(level >= MAX_LEVELS) return;

    const nextLevel = level + 1;
    const used = r.usedSourceIds || [];

    const selected = pickNextLevelQuestions(used);
    if(!selected){
      alert("Not enough unused questions left for next level.");
      return;
    }

    const batch = writeBatch(db);

    // write new questions (0..19)
    selected.forEach((q, idx)=>{
      batch.set(doc(db,"rooms",currentRoomId,"questions", String(idx)), {
        question: q.question,
        options: q.options,
        answerIndex: q.answerIndex,
        sourceId: q.id
      });
    });

    // reset player answered map
    const playersSnap = await getDocs(collection(db,"rooms",currentRoomId,"players"));
    playersSnap.forEach(pdoc=>{
      batch.update(doc(db,"rooms",currentRoomId,"players", pdoc.id), {
        answered: {},
        lastAnswer: null
      });
    });

    const newUsed = [...used, ...selected.map(q => q.id)];

    batch.update(roomRef, {
      level: nextLevel,
      status: "live",
      phase: "question",
      currentQuestion: 0,
      questionStartAt: serverTimestamp(),
      answeredCount: 0,
      revealAt: null,
      usedSourceIds: newUsed
    });

    await batch.commit();
  };
}

/* =========================
   RESULTS UI
========================= */
function renderResults(roomData){
  const level = roomData.level || 1;

  // if finished all levels, show FINAL leaderboard
  const finishedAll = roomData.status === "finished_all" || level >= MAX_LEVELS;

  leaderboardBox.innerHTML = "";

  const title = document.createElement("div");
  title.className = "muted";
  title.style.marginBottom = "10px";
  title.innerHTML = finishedAll
    ? `<b>Final Results</b> (All Levels)`
    : `<b>Level ${level} Finished</b>`;

  leaderboardBox.appendChild(title);

  // show top players from live data
  // We compute from players collection
  (async ()=>{
    const snap = await getDocs(collection(db,"rooms",currentRoomId,"players"));
    const players = snap.docs.map(d => d.data())
      .sort((a,b)=> (b.totalScore||0)-(a.totalScore||0));

    const top2 = players.slice(0,2);

    if(!top2.length){
      leaderboardBox.innerHTML = `<div class="muted">No players found.</div>`;
      return;
    }

    const winner = top2[0];
    const runner = top2[1];

    // card maker
    const makePlayerCard = (label, p, medal) => {
      const levels = p.levelScores || {};
      let lines = "";
      for(let i=1;i<=MAX_LEVELS;i++){
        if(levels[String(i)] != null){
          lines += `<div class="muted" style="font-size:12px">Level ${i}: <b>${levels[String(i)]}</b></div>`;
        }
      }

      return `
        <div class="scoreItem" style="margin-top:10px">
          <div>
            <div class="scoreName">${medal} ${label}: ${escapeHtml(p.name)}</div>
            <div class="muted" style="font-size:12px;margin-top:6px">Total: <b>${p.totalScore || 0}</b></div>
            ${lines}
          </div>
          <div class="scoreNum">${p.totalScore || 0}</div>
        </div>
      `;
    };

    leaderboardBox.innerHTML += makePlayerCard("Winner", winner, "🏆");
    if(runner){
      leaderboardBox.innerHTML += makePlayerCard("Runner-up", runner, "🥈");
    } else {
      leaderboardBox.innerHTML += `<div class="muted" style="margin-top:12px">Only one player joined.</div>`;
    }

    // if this is the end of level and host wants to stop early:
    if(isHost && !finishedAll && level < MAX_LEVELS){
      leaderboardBox.innerHTML += `<div class="muted" style="margin-top:12px">Host can start the next level using the Rematch button.</div>`;
    }
    if(finishedAll){
      leaderboardBox.innerHTML += `<div class="muted" style="margin-top:12px">Match complete ✅</div>`;
    }
  })();
}

backHomeBtn.onclick = ()=>{
  stopTick();
  currentRoomId = null;
  currentRoomCode = null;
  isHost = false;
  lastStartAtMs = null;
  lastRevealAtMs = null;
  show(homeScreen);
};

/* =========================
   OPTIONAL: AUTO FINISH ALL LEVELS
   (If you want: when level 5 ends, set status finished_all)
========================= */
onSnapshot(collection(db,"rooms"), ()=>{}); // no-op, keeps module active
