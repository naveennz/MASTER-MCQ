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

// ─── Constants ────────────────────────────────────────────────────────────────
const AVATARS  = ["🎮","🚀","🦊","🐯","🦁","🐸","🤖","👽","🦄","🐉",
                  "🔥","⚡","🌊","🍀","💎","🎯","🏆","🎪","🎭","🦋"];
const TIMER_MS = 20_000;
const CACHE_KEY = "mmcq_player";

// ─── Player Cache (localStorage) ─────────────────────────────────────────────
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}
function updateCache(patch) {
  const cur = loadCache() || {};
  saveCache({ ...cur, ...patch });
}

// ─── Global State ─────────────────────────────────────────────────────────────
let uid, roomCode, roomRef;
let allQuestions = [];
let gameData     = null;
let playerCount  = 0;
let myAvatar     = "🎮";
let myName       = "";

// Per-question local state (never synced to Firestore until reveal)
let mySelection   = null;   // local answer choice
let hasAnswered   = false;
let revealLocked  = false;
let scoreWritten  = false;  // only write score ONCE per question on reveal
let lastTickSec   = -1;

// All selections from ALL players (populated on reveal from Firestore)
// Structure: { [uid]: { answerIndex, avatar, name } }
let allSelections = {};

// Question deduplication: track used question original-indices across rounds
let usedQuestionIds = new Set();  // stored by index in allQuestions array

// Timer
let timerRAF       = null;
let timerStart     = null;
let renderedQIndex = -1;

// Sound
let audioCtx = null;
let soundOn  = true;

// ─── Sound Engine ─────────────────────────────────────────────────────────────
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function tone(freq, type, dur, vol = 0.25, delay = 0) {
  if (!soundOn) return;
  try {
    const ctx  = getCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + dur);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + dur + 0.05);
  } catch(e) {}
}
const SFX = {
  click()   { tone(600,"sine",0.06,0.12); },
  correct() { tone(523,"sine",0.15,0.22,0); tone(659,"sine",0.15,0.22,0.08); tone(784,"sine",0.22,0.25,0.16); },
  wrong()   { tone(300,"sawtooth",0.12,0.18,0); tone(220,"sawtooth",0.15,0.18,0.10); },
  timeout() { tone(880,"square",0.05,0.15,0); tone(880,"square",0.05,0.15,0.12); },
  tick()    { tone(1200,"sine",0.04,0.07); },
  reveal()  { tone(440,"sine",0.08,0.1,0); tone(550,"sine",0.1,0.1,0.05); },
  start()   { tone(392,"sine",0.1,0.2,0); tone(523,"sine",0.1,0.2,0.10); tone(659,"sine",0.1,0.2,0.20); tone(784,"sine",0.2,0.25,0.30); },
  finish()  { tone(523,"sine",0.12,0.2,0); tone(659,"sine",0.12,0.2,0.12); tone(784,"sine",0.12,0.2,0.24); tone(1046,"sine",0.25,0.3,0.36); },
};

// ─── Parse Questions ──────────────────────────────────────────────────────────
function parseQuestions() {
  return RAW_MCQ_TEXT.split("---").filter(b => b.includes("**Answer:"))
    .map((block, idx) => {
      const lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean);
      const qLine = lines.find(l => l.startsWith("**") && !l.startsWith("**Answer"));
      const question = qLine ? qLine.replace(/^\*+/,"").replace(/\*+$/,"").replace(/^\d+\.\s*/,"").trim() : "";
      const options  = lines.filter(l => /^-\s*[A-D]\)/.test(l)).map(l => l.replace(/^-\s*[A-D]\)\s*/,"").trim());
      const ansLine  = lines.find(l => l.startsWith("**Answer:"));
      const ansLetter = ansLine ? ansLine.replace(/\*+/g,"").replace("Answer:","").trim().charAt(0).toUpperCase() : "A";
      return { id: idx, question, options, answerIndex: Math.max(0,["A","B","C","D"].indexOf(ansLetter)) };
    }).filter(q => q.question && q.options.length === 4);
}

// ─── Pick questions avoiding already-used ones ────────────────────────────────
function pickFreshQuestions(n) {
  const fresh = allQuestions.filter(q => !usedQuestionIds.has(q.id));
  // If not enough fresh questions left, reset and start over
  if (fresh.length < n) {
    usedQuestionIds.clear();
    return [...allQuestions].sort(() => Math.random() - 0.5).slice(0, n);
  }
  const picked = fresh.sort(() => Math.random() - 0.5).slice(0, n);
  picked.forEach(q => usedQuestionIds.add(q.id));
  return picked;
}

