/* app.js — 2-player MCQ room game (Firebase + Firestore)
   - Lobby Start button enables only for host when 2 players joined
   - 20 questions per level, 5 levels total (100 questions)
   - 20s answer time + 5s reveal time
   - Shows room code in lobby (top pill) + bottom match id boxes
   - Anonymous auth
   IMPORTANT: This file expects the HTML IDs/classes listed in the "DOM IDS" section below.
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, onSnapshot,
  collection, query, where, getDocs, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

/* =========================
   ✅ 1) Firebase config
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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* =========================
   ✅ 2) DOM IDs expected
   =========================
   Screens:
   - homeScreen, lobbyScreen, gameScreen, resultsScreen

   Home inputs/buttons:
   - playerNameInput
   - hostBtn
   - joinBtn
   - joinCodeInput

   Lobby:
   - startBtn
   - copyCodeBtn
   - leaveBtn
   - roomCodePill (text)
   - matchIdBoxes (4 boxes container OR 4 spans with data-matchbox)
   - playersList (ul/div)
   - leftPlayerName (top-left name text)
   - leftTotalScore (top-left total score)
   - leftLevelPill (Level 1/5 text)

   Game:
   - qIndexText (e.g. "Question 3/20")
   - timerText  (e.g. "20")
   - timerBar   (progress bar element)
   - qText
   - optBtns (buttons with data-opt="0..3" OR ids opt0,opt1,opt2,opt3)
   - leftScoreYou, leftScoreOther (scoreboard in left panel)

   Results:
   - leaderboardBox (container)
   - rematchBtn
   - resultsTitle
*/

/* =========================
   ✅ 3) State
   ========================= */
let myUid = null;
let myName = "Player";
let currentRoomCode = null;

let roomState = null;
let playersState = {}; // { uid: {name, score, totalScore, levelScores:{1:..}, joinedAt } }

let roomUnsub = null;
let playersUnsub = null;

let localTimer = null;
let localPhase = null; // "question" | "reveal"

/* =========================
   ✅ 4) Helpers
   ========================= */
function $(id){ return document.getElementById(id); }

function showScreen(screenId){
  ["homeScreen","lobbyScreen","gameScreen","resultsScreen"].forEach(id=>{
    const el = $(id);
    if(!el) return;
    el.classList.toggle("hidden", id !== screenId);
  });
}

function safeText(el, text){
  if(!el) return;
  el.textContent = text ?? "";
}

