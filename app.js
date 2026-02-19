import { RAW_MCQ_TEXT } from "./rawQuestions.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, onSnapshot,
  updateDoc, serverTimestamp, writeBatch, runTransaction, query, orderBy, getDocs
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDg4OZWHV2AAR6_h40oQ3_16KxS5gmuFtI",
  authDomain: "master-mcq-2ee53.firebaseapp.com",
  projectId: "master-mcq-2ee53",
  storageBucket: "master-mcq-2ee53.firebasestorage.app",
  messagingSenderId: "643022714882",
  appId: "1:643022714882:web:19aa55481475598cefcf1b",
  measurementId: "G-SNP025BS5G"
};

const QUESTION_MS = 15000; // 15s answer time
const REVEAL_MS   = 5000;  // 5s show correct
const TOTAL_Q = 20;

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---------- UI ----------
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

// ---------- State ----------
let uid = null;
let currentRoomId = null;
let currentRoomCode = null;
let isHost = false;

let currentQuestionDoc = null;

let tick = null;
let lastStartAtMs = null;
let lastRevealAtMs = null;

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    authStatus.textContent = `Signed in: ${uid.slice(0, 6)}…`;
  }
});
await signInAnonymously(auth);

// ---------- MCQ parser ----------
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

// ---------- Helpers ----------
function show(screen) {
  homeScreen.classList.add("hidden");
  lobbyScreen.classList.add("hidden");
  gameScreen.classList.add("hidden");
  resultsScreen.classList.add("hidden");
  screen.classList.remove("hidden");
}
function makeCode(len=4){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s=""; for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function pickRandomN(arr,n){
  const copy=[...arr];
  for(let i=copy.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [copy[i],copy[j]]=[copy[j],copy[i]];
  }
  return copy.slice(0,n);
}
function tsToMs(ts){ return ts?.toMillis?.() ?? null; }

function setTimer(msLeft, total){
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  timerText.textContent = String(s).padStart(2, "0");
  const frac = Math.max(0, Math.min(1, msLeft / total));
  timerFill.style.transform = `scaleX(${frac})`;
}

function renderScoreboard(players){
  scoreList.innerHTML = "";
  // show top 2 visually (but still works with more)
  players.forEach(p => {
    const div = document.createElement("div");
    div.className = "scoreItem";
    const left = document.createElement("div");
    left.innerHTML = `<div class="scoreName">${escapeHtml(p.name || "Player")}${p.isHost ? " (Host)" : ""}</div>
                      <div style="font-size:12px;color:rgba(234,240,255,0.65)">${p.uid?.slice(0,6) ?? ""}</div>`;
    const right = document.createElement("div");
    right.className = "scoreNum";
    right.textContent = String(p.score ?? 0);
    div.appendChild(left);
    div.appendChild(right);
    scoreList.appendChild(div);
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
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

function revealCorrectUI(chosenIdx){
  if(!currentQuestionDoc) return;
  const correct = currentQuestionDoc.answerIndex;

  for(const b of optionsArea.querySelectorAll("button")){
    const idx = Number(b.dataset.idx);
    b.disabled = true;
    b.classList.add("locked");
    if(idx === correct) b.classList.add("correct");
    if(chosenIdx != null && idx === chosenIdx && chosenIdx !== correct) b.classList.add("wrong");
  }

  if(chosenIdx == null){
    answerInfo.textContent = `⏱️ Time up! Correct: ${String.fromCharCode(65+correct)}`;
  } else if(chosenIdx === correct){
    answerInfo.textContent = `✅ Correct! (${String.fromCharCode(65+correct)})`;
  } else {
    answerInfo.textContent = `❌ Wrong. Correct: ${String.fromCharCode(65+correct)}`;
  }
}

// ---------- Firestore player doc (uid as doc id) ----------
async function upsertPlayer(roomId, name, hostFlag){
  await setDoc(doc(db,"rooms",roomId,"players",uid), {
    uid,
    name,
    score: 0,
    isHost: !!hostFlag,
    joinedAt: serverTimestamp(),
    // answered map per qIndex
    answered: {}
  }, { merge:true });
}

// ---------- Room listeners ----------
function attachRoom(roomId){
  const roomRef = doc(db,"rooms",roomId);

  // players
  const playersQ = query(collection(db,"rooms",roomId,"players"), orderBy("score","desc"));
  onSnapshot(playersQ, (snap)=>{
    const players = snap.docs.map(d => d.data());
    // keep only top 2 for the “both players” scorecard look
    renderScoreboard(players.slice(0,2));

    // Lobby list
    lobbyPlayers.innerHTML = players.map(p => `• ${escapeHtml(p.name)}${p.isHost?" (Host)":""}`).join("<br/>");

    // We also use playerCount for early reveal logic:
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

    // screen routing
    if (r.status === "waiting") {
      show(lobbyScreen);
    } else if (r.status === "live") {
      show(gameScreen);
    } else if (r.status === "finished") {
      show(resultsScreen);
      renderResults(r);
    }

    // host-only controls in lobby
    lobbyHostControls.classList.toggle("hidden", !isHost);

    // game UI meta
    const qIndex = r.currentQuestion ?? 0;
    qNum.textContent = String(qIndex + 1);
    phasePill.textContent = r.phase || "-";
    phaseText.textContent = r.phase === "question"
      ? "Answer now!"
      : r.phase === "reveal"
        ? "Showing correct answer…"
        : "—";

    // Load question doc when index changes
    if (r.status === "live") {
      const qRef = doc(db,"rooms",roomId,"questions", String(qIndex));
      const qSnap = await getDoc(qRef);
      if(qSnap.exists()){
        currentQuestionDoc = { id:qSnap.id, ...qSnap.data() };
        renderQuestion(currentQuestionDoc);
      }
    }

    // Timing
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
  });

  // my own player doc (to reveal chosen answer highlight)
  onSnapshot(doc(db,"rooms",roomId,"players",uid), (snap)=>{
    if(!snap.exists()) return;
    window.__me = snap.data();
  });
}

// ---------- Timer + host automation ----------
function stopTick(){
  if(tick) clearInterval(tick);
  tick = null;
}

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

    // PHASE: question
    if(phase === "question"){
      const msLeft = (startAt + QUESTION_MS) - now;
      setTimer(msLeft, QUESTION_MS);

      // early reveal: if everyone answered
      const answeredCount = r.answeredCount ?? 0;
      const playerCount = window.__playerCount ?? 0;

      if (isHost && playerCount > 0 && answeredCount >= playerCount) {
        // trigger reveal now
        await updateDoc(roomRef, { phase:"reveal", revealAt: serverTimestamp() });
        return;
      }

      // time ended -> host moves to reveal
      if (msLeft <= 0){
        lockOptions();
        revealCorrectUI(null);
        if(isHost){
          await updateDoc(roomRef, { phase:"reveal", revealAt: serverTimestamp() });
        }
      }
    }

    // PHASE: reveal
    if(phase === "reveal"){
      // show reveal timer (5s)
      if(!revealAt) return;
      const msLeft = (revealAt + REVEAL_MS) - now;
      setTimer(msLeft, REVEAL_MS);

      // reveal correct (client UI)
      const me = window.__me;
      const qIndex = r.currentQuestion ?? 0;
      let chosen = null;
      if (me?.lastAnswer?.qIndex === qIndex) chosen = me.lastAnswer.chosenIndex;
      lockOptions();
      revealCorrectUI(chosen);

      // after reveal -> host moves next question or finish
      if(msLeft <= 0 && isHost){
        await nextOrFinish(roomId);
      }
    }
  }, 350);
}

async function nextOrFinish(roomId){
  const roomRef = doc(db,"rooms",roomId);
  await runTransaction(db, async (tx)=>{
    const s = await tx.get(roomRef);
    if(!s.exists()) return;
    const r = s.data();
    const q = r.currentQuestion ?? 0;
    const next = q + 1;

    if(next >= TOTAL_Q){
      tx.update(roomRef, { status:"finished", phase:"done" });
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

  // if finished, host computes leaderboard
  const s2 = await getDoc(roomRef);
  if(s2.exists() && s2.data().status === "finished" && isHost){
    await computeLeaderboard(roomId);
  }
}

// ---------- Answer submit ----------
async function submitAnswer(chosenIndex){
  if(!currentRoomId || !currentQuestionDoc) return;

  const roomRef = doc(db,"rooms",currentRoomId);
  const playerRef = doc(db,"rooms",currentRoomId,"players",uid);

  await runTransaction(db, async (tx)=>{
    const roomSnap = await tx.get(roomRef);
    const pSnap = await tx.get(playerRef);
    if(!roomSnap.exists() || !pSnap.exists()) return;

    const r = roomSnap.data();
    if(r.status !== "live" || r.phase !== "question") return;

    // prevent late answers (based on questionStartAt)
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
    const newScore = (p.score || 0) + (isCorrect ? 1 : 0);

    tx.update(playerRef, {
      answered,
      score: newScore,
      lastAnswer: { qIndex, chosenIndex, at: serverTimestamp() }
    });

    // increment room answeredCount
    const newAnsweredCount = (r.answeredCount || 0) + 1;
    tx.update(roomRef, { answeredCount: newAnsweredCount });
  });

  answerInfo.textContent = "Answer saved ✅";
}

// ---------- Host / Join flow ----------
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

  // roomCodes lookup
  await setDoc(doc(db,"roomCodes", code), { roomId: roomDoc.id, createdAt: serverTimestamp() });

  // room
  await setDoc(roomDoc, {
    roomCode: code,
    hostId: uid,
    status: "waiting",
    currentQuestion: 0,
    totalQuestions: TOTAL_Q,
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

// ---------- Start match (Host) ----------
startBtn.onclick = async ()=>{
  if(!currentRoomId) return;

  // choose 20 random, write into room questions
  const selected = pickRandomN(BANK, TOTAL_Q);
  const batch = writeBatch(db);

  selected.forEach((q, idx)=>{
    batch.set(doc(db,"rooms",currentRoomId,"questions", String(idx)), {
      question: q.question,
      options: q.options,
      answerIndex: q.answerIndex,
      sourceId: q.id
    });
  });

  batch.update(doc(db,"rooms",currentRoomId), {
    status: "live",
    phase: "question",
    currentQuestion: 0,
    questionStartAt: serverTimestamp(),
    answeredCount: 0,
    revealAt: null,
    startedAt: serverTimestamp()
  });

  await batch.commit();
};

// ---------- Results ----------
async function computeLeaderboard(roomId){
  const snap = await getDocs(collection(db,"rooms",roomId,"players"));
  const players = snap.docs.map(d => d.data()).sort((a,b)=> (b.score||0)-(a.score||0));
  const top2 = players.slice(0,2).map(p => ({ name: p.name, score: p.score || 0, uid: p.uid }));

  await updateDoc(doc(db,"rooms",roomId), {
    leaderboard: top2,
    finishedAt: serverTimestamp()
  });
}

function renderResults(roomData){
  const lb = roomData.leaderboard || [];
  if(!lb.length){
    leaderboardBox.innerHTML = `<div class="muted">Leaderboard not ready yet (host will save it).</div>`;
    return;
  }
  const winner = lb[0];
  const runner = lb[1];

  leaderboardBox.innerHTML = `
    <div class="scoreItem" style="margin-top:0">
      <div>
        <div class="scoreName">🏆 Winner: ${escapeHtml(winner.name)}</div>
        <div style="font-size:12px;color:rgba(234,240,255,0.65)">Score</div>
      </div>
      <div class="scoreNum">${winner.score}</div>
    </div>
    ${runner ? `
    <div class="scoreItem">
      <div>
        <div class="scoreName">🥈 Runner-up: ${escapeHtml(runner.name)}</div>
        <div style="font-size:12px;color:rgba(234,240,255,0.65)">Score</div>
      </div>
      <div class="scoreNum">${runner.score}</div>
    </div>` : `
    <div class="muted" style="margin-top:10px">Only one player joined.</div>`
    }
  `;
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