// ─── Auth Boot ────────────────────────────────────────────────────────────────
signInAnonymously(auth).then(res => {
  uid = res.user.uid;
  allQuestions = parseQuestions();
  restorePlayerCache();   // load saved name/avatar
  buildAvatarPicker();
  startLeaderboardLive();
});

// ─── Restore cache into UI ────────────────────────────────────────────────────
function restorePlayerCache() {
  const cache = loadCache();
  if (!cache) return;
  if (cache.name) {
    myName = cache.name;
    const inp = $("nameInput");
    if (inp) inp.value = cache.name;
    // Show welcome back badge
    const badge = $("cacheBadge");
    if (badge) {
      const best = cache.soloBest || cache.bestScore;
      badge.innerText = best ? `👋 Welcome back! Best: ${best} pts` : "👋 Welcome back!";
      badge.classList.add("show");
      setTimeout(() => badge.classList.remove("show"), 4000);
    }
  }
  if (cache.avatar && AVATARS.includes(cache.avatar)) {
    myAvatar = cache.avatar;
    const av = $("sidebarAvatar");
    if (av) av.innerText = cache.avatar;
  }
  // Restore usedQuestionIds so rounds never repeat across sessions
  if (cache.usedIds && Array.isArray(cache.usedIds)) {
    usedQuestionIds = new Set(cache.usedIds);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(id) {
  document.querySelectorAll("section").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}
function syncMobUI() {
  const av = $("mobAvatar"); if (av) av.innerText = myAvatar;
  const nm = $("mobPlayerName"); if (nm) nm.innerText = myName || "";
  const sc = $("mobScore"); if (sc) sc.innerText = $("totalScore")?.innerText || "0";
}
function renderRoomCode(code) {
  [...(code||"")].forEach((c,i) => { const el=$("m"+(i+1)); if(el) el.innerText=c; });
}
function makeOption(text, letter) {
  const div   = document.createElement("div");
  div.className = "opt";
  const badge = document.createElement("span"); badge.className="opt-letter"; badge.innerText=letter;
  const txt   = document.createElement("span"); txt.innerText=text;
  div.appendChild(badge); div.appendChild(txt);
  return div;
}

// ─── Sound toggle ─────────────────────────────────────────────────────────────
function setSoundState(on) {
  soundOn = on;
  const sb = $("soundBtn"); if (sb) { sb.innerText = on?"🔊":"🔇"; sb.classList.toggle("muted",!on); }
  const mb = $("mobSoundBtn"); if (mb) mb.innerText = on?"🔊":"🔇";
}
const soundBtn = $("soundBtn");
if (soundBtn) soundBtn.onclick = () => setSoundState(!soundOn);
const mobSoundBtn = $("mobSoundBtn");
if (mobSoundBtn) mobSoundBtn.onclick = () => setSoundState(!soundOn);

// ─── Avatar Picker ────────────────────────────────────────────────────────────
function buildAvatarPicker() {
  const grid = $("avatarGrid"); if (!grid) return;
  grid.innerHTML = "";
  AVATARS.forEach(emoji => {
    const btn = document.createElement("button");
    btn.className = "av-btn" + (emoji===myAvatar?" av-selected":"");
    btn.innerText = emoji;
    btn.onclick = () => {
      SFX.click();
      myAvatar = emoji;
      const av = $("sidebarAvatar"); if (av) av.innerText = emoji;
      document.querySelectorAll(".av-btn").forEach(b => b.classList.toggle("av-selected", b.innerText===emoji));
      updateCache({ avatar: emoji });
    };
    grid.appendChild(btn);
  });
}

// ─── Global Leaderboard ───────────────────────────────────────────────────────
function startLeaderboardLive() {
  const q = query(collection(db,"leaderboard"), orderBy("score","desc"), limit(20));
  onSnapshot(q, snap => {
    const list = $("lbList"); if (!list) return;
    list.innerHTML = "";
    const mobLb = $("mobLbList");
    if (snap.empty) {
      list.innerHTML='<div class="lb-empty">No scores yet.<br>Be the first!</div>';
      if(mobLb) mobLb.innerHTML='<div class="lb-empty">No scores yet.<br>Be the first!</div>';
      return;
    }
    const medals=["🥇","🥈","🥉"]; let rank=0;
    if(mobLb) mobLb.innerHTML="";
    snap.forEach(d => {
      const p=d.data();
      const row=document.createElement("div");
      row.className="lb-row"+(d.id===uid?" lb-me":"");
      row.innerHTML=`<span class="lb-rank">${medals[rank]||(rank+1)}</span><span class="lb-av">${p.avatar||"🎮"}</span><span class="lb-name">${p.name}</span><span class="lb-score">${p.score}</span>`;
      list.appendChild(row);
      if(mobLb) { const r2=row.cloneNode(true); mobLb.appendChild(r2); }
      rank++;
    });
  });
}

async function pushToLeaderboard(name, avatar, score) {
  if (!uid||!name) return;
  const ref  = doc(db,"leaderboard",uid);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().score < score) {
    await setDoc(ref, { name, avatar:avatar||"🎮", score, updatedAt:serverTimestamp() });
  }
}

// ─── Sidebar Tabs removed — players + leaderboard now stacked ─────────────────

// ─── Name input: auto-save ────────────────────────────────────────────────────
const nameInput = $("nameInput");
if (nameInput) nameInput.addEventListener("input", () => {
  updateCache({ name: nameInput.value.trim() });
});

// ─── Host ─────────────────────────────────────────────────────────────────────
$("hostBtn").onclick = async () => {
  const name = $("nameInput").value.trim();
  if (!name) return alert("Enter your name first!");
  myName   = name;
  roomCode = Math.random().toString(36).substring(2,6).toUpperCase();
  roomRef  = doc(db,"rooms",roomCode);
  usedQuestionIds.clear(); // fresh series = reset used list

  const questions = pickFreshQuestions(20);
  await setDoc(roomRef, {
    status:"waiting", host:uid, round:1, currentQuestion:0,
    questions, answersCount:0, showAnswer:false,
    answers:{},           // { uid: answerIndex } — written on reveal
    usedIds: [...usedQuestionIds]
  });
  await setDoc(doc(roomRef,"players",uid), {
    name, avatar:myAvatar, score:0, roundScores:[0,0,0,0,0], gamesPlayed:0
  });
  updateCache({ name, avatar:myAvatar, usedIds:[...usedQuestionIds] });
  startLobby(name);
};

// ─── Join ─────────────────────────────────────────────────────────────────────
$("joinBtn").onclick = async () => {
  const code = $("roomInput").value.trim().toUpperCase();
  const name = $("nameInput").value.trim();
  if (!name) return alert("Enter your name first!");
  if (code.length!==4) return alert("Enter a valid 4-letter room code!");
  myName  = name;
  roomRef = doc(db,"rooms",code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Room not found!");
  roomCode = code;
  await setDoc(doc(roomRef,"players",uid), {
    name, avatar:myAvatar, score:0, roundScores:[0,0,0,0,0], gamesPlayed:0
  });
  updateCache({ name, avatar:myAvatar });
  startLobby(name);
};

// ─── Lobby ────────────────────────────────────────────────────────────────────
function startLobby(name) {
  $("playerName").innerText    = name;
  $("sidebarAvatar").innerText = myAvatar;
  $("roomLabel").innerText     = "ROOM " + roomCode;
  renderRoomCode(roomCode);
  const display = $("copyCodeDisplay"); if (display) display.innerText = roomCode||"----";
  show("lobbyScreen");
  syncMobUI();
  subscribeToRoom();
  subscribeToPlayers();
  setupCopyBtn();
}

function setupCopyBtn() {
  const btn = $("copyCodeBtn"); if (!btn) return;
  btn.onclick = () => {
    SFX.click();
    const done = () => {
      btn.classList.add("copied"); $("copyLabel").innerText="Copied!";
      setTimeout(()=>{ btn.classList.remove("copied"); $("copyLabel").innerText="Copy Code"; },2000);
    };
    navigator.clipboard.writeText(roomCode||"").then(done).catch(()=>{
      const el=document.createElement("textarea"); el.value=roomCode;
      document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el); done();
    });
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
      if (isHost) { $("startBtn").classList.remove("hidden"); $("lobbyStatus").innerText="You are the host."; }
      else        { $("startBtn").classList.add("hidden");    $("lobbyStatus").innerText="Waiting for host..."; }

    } else if (gameData.status === "playing") {
      show("gameScreen");
      const qIdx = gameData.currentQuestion;

      if (qIdx !== renderedQIndex) {
        // ── New question ────────────────────────────────────────────────────
        renderedQIndex = qIdx;
        mySelection    = null;
        hasAnswered    = false;
        revealLocked   = false;
        scoreWritten   = false;
        allSelections  = {};
        renderQuestion();
        if (!gameData.showAnswer) { SFX.reveal(); startTimer(); }

      } else if (gameData.showAnswer && prev && !prev.showAnswer) {
        // ── Reveal just triggered ───────────────────────────────────────────
        stopTimer();
        // Collect all answers from Firestore into allSelections
        allSelections = gameData.answers || {};
        revealQuestion();
        writeScoreOnReveal(); // score written HERE, not on click
        showAnswerToast();

      } else if (gameData.showAnswer && !prev?.showAnswer) {
        // edge case guard
      }

      // Host: all answered → reveal
      if (isHost && !gameData.showAnswer && gameData.answersCount >= playerCount && playerCount>0) doReveal();

    } else if (gameData.status === "roundEnd") {
      stopTimer();
      showRoundWinner();

    } else if (gameData.status === "seriesEnd") {
      stopTimer(); showSeriesWinner();
    }
  });
}