function randRoomCode(){
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusing chars
  let out = "";
  for(let i=0;i<4;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

// Fisher-Yates shuffle
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

/* =========================
   ✅ 5) Questions source
   =========================
   Option A (recommended):
     Create collection: /questions/{qid}
     Each doc:
       { question: string, options: [a,b,c,d], answerIndex: number }
   Then set TOTAL_QUESTIONS = 100.
*/
const TOTAL_QUESTIONS = 100;

async function getAllQuestionIds(){
  // expects questions docs named q1..q100 OR any 100 docs
  // If your doc IDs are q1..q100, you can skip fetching and generate IDs.
  // We'll attempt to fetch, fallback to q1..q100.
  try{
    const snap = await getDocs(collection(db,"questions"));
    if(snap.size >= TOTAL_QUESTIONS){
      const ids = [];
      snap.forEach(d=>ids.push(d.id));
      return ids.slice(0, TOTAL_QUESTIONS);
    }
  }catch(e){
    console.warn("questions fetch failed, fallback to q1..q100", e);
  }
  // fallback
  const ids = [];
  for(let i=1;i<=TOTAL_QUESTIONS;i++) ids.push(`q${i}`);
  return ids;
}

function pickRandomUnique(fromIds, count, excludeSet){
  const ex = excludeSet ? new Set(excludeSet) : new Set();
  const pool = fromIds.filter(id=>!ex.has(id));
  const mixed = shuffle(pool);
  return mixed.slice(0, count);
}

/* =========================
   ✅ 6) Firestore refs
   ========================= */
function roomDocRef(code){ return doc(db, "rooms", code); }
function playersColRef(code){ return collection(db, "rooms", code, "players"); }

/* =========================
   ✅ 7) UI: room code + match id boxes
   ========================= */
function setRoomCodeUI(code){
  const c = (code || "----").toUpperCase();
  // top pill
  safeText($("roomCodePill"), c);

  // bottom 4 boxes
  const container = $("matchIdBoxes");
  if(container){
    const boxes = Array.from(container.querySelectorAll("[data-matchbox]"));
    if(boxes.length === 4){
      boxes.forEach((b,i)=> b.textContent = c[i] || "-");
    }else{
      // try children 4
      const kids = Array.from(container.children).slice(0,4);
      if(kids.length === 4){
        kids.forEach((k,i)=> k.textContent = c[i] || "-");
      }
    }
  }
}

function setLeftTopUI(){
  const my = playersState?.[myUid];
  safeText($("leftPlayerName"), my?.name || myName || "PLAYER");
  safeText($("leftTotalScore"), String(my?.totalScore ?? 0));
  const lv = roomState?.level ?? 1;
  safeText($("leftLevelPill"), `Level ${lv}/5`);
}

/* =========================
   ✅ 8) Lobby button enable logic
   ========================= */
function updateStartButton(){
  const btn = $("startBtn");
  if(!btn || !roomState) return;

  const playersCount = Object.keys(playersState || {}).length;
  const isHost = roomState.hostId === myUid;
  const canStart = isHost && roomState.status === "waiting" && playersCount >= 2;

  btn.disabled = !canStart;
}

/* =========================
   ✅ 9) Render players list + left scoreboard
   ========================= */
function renderPlayers(){
  const list = $("playersList");
  if(list){
    list.innerHTML = "";
    const entries = Object.entries(playersState || {});
    entries.sort((a,b)=> (a[1].joinedAt?.seconds||0) - (b[1].joinedAt?.seconds||0));
    entries.forEach(([uid,p])=>{
      const div = document.createElement("div");
      div.className = "playerRow";
      const tag = (uid === roomState?.hostId) ? " (Host)" : "";
      div.innerHTML = `<strong>${escapeHtml(p.name||"Player")}${tag}</strong><div class="muted">Total: ${p.totalScore ?? 0}</div>`;
      list.appendChild(div);
    });
  }

  // left scoreboard in game
  const ids = Object.keys(playersState || {});
  const otherUid = ids.find(id=>id!==myUid) || null;
  const me = playersState?.[myUid];
  const other = otherUid ? playersState?.[otherUid] : null;

  safeText($("leftScoreYou"), `${me?.name || "You"}: ${me?.score ?? 0}`);
  safeText($("leftScoreOther"), other ? `${other.name}: ${other.score ?? 0}` : `Waiting...`);

  setLeftTopUI();
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

/* =========================
   ✅ 10) Game rendering
   ========================= */
async function renderCurrentQuestion(){
  if(!roomState) return;
  const idx = roomState.currentIndex ?? 0;
  const ids = roomState.questionIds || [];
  const qid = ids[idx];
  if(!qid){
    console.warn("No question id yet", roomState);
    return;
  }

  const snap = await getDoc(doc(db,"questions", qid));
  if(!snap.exists()){
    console.error("Question doc missing:", qid);
    return;
  }
  const q = snap.data();

  safeText($("qIndexText"), `Question ${idx+1}/20`);
  safeText($("qText"), q.question || "");

  // option buttons
  const optButtons = getOptionButtons();
  (q.options || []).forEach((txt,i)=>{
    if(optButtons[i]) optButtons[i].textContent = txt;
  });

  // reset states
  optButtons.forEach(btn=>{
    btn.disabled = false;
    btn.classList.remove("picked","correct","wrong","reveal");
  });

  localPhase = "question";
  startLocalTimerFromRoom();
}

function getOptionButtons(){
  // supports either data-opt=0..3 or ids opt0..opt3
  const byData = Array.from(document.querySelectorAll("[data-opt]"));
  if(byData.length >= 4){
    return [0,1,2,3].map(i => byData.find(b=> String(b.dataset.opt)===String(i)));
  }
  return [ $("opt0"), $("opt1"), $("opt2"), $("opt3") ].filter(Boolean);
}

/* =========================
   ✅ 11) Timing (20s question + 5s reveal)
   ========================= */
function clearLocalTimer(){
  if(localTimer){
    clearInterval(localTimer);
    localTimer = null;
  }
}

function startLocalTimerFromRoom(){
  clearLocalTimer();

  const startedAt = roomState.questionStartedAt;
  const phase = roomState.phase || "question"; // "question"|"reveal"
  localPhase = phase;

  // We compute remaining based on serverTimestamp start (best-effort)
  const QUESTION_MS = 20_000;
  const REVEAL_MS = 5_000;

  const startMs = startedAt?.toMillis ? startedAt.toMillis() : Date.now();
  const now0 = Date.now();
  let elapsed = now0 - startMs;

  const duration = (phase === "reveal") ? REVEAL_MS : QUESTION_MS;

  function tick(){
    const now = Date.now();
    elapsed = now - startMs;
    let remaining = Math.max(0, duration - elapsed);

    const sec = Math.ceil(remaining/1000);
    safeText($("timerText"), String(sec));

    const bar = $("timerBar");
    if(bar){
      const pct = Math.max(0, Math.min(100, (remaining/duration)*100));
      bar.style.width = `${pct}%`;
    }

    if(remaining <= 0){
      clearLocalTimer();
    }
  }

  tick();
  localTimer = setInterval(tick, 100);
}

/* =========================
   ✅ 12) Answer submit
   ========================= */
async function submitAnswer(optionIndex){
  if(!currentRoomCode || !roomState) return;
  if(roomState.status !== "playing") return;

  const idx = roomState.currentIndex ?? 0;
  const phase = roomState.phase || "question";
  if(phase !== "question") return; // no answering during reveal

  const meRef = doc(db, "rooms", currentRoomCode, "players", myUid);

  // write answer for this question index
  await updateDoc(meRef, {
    [`answers.${idx}`]: optionIndex
  });

  // disable buttons locally (keep waiting view)
  const optButtons = getOptionButtons();
  optButtons.forEach(b=> b.disabled = true);
  if(optButtons[optionIndex]) optButtons[optionIndex].classList.add("picked");

  // if both answered before time, host will reveal early (handled below)
}

/* =========================
   ✅ 13) Host: advance phases
   ========================= */
async function hostMaybeRevealEarly(){
  if(!roomState || roomState.hostId !== myUid) return;
  if(roomState.phase !== "question") return;

  const idx = roomState.currentIndex ?? 0;
  const ids = Object.keys(playersState || {});
  if(ids.length < 2) return;

  const p1 = playersState[ids[0]];
  const p2 = playersState[ids[1]];
  const a1 = p1?.answers?.[idx];
  const a2 = p2?.answers?.[idx];

  if(typeof a1 === "number" && typeof a2 === "number"){
    // both answered -> switch to reveal
    await updateDoc(roomDocRef(currentRoomCode), {
      phase: "reveal",
      revealStartedAt: serverTimestamp()
    });
  }
}

async function hostScoreAndNext(){
  if(!roomState || roomState.hostId !== myUid) return;
  if(roomState.phase !== "reveal") return;

  const idx = roomState.currentIndex ?? 0;
  const qid = (roomState.questionIds || [])[idx];
  if(!qid) return;

  const qSnap = await getDoc(doc(db,"questions", qid));
  if(!qSnap.exists()) return;
  const q = qSnap.data();
  const correct = q.answerIndex;

  // score both players (simple: +10 if correct)
  const ids = Object.keys(playersState || {});
  for(const uid of ids){
    const p = playersState[uid];
    const ans = p?.answers?.[idx];
    const isCorrect = (typeof ans === "number" && ans === correct);
    if(isCorrect){
      await updateDoc(doc(db,"rooms",currentRoomCode,"players",uid), {
        score: increment(10),
        totalScore: increment(10),
        [`levelScores.${roomState.level || 1}`]: increment(10)
      });
    }
  }

  // move to next question or finish level
  const nextIndex = idx + 1;
  if(nextIndex < 20){
    await updateDoc(roomDocRef(currentRoomCode), {
      currentIndex: nextIndex,
      phase: "question",
      questionStartedAt: serverTimestamp()
    });
  }else{
    // finish level
    const level = roomState.level || 1;
    if(level < 5){
      await updateDoc(roomDocRef(currentRoomCode), {
        status: "level_finished"
      });
    }else{
      await updateDoc(roomDocRef(currentRoomCode), {
        status: "finished"
      });
    }
  }
}

/* =========================
   ✅ 14) Show reveal UI (green/red)
   ========================= */
async function renderReveal(){
  if(!roomState) return;
  const idx = roomState.currentIndex ?? 0;
  const qid = (roomState.questionIds || [])[idx];
  if(!qid) return;

  const qSnap = await getDoc(doc(db,"questions", qid));
  if(!qSnap.exists()) return;
  const q = qSnap.data();
  const correct = q.answerIndex;

  const optButtons = getOptionButtons();
  optButtons.forEach((btn,i)=>{
    btn.disabled = true;
    btn.classList.add("reveal");
    if(i === correct) btn.classList.add("correct");
  });

  // mark my choice wrong if incorrect
  const myAns = playersState?.[myUid]?.answers?.[idx];
  if(typeof myAns === "number" && myAns !== correct && optButtons[myAns]){
    optButtons[myAns].classList.add("wrong");
  }
}

/* =========================
   ✅ 15) Level rematch (next 20 unused)
   ========================= */
async function hostStartNextLevel(){
  if(!roomState || roomState.hostId !== myUid) return;
  const level = roomState.level || 1;
  const nextLevel = level + 1;
  if(nextLevel > 5) return;

  const allIds = await getAllQuestionIds();
  const used = roomState.usedQuestionIds || [];
  const picked = pickRandomUnique(allIds, 20, used);

  // reset per-level scores (keep totalScore) and answers map
  const ids = Object.keys(playersState || {});
  for(const uid of ids){
    await updateDoc(doc(db,"rooms",currentRoomCode,"players",uid), {
      score: 0,
      answers: {}
    });
  }

  await updateDoc(roomDocRef(currentRoomCode), {
    status: "playing",
    level: nextLevel,
    questionIds: picked,
    usedQuestionIds: [...used, ...picked],
    currentIndex: 0,
    phase: "question",
    questionStartedAt: serverTimestamp()
  });
}

/* =========================
   ✅ 16) Render results (winner + runner up + per-level totals)
   ========================= */
function renderResults(){
  const box = $("leaderboardBox");
  if(!box) return;

  const entries = Object.entries(playersState || {}).map(([uid,p])=>({
    uid, name: p.name || "Player",
    total: p.totalScore ?? 0,
    levelScores: p.levelScores || {}
  }));

  entries.sort((a,b)=> b.total - a.total);

  const winner = entries[0];
  const runner = entries[1];

  safeText($("resultsTitle"), winner ? `Winner: ${winner.name}` : "Match finished");

  box.innerHTML = `
    <div class="lbRow">
      <div class="rank">#1</div>
      <div class="pname">${escapeHtml(winner?.name||"-")}</div>
      <div class="pts">${winner?.total ?? 0} pts</div>
    </div>
    <div class="lbRow">
      <div class="rank">#2</div>
      <div class="pname">${escapeHtml(runner?.name||"-")}</div>
      <div class="pts">${runner?.total ?? 0} pts</div>
    </div>
    <hr style="opacity:.2;margin:14px 0">
    <div class="small muted">Level breakdown</div>
    ${entries.map(e=>{
      const l1 = e.levelScores?.[1] ?? 0;
      const l2 = e.levelScores?.[2] ?? 0;
      const l3 = e.levelScores?.[3] ?? 0;
      const l4 = e.levelScores?.[4] ?? 0;
      const l5 = e.levelScores?.[5] ?? 0;
      return `
        <div class="lbMini">
          <strong>${escapeHtml(e.name)}</strong>
          <div class="muted">Total: ${e.total}</div>
          <div class="chips">
            <span>L1 ${l1}</span><span>L2 ${l2}</span><span>L3 ${l3}</span><span>L4 ${l4}</span><span>L5 ${l5}</span>
          </div>
        </div>
      `;
    }).join("")}
  `;

  // Rematch button label
  const lv = roomState?.level ?? 1;
  const btn = $("rematchBtn");
  if(btn){
    if(lv < 5){
      btn.textContent = `Rematch to Level ${lv+1}`;
      btn.disabled = (roomState.hostId !== myUid);
    }else{
      btn.textContent = "All levels completed";
      btn.disabled = true;
    }
  }
}

/* =========================
   ✅ 17) Screen routing
   ========================= */
function renderByRoomStatus(){
  if(!roomState) return;

  if(roomState.status === "waiting"){
    showScreen("lobbyScreen");
  } else if(roomState.status === "playing"){
    showScreen("gameScreen");
  } else if(roomState.status === "level_finished"){
    showScreen("resultsScreen"); // show results between levels too
  } else if(roomState.status === "finished"){
    showScreen("resultsScreen");
  }

  setRoomCodeUI(roomState.roomCode || currentRoomCode);
  setLeftTopUI();
}

/* =========================
   ✅ 18) Listeners
   ========================= */
function stopListeners(){
  if(roomUnsub){ roomUnsub(); roomUnsub = null; }
  if(playersUnsub){ playersUnsub(); playersUnsub = null; }
}

function startListeners(code){
  stopListeners();
  currentRoomCode = code;
  const rRef = roomDocRef(code);
  const pRef = playersColRef(code);

  roomUnsub = onSnapshot(rRef, async (snap)=>{
    if(!snap.exists()) return;
    roomState = snap.data();

    // always show room code in UI
    setRoomCodeUI(roomState.roomCode || code);

    renderByRoomStatus();
    updateStartButton();

    // phase changes render
    if(roomState.status === "playing"){
      if(roomState.phase === "question"){
        await renderCurrentQuestion();
      }else if(roomState.phase === "reveal"){
        await renderReveal();

        // host auto-next after 5s reveal
        if(roomState.hostId === myUid){
          setTimeout(()=>hostScoreAndNext().catch(console.error), 5200);
        }
      }
    }else{
      if(roomState.status === "level_finished" || roomState.status === "finished"){
        renderResults();
      }
    }
  });

  playersUnsub = onSnapshot(pRef, (snap)=>{
    playersState = {};
    snap.forEach(d=> playersState[d.id] = d.data());
    renderPlayers();
    updateStartButton();

    // host: if both answered early, reveal early
    hostMaybeRevealEarly().catch(console.error);
  });
}

/* =========================
   ✅ 19) Host / Join flows
   ========================= */
async function ensureSignedIn(){
  return new Promise((resolve,reject)=>{
    const off = onAuthStateChanged(auth, async (user)=>{
      if(user){
        myUid = user.uid;
        off();
        resolve(user);
      }else{
        try{
          await signInAnonymously(auth);
        }catch(e){
          off();
          reject(e);
        }
      }
    });
  });
}

async function createRoom(){
  myName = ($("playerNameInput")?.value || "Host").trim() || "Host";
  const code = randRoomCode();

  // create room doc
  await setDoc(roomDocRef(code), {
    roomCode: code,
    hostId: myUid,
    status: "waiting",
    level: 1,
    createdAt: serverTimestamp(),
    usedQuestionIds: []
  });

  // create host player doc
  await setDoc(doc(db,"rooms",code,"players",myUid), {
    name: myName,
    joinedAt: serverTimestamp(),
    score: 0,
    totalScore: 0,
    levelScores: { 1:0,2:0,3:0,4:0,5:0 },
    answers: {}
  });

  startListeners(code);
  showScreen("lobbyScreen");
}

async function joinRoom(){
  myName = ($("playerNameInput")?.value || "Player").trim() || "Player";
  const code = ($("joinCodeInput")?.value || "").trim().toUpperCase();
  if(code.length !== 4){
    alert("Enter 4-letter room code");
    return;
  }

  const roomSnap = await getDoc(roomDocRef(code));
  if(!roomSnap.exists()){
    alert("Room not found");
    return;
  }

  // Check player count
  const pSnap = await getDocs(collection(db,"rooms",code,"players"));
  if(pSnap.size >= 2){
    alert("Room is full (2 players max)");
    return;
  }

  await setDoc(doc(db,"rooms",code,"players",myUid), {
    name: myName,
    joinedAt: serverTimestamp(),
    score: 0,
    totalScore: 0,
    levelScores: { 1:0,2:0,3:0,4:0,5:0 },
    answers: {}
  });

  startListeners(code);
  showScreen("lobbyScreen");
}

/* =========================
   ✅ 20) Start match (host)
   ========================= */
async function startMatch(){
  if(!roomState || roomState.hostId !== myUid) return;
  const allIds = await getAllQuestionIds();
  const picked = pickRandomUnique(allIds, 20, roomState.usedQuestionIds || []);

  // reset answers & per-level score for both
  const ids = Object.keys(playersState || {});
  for(const uid of ids){
    await updateDoc(doc(db,"rooms",currentRoomCode,"players",uid), {
      score: 0,
      answers: {}
    });
  }

  await updateDoc(roomDocRef(currentRoomCode), {
    status: "playing",
    level: 1,
    questionIds: picked,
    usedQuestionIds: picked,
    currentIndex: 0,
    phase: "question",
    questionStartedAt: serverTimestamp()
  });
}

/* =========================
   ✅ 21) Leave
   ========================= */
async function leaveMatch(){
  stopListeners();
  roomState = null;
  playersState = {};
  currentRoomCode = null;
  clearLocalTimer();
  showScreen("homeScreen");
}

/* =========================
   ✅ 22) Wire events
   ========================= */
function wireUI(){
  $("hostBtn")?.addEventListener("click", async ()=>{
    await ensureSignedIn();
    await createRoom();
  });

  $("joinBtn")?.addEventListener("click", async ()=>{
    await ensureSignedIn();
    await joinRoom();
  });

  $("startBtn")?.addEventListener("click", async ()=>{
    await startMatch();
  });

  $("leaveBtn")?.addEventListener("click", leaveMatch);

  $("copyCodeBtn")?.addEventListener("click", async ()=>{
    if(!currentRoomCode) return;
    try{
      await navigator.clipboard.writeText(currentRoomCode);
      alert("Room code copied!");
    }catch{
      alert("Copy failed. Room: "+currentRoomCode);
    }
  });

  // options click
  getOptionButtons().forEach((btn,i)=>{
    if(!btn) return;
    btn.addEventListener("click", ()=> submitAnswer(i));
  });

  $("rematchBtn")?.addEventListener("click", async ()=>{
    // host starts next level
    await hostStartNextLevel();
  });
}

/* =========================
   ✅ 23) Init
   ========================= */
(async function init(){
  wireUI();
  showScreen("homeScreen");

  // auto sign-in so we have UID (optional)
  try{
    await ensureSignedIn();
  }catch(e){
    console.error("Auth failed", e);
  }
})();