// ─── Players Subscription ─────────────────────────────────────────────────────
function subscribeToPlayers() {
  onSnapshot(collection(roomRef,"players"), snap => {
    playerCount = snap.size;
    const players = [];
    snap.forEach(d => players.push({ id:d.id, ...d.data() }));
    players.sort((a,b) => b.score-a.score);

    const list = $("playersList"); list.innerHTML="";
    const mobList = $("mobPlayersList"); if(mobList) mobList.innerHTML="";
    players.forEach(p => {
      const row=document.createElement("div");
      row.className="player-row"+(p.id===uid?" me":"");
      row.innerHTML=`<span class="pr-av">${p.avatar||"🎮"}</span><span class="pr-name">${p.name}</span><span class="pts">${p.score}</span>`;
      list.appendChild(row);
      if(mobList) { const r2=row.cloneNode(true); mobList.appendChild(r2); }
      if (p.id===uid) {
        $("totalScore").innerText=p.score;
        $("sidebarAvatar").innerText=p.avatar||myAvatar;
        const ms=$("mobScore"); if(ms) ms.innerText=p.score;
        const ma=$("mobAvatar"); if(ma) ma.innerText=p.avatar||myAvatar;
      }
    });

    const isHost = gameData && gameData.host===uid;
    $("startBtn").disabled = !(isHost && snap.size>=2);
    if (gameData && isHost && gameData.status==="playing" && !gameData.showAnswer && gameData.answersCount>=playerCount && playerCount>0) doReveal();
  });
}

// ─── Render Question (no answers shown) ──────────────────────────────────────
function renderQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];
  $("roundIndicator").innerText = `ROUND ${gameData.round}  ·  Q ${gameData.currentQuestion+1}/20`;
  $("qTag").innerText           = `Question ${gameData.currentQuestion+1} of 20`;
  $("questionText").innerText   = q.question;
  const container=$("options"); container.innerHTML="";
  q.options.forEach((opt,i) => {
    const div = makeOption(opt, letters[i]);
    if (hasAnswered && i===mySelection) div.classList.add("marked");
    if (hasAnswered) div.dataset.locked="true";
    if (!hasAnswered) div.onclick = () => handleAnswer(i);
    container.appendChild(div);
  });
}

// ─── Reveal Question — show correct/wrong + ALL players' choices ──────────────
function revealQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];
  const container = $("options"); container.innerHTML="";

  // Build a map: optionIndex → list of {avatar, name} who chose it
  const choiceMap = {}; // { 0:[...], 1:[...], 2:[...], 3:[...] }
  for (const [pid, sel] of Object.entries(allSelections)) {
    const idx = sel.answerIndex;
    if (idx === undefined || idx === null || idx === -1) continue;
    if (!choiceMap[idx]) choiceMap[idx] = [];
    choiceMap[idx].push({ avatar: sel.avatar||"🎮", name: sel.name, isMe: pid===uid });
  }

  q.options.forEach((opt,i) => {
    const div = makeOption(opt, letters[i]);
    div.dataset.locked = "true";
    div.style.position = "relative";

    if (i===q.answerIndex)    div.classList.add("correct");
    else if (i===mySelection) div.classList.add("wrong");
    else                      div.classList.add("dimmed");

    // Player avatar badges on this option
    if (choiceMap[i] && choiceMap[i].length>0) {
      const badges = document.createElement("div");
      badges.className = "choice-badges";
      choiceMap[i].forEach(p => {
        const b = document.createElement("span");
        b.className = "choice-badge"+(p.isMe?" choice-me":"");
        b.title = p.name;
        b.innerText = p.avatar;
        badges.appendChild(b);
      });
      div.appendChild(badges);
    }

    container.appendChild(div);
  });
}

// ─── Handle Answer Click — only records locally + sends to Firestore ──────────
// Score is NOT written here — it's written on reveal
async function handleAnswer(idx) {
  if (hasAnswered || gameData.showAnswer) return;
  hasAnswered = true;
  mySelection = idx;
  SFX.click();
  renderQuestion(); // show "marked" state locally

  // Write this player's answer choice to room doc (visible to all on reveal)
  // We store it nested under answers.{uid}
  const pSnap = await getDoc(doc(roomRef,"players",uid));
  const pData = pSnap.exists() ? pSnap.data() : {};
  const answerPayload = {
    [`answers.${uid}`]: {
      answerIndex: idx,
      avatar: myAvatar,
      name: myName || pData.name || "Player"
    }
  };
  await updateDoc(roomRef, { ...answerPayload, answersCount: increment(1) });
}

// ─── Write score on reveal (not on answer click) ──────────────────────────────
async function writeScoreOnReveal() {
  if (scoreWritten || !hasAnswered || mySelection === null) return;
  scoreWritten = true;
  const q = gameData.questions[gameData.currentQuestion];
  if (mySelection === q.answerIndex) {
    const pRef = doc(roomRef,"players",uid);
    await runTransaction(db, async t => {
      const snap  = await t.get(pRef);
      const p     = snap.data();
      const rounds = [...(p.roundScores||[0,0,0,0,0])];
      rounds[gameData.round-1] = (rounds[gameData.round-1]||0)+10;
      t.update(pRef, { score:increment(10), roundScores:rounds });
    });
    // Update leaderboard immediately (best-score logic inside pushToLeaderboard)
    const pSnap = await getDoc(doc(roomRef,"players",uid));
    if (pSnap.exists()) {
      const p = pSnap.data();
      pushToLeaderboard(p.name, p.avatar, p.score+10);
    }
  }
}

// ─── Host: Trigger Reveal ─────────────────────────────────────────────────────
async function doReveal() {
  if (revealLocked||!gameData||gameData.showAnswer) return;
  revealLocked = true;
  await updateDoc(roomRef, { showAnswer:true });
  setTimeout(async () => {
    if (!gameData) return;
    const nextQ = gameData.currentQuestion+1;
    if (nextQ < 20) {
      await updateDoc(roomRef, {
        currentQuestion:nextQ, showAnswer:false, answersCount:0, answers:{}
      });
    } else {
      // Save used IDs in room doc so joiner can sync
      const newUsed = [...usedQuestionIds];
      const isOver = gameData.round+1 > 5;
      await updateDoc(roomRef, {
        status: isOver ? "seriesEnd" : "roundEnd",
        usedIds: newUsed
      });
      updateCache({ usedIds: newUsed });
    }
  }, 5000); // 5s to view answers
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  timerStart=performance.now(); lastTickSec=20;
  const bar=$("timerBar"), txt=$("timerText");
  function tick(now) {
    const elapsed=now-timerStart, remaining=Math.max(0,TIMER_MS-elapsed);
    const pct=remaining/TIMER_MS, secs=Math.ceil(remaining/1000);
    bar.style.width=pct*100+"%"; bar.classList.toggle("low",pct<0.3);
    if (txt) txt.innerText=secs;
    if (secs<=6 && secs!==lastTickSec) { lastTickSec=secs; SFX.tick(); }
    if (remaining>0) { timerRAF=requestAnimationFrame(tick); }
    else if (gameData&&gameData.host===uid&&!gameData.showAnswer) doReveal();
  }
  timerRAF=requestAnimationFrame(tick);
}
function stopTimer() {
  if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF=null; }
  const bar=$("timerBar"), txt=$("timerText");
  if (bar) { bar.style.width="0%"; bar.classList.remove("low"); }
  if (txt) txt.innerText="0";
}

// ─── Answer Toast ─────────────────────────────────────────────────────────────
function showAnswerToast() {
  const toast=$("answerToast"); if(!toast) return;
  const q=gameData.questions[gameData.currentQuestion];
  toast.className="";
  if (!hasAnswered)               { toast.innerText="⏱  Time's up!";    toast.className="timeout-toast show"; SFX.timeout(); }
  else if (mySelection===q.answerIndex) { toast.innerText="✓  Correct  +10"; toast.className="correct-toast show"; SFX.correct(); }
  else                            { toast.innerText="✗  Wrong answer";  toast.className="wrong-toast show";    SFX.wrong(); }
  setTimeout(()=>toast.classList.remove("show"), 4000);
}

// ─── Round Winner Screen ──────────────────────────────────────────────────────
function showRoundWinner() {
  show("roundWinnerScreen");
  const isHost = gameData && gameData.host===uid;

  onSnapshot(collection(roomRef,"players"), snap => {
    const players=[];
    snap.forEach(d => players.push({ id:d.id, ...d.data() }));
    players.sort((a,b)=>b.score-a.score);

    const rw=$("roundWinnerContent"); if(!rw) return;
    const round=gameData?gameData.round:1;
    const medals=["🥇","🥈","🥉"];

    let html=`<div class="rw-title">Round ${round} Complete!</div><div class="rw-podium">`;
    players.forEach((p,i) => {
      html+=`<div class="rw-player ${p.id===uid?"rw-me":""}">
        <div class="rw-medal">${medals[i]||""}</div>
        <div class="rw-av">${p.avatar||"🎮"}</div>
        <div class="rw-name">${p.name}</div>
        <div class="rw-score">${p.score} pts</div>
      </div>`;
    });
    html+=`</div>`;
    rw.innerHTML=html;
  });

  // Show/hide next round button
  $("nextLevelBtn").classList.toggle("hidden", !isHost);
  // Everyone sees a "ready" indicator — host controls proceed
  $("rwWaiting").classList.toggle("hidden", isHost);
}

// ─── Series Winner ────────────────────────────────────────────────────────────
function showSeriesWinner() {
  SFX.finish(); show("seriesWinnerScreen");
  onSnapshot(collection(roomRef,"players"), snap => {
    const players=[];
    snap.forEach(d => players.push({ id:d.id, ...d.data() }));
    players.sort((a,b)=>b.score-a.score);
    let html=`<table><tr><th></th><th>Player</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th><th>Total</th></tr>`;
    players.forEach((p,rank)=>{
      const medal=["🥇","🥈","🥉"][rank]||"";
      html+=`<tr class="${p.id===uid?"my-row":""}">
        <td>${p.avatar||"🎮"}</td>
        <td style="text-align:left;font-weight:700">${medal} ${p.name}</td>
        <td>${p.roundScores?.[0]||0}</td><td>${p.roundScores?.[1]||0}</td>
        <td>${p.roundScores?.[2]||0}</td><td>${p.roundScores?.[3]||0}</td><td>${p.roundScores?.[4]||0}</td>
        <td><strong>${p.score}</strong></td></tr>`;
      pushToLeaderboard(p.name, p.avatar, p.score);
      // Update cache for this user's best score
      if (p.id===uid) {
        const cache=loadCache()||{};
        if (!cache.bestScore || p.score > cache.bestScore) {
          updateCache({ bestScore:p.score, name:p.name, avatar:p.avatar });
        }
      }
    });
    $("seriesStats").innerHTML=html+"</table>";
  });
}

// ─── Buttons ──────────────────────────────────────────────────────────────────
$("startBtn").onclick = () => {
  if (!gameData||gameData.host!==uid) return;
  SFX.start(); updateDoc(roomRef,{status:"playing"});
};

$("nextLevelBtn").onclick = async () => {
  if (!gameData||gameData.host!==uid) return;
  SFX.start();
  // Sync usedIds from room before picking next round's questions
  if (gameData.usedIds) usedQuestionIds = new Set(gameData.usedIds);
  const questions = pickFreshQuestions(20);
  await updateDoc(roomRef, {
    round:gameData.round+1, currentQuestion:0, status:"playing",
    questions, answersCount:0, showAnswer:false, answers:{},
    usedIds:[...usedQuestionIds]
  });
  updateCache({ usedIds:[...usedQuestionIds] });
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SOLO MODE ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Solo state
let soloQuestions  = [];
let soloIndex      = 0;
let soloScore      = 0;
let soloCorrect    = 0;
let soloStreak     = 0;
let soloBestStreak = 0;
let soloAnswered   = false;
let soloTimerRAF   = null;
let soloTimerStart = null;
let soloLastTick   = -1;
const SOLO_TIMER_MS = 20_000;

// ─── Start Solo ───────────────────────────────────────────────────────────────
$("soloBtn").onclick = () => {
  const name = $("nameInput").value.trim();
  if (!name) return alert("Enter your name first!");
  myName = name;
  updateCache({ name, avatar: myAvatar });
  $("playerName").innerText    = name;
  $("sidebarAvatar").innerText = myAvatar;
  startSoloGame();
};

function startSoloGame() {
  // Pick 20 fresh questions (respects dedup)
  soloQuestions  = pickFreshQuestions(20);
  soloIndex      = 0;
  soloScore      = 0;
  soloCorrect    = 0;
  soloStreak     = 0;
  soloBestStreak = 0;
  soloAnswered   = false;

  // Persist used IDs
  updateCache({ usedIds: [...usedQuestionIds] });

  show("soloScreen");
  renderSoloQuestion();
}

// ─── Render Solo Question ─────────────────────────────────────────────────────
function renderSoloQuestion() {
  const q       = soloQuestions[soloIndex];
  const letters = ["A","B","C","D"];
  soloAnswered  = false;

  $("soloRoundIndicator").innerText = `SOLO  ·  Q ${soloIndex + 1}/20`;
  $("soloQTag").innerText           = `Question ${soloIndex + 1} of 20`;
  $("soloQuestion").innerText       = q.question;
  $("soloScoreVal").innerText       = soloScore;
  $("soloStreakVal").innerText       = soloStreak > 1 ? `🔥 ${soloStreak}` : soloStreak;

  const container = $("soloOptions");
  container.innerHTML = "";

  q.options.forEach((opt, i) => {
    const div = makeOption(opt, letters[i]);
    div.onclick = () => handleSoloAnswer(i);
    container.appendChild(div);
  });

  // Hide feedback
  const fb = $("soloFeedback");
  fb.className = "solo-feedback hidden";
  fb.innerText = "";

  $("soloNextBtn").classList.add("hidden");

  startSoloTimer();
  SFX.reveal();
}

// ─── Solo Timer ───────────────────────────────────────────────────────────────
function startSoloTimer() {
  stopSoloTimer();
  soloTimerStart = performance.now();
  soloLastTick   = 20;
  const bar = $("soloTimerBar");
  const txt = $("soloTimerText");

  function tick(now) {
    const elapsed   = now - soloTimerStart;
    const remaining = Math.max(0, SOLO_TIMER_MS - elapsed);
    const pct       = remaining / SOLO_TIMER_MS;
    const secs      = Math.ceil(remaining / 1000);

    bar.style.width = pct * 100 + "%";
    bar.classList.toggle("low", pct < 0.3);
    if (txt) txt.innerText = secs;
    if (secs <= 6 && secs !== soloLastTick) { soloLastTick = secs; SFX.tick(); }

    if (remaining > 0) {
      soloTimerRAF = requestAnimationFrame(tick);
    } else {
      handleSoloTimeout();
    }
  }
  soloTimerRAF = requestAnimationFrame(tick);
}

function stopSoloTimer() {
  if (soloTimerRAF) { cancelAnimationFrame(soloTimerRAF); soloTimerRAF = null; }
  const bar = $("soloTimerBar");
  const txt = $("soloTimerText");
  if (bar) { bar.style.width = "0%"; bar.classList.remove("low"); }
  if (txt) txt.innerText = "0";
}

// ─── Solo Answer ──────────────────────────────────────────────────────────────
function handleSoloAnswer(idx) {
  if (soloAnswered) return;
  soloAnswered = true;
  stopSoloTimer();
  SFX.click();

  const q       = soloQuestions[soloIndex];
  const letters = ["A","B","C","D"];
  const correct = idx === q.answerIndex;

  // Style all options
  const opts = $("soloOptions").querySelectorAll(".opt");
  opts.forEach((div, i) => {
    div.dataset.locked = "true";
    if (i === q.answerIndex) div.classList.add("correct");
    else if (i === idx)      div.classList.add("wrong");
    else                     div.classList.add("dimmed");
  });

  // Score & streak
  if (correct) {
    const bonus  = soloStreak >= 2 ? 5 : 0;   // streak bonus
    const points = 10 + bonus;
    soloScore   += points;
    soloCorrect++;
    soloStreak++;
    soloBestStreak = Math.max(soloBestStreak, soloStreak);
    $("soloScoreVal").innerText = soloScore;
    $("soloStreakVal").innerText = soloStreak > 1 ? `🔥 ${soloStreak}` : soloStreak;

    const fb = $("soloFeedback");
    fb.className = "solo-feedback solo-correct";
    fb.innerText = bonus > 0 ? `✓ Correct! +${points} (🔥 Streak bonus +${bonus})` : `✓ Correct! +10`;
    SFX.correct();
  } else {
    soloStreak = 0;
    $("soloStreakVal").innerText = "0";
    const fb = $("soloFeedback");
    fb.className = "solo-feedback solo-wrong";
    fb.innerText = `✗ Wrong! Answer: ${letters[q.answerIndex]}) ${q.options[q.answerIndex]}`;
    SFX.wrong();
  }

  $("soloNextBtn").classList.remove("hidden");
}

function handleSoloTimeout() {
  if (soloAnswered) return;
  soloAnswered = true;
  soloStreak   = 0;
  $("soloStreakVal").innerText = "0";

  const q       = soloQuestions[soloIndex];
  const letters = ["A","B","C","D"];

  const opts = $("soloOptions").querySelectorAll(".opt");
  opts.forEach((div, i) => {
    div.dataset.locked = "true";
    if (i === q.answerIndex) div.classList.add("correct");
    else                     div.classList.add("dimmed");
  });

  const fb = $("soloFeedback");
  fb.className = "solo-feedback solo-timeout";
  fb.innerText = `⏱ Time's up! Answer: ${letters[q.answerIndex]}) ${q.options[q.answerIndex]}`;
  SFX.timeout();

  $("soloNextBtn").classList.remove("hidden");
}

// ─── Next / Finish ────────────────────────────────────────────────────────────
$("soloNextBtn").onclick = () => {
  SFX.click();
  soloIndex++;
  if (soloIndex < soloQuestions.length) {
    renderSoloQuestion();
  } else {
    showSoloResult();
  }
};

// ─── Solo Result ──────────────────────────────────────────────────────────────
function showSoloResult() {
  SFX.finish();
  stopSoloTimer();
  show("soloResultScreen");

  const total    = soloQuestions.length;
  const wrong    = total - soloCorrect;
  const pct      = Math.round((soloCorrect / total) * 100);
  const grade    = pct >= 90 ? "🏆 Excellent!" : pct >= 70 ? "🎯 Great job!" : pct >= 50 ? "👍 Not bad!" : "📚 Keep practicing!";

  $("srGrade").innerText     = grade;
  $("srScore").innerText     = soloScore;
  $("srCorrect").innerText   = soloCorrect;
  $("srWrong").innerText     = wrong;
  $("srStreak").innerText    = soloBestStreak;
  $("srPercent").innerText   = pct + "%";

  // Check personal best
  const cache = loadCache() || {};
  let isNewBest = false;
  if (!cache.soloBest || soloScore > cache.soloBest) {
    updateCache({ soloBest: soloScore });
    isNewBest = true;
  }
  const pbEl = $("srPB");
  if (pbEl) {
    pbEl.innerText = isNewBest ? "🎉 New Personal Best!" : `Personal best: ${cache.soloBest || soloScore}`;
    pbEl.className = isNewBest ? "sr-pb new-pb" : "sr-pb";
  }

  // Push to global leaderboard
  pushToLeaderboard(myName, myAvatar, soloScore);
}

$("soloPlayAgainBtn").onclick = () => {
  SFX.click();
  startSoloGame();
};

$("soloHomeBtn").onclick = () => {
  SFX.click();
  stopSoloTimer();
  show("homeScreen");
};

$("srPlayAgainBtn").onclick = () => {
  SFX.click();
  startSoloGame();
};

$("srHomeBtn").onclick = () => {
  SFX.click();
  show("homeScreen");
};
