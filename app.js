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
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const auth = getAuth(app);

// ─── Avatars ──────────────────────────────────────────────────────────────────
const AVATARS = ["🎮","🚀","🦊","🐯","🦁","🐸","🤖","👽","🦄","🐉",
                 "🔥","⚡","🌊","🍀","💎","🎯","🏆","🎪","🎭","🦋"];

// ─── Web Audio Sound Engine ───────────────────────────────────────────────────
let audioCtx = null;
let soundOn  = true;

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
  streak()  { tone(880,"sine",0.08,0.2,0); tone(1109,"sine",0.1,0.2,0.08); }
};

// ─── Global State ─────────────────────────────────────────────────────────────
let uid, roomCode, roomRef;
let allQuestions = [];
let gameData     = null;
let playerCount  = 0;
let myAvatar     = "🎮";
let myName       = "";

// Multiplayer per-question state (local only)
let mySelection   = null;
let hasAnswered   = false;
let revealLocked  = false;
let lastTickSec   = -1;

// Shared timer
let timerRAF   = null;
let timerStart = null;
const TIMER_MS = 20_000;
let renderedQIndex = -1;

// Solo state
let soloQuestions  = [];
let soloIndex      = 0;
let soloScore      = 0;
let soloCorrect    = 0;
let soloWrong      = 0;
let soloStreak     = 0;
let soloBestStreak = 0;
let soloAnswered   = false;
let soloTimerRAF   = null;
let soloTimerStart = null;
let soloLastTick   = -1;

// ─── Parse Questions ──────────────────────────────────────────────────────────
function parseQuestions() {
  return RAW_MCQ_TEXT.split("---").filter(b => b.includes("**Answer:"))
    .map(block => {
      const lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean);
      const qLine = lines.find(l => l.startsWith("**") && !l.startsWith("**Answer"));
      const question = qLine ? qLine.replace(/^\*+/,"").replace(/\*+$/,"").replace(/^\d+\.\s*/,"").trim() : "";
      const options  = lines.filter(l => /^-\s*[A-D]\)/.test(l)).map(l => l.replace(/^-\s*[A-D]\)\s*/,"").trim());
      const ansLine  = lines.find(l => l.startsWith("**Answer:"));
      const ansLetter = ansLine ? ansLine.replace(/\*+/g,"").replace("Answer:","").trim().charAt(0).toUpperCase() : "A";
      return { question, options, answerIndex: Math.max(0, ["A","B","C","D"].indexOf(ansLetter)) };
    }).filter(q => q.question && q.options.length === 4);
}

// ─── Auth Boot ────────────────────────────────────────────────────────────────
signInAnonymously(auth).then(res => {
  uid = res.user.uid;
  allQuestions = parseQuestions();
  buildAvatarPicker();
  startLeaderboardLive();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(id) {
  document.querySelectorAll("section").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}
function renderRoomCode(code) {
  [...(code||"")].forEach((c,i) => { const el=$("m"+(i+1)); if(el) el.innerText=c; });
}
function pickQuestions(n) {
  return [...allQuestions].sort(()=>Math.random()-0.5).slice(0,n);
}
function makeOption(text, letter) {
  const div   = document.createElement("div");
  div.className = "opt";
  const badge = document.createElement("span");
  badge.className = "opt-letter"; badge.innerText = letter;
  const txt = document.createElement("span"); txt.innerText = text;
  div.appendChild(badge); div.appendChild(txt);
  return div;
}

// ─── Sound Toggle ─────────────────────────────────────────────────────────────
$("soundBtn").onclick = () => {
  soundOn = !soundOn;
  $("soundBtn").innerText = soundOn ? "🔊" : "🔇";
  $("soundBtn").classList.toggle("muted", !soundOn);
  SFX.click();
};

// ─── Avatar Picker ────────────────────────────────────────────────────────────
function buildAvatarPicker() {
  const grid = $("avatarGrid"); if (!grid) return;
  AVATARS.forEach(emoji => {
    const btn = document.createElement("button");
    btn.className = "av-btn" + (emoji===myAvatar?" av-selected":"");
    btn.innerText = emoji;
    btn.onclick = () => {
      SFX.click();
      myAvatar = emoji;
      $("sidebarAvatar").innerText = emoji;
      document.querySelectorAll(".av-btn").forEach(b => b.classList.toggle("av-selected", b.innerText===emoji));
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
    if (snap.empty) { list.innerHTML = '<div class="lb-empty">No scores yet.<br>Be the first!</div>'; return; }
    const medals = ["🥇","🥈","🥉"];
    let rank = 0;
    snap.forEach(d => {
      const p = d.data();
      const row = document.createElement("div");
      row.className = "lb-row"+(d.id===uid?" lb-me":"");
      row.innerHTML = `
        <span class="lb-rank">${medals[rank]||(rank+1)}</span>
        <span class="lb-av">${p.avatar||"🎮"}</span>
        <span class="lb-name">${p.name}</span>
        ${p.mode==="solo"?'<span class="lb-tag">SOLO</span>':""}
        <span class="lb-score">${p.score}</span>`;
      list.appendChild(row); rank++;
    });
  });
}

async function pushToLeaderboard(name, avatar, score, mode="multi") {
  if (!uid||!name) return;
  const ref = doc(db,"leaderboard",uid);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().score < score) {
    await setDoc(ref, { name, avatar:avatar||"🎮", score, mode, updatedAt:serverTimestamp() });
  }
}

// ─── Sidebar Tabs ─────────────────────────────────────────────────────────────
$("tabPlayers").onclick     = () => switchTab("players");
$("tabLeaderboard").onclick = () => { switchTab("leaderboard"); SFX.click(); };
function switchTab(tab) {
  $("tabPlayers").classList.toggle("tab-active", tab==="players");
  $("tabLeaderboard").classList.toggle("tab-active", tab==="leaderboard");
  $("panelPlayers").classList.toggle("hidden", tab!=="players");
  $("panelLeaderboard").classList.toggle("hidden", tab!=="leaderboard");
}

// ═════════════════════════════════════════════════════════════
//  SOLO MODE
// ═════════════════════════════════════════════════════════════

$("soloBtn").onclick = () => {
  const name = $("nameInput").value.trim();
  if (!name) { $("nameInput").focus(); return; }
  myName = name;
  $("playerName").innerText    = name;
  $("sidebarAvatar").innerText = myAvatar;
  SFX.start();
  startSolo();
};

function startSolo() {
  soloQuestions = pickQuestions(20);
  soloIndex = soloScore = soloCorrect = soloWrong = soloStreak = soloBestStreak = 0;
  soloAnswered = false;
  show("soloScreen");
  renderSoloQ();
}

function renderSoloQ() {
  const q = soloQuestions[soloIndex];
  const letters = ["A","B","C","D"];
  $("soloIndicator").innerText    = "SOLO · Q "+(soloIndex+1)+"/20";
  $("soloQTag").innerText         = "Question "+(soloIndex+1)+" of 20";
  $("soloQuestionText").innerText = q.question;
  $("soloScoreVal").innerText     = soloScore;
  $("soloCorrectVal").innerText   = soloCorrect;
  $("soloStreakVal").innerText     = soloStreak+(soloStreak>=3?"🔥":"");
  soloAnswered = false;

  const container = $("soloOptions");
  container.innerHTML = "";
  q.options.forEach((opt, i) => {
    const div = makeOption(opt, letters[i]);
    div.onclick = () => handleSoloAnswer(i);
    container.appendChild(div);
  });
  startSoloTimer();
}

function handleSoloAnswer(idx) {
  if (soloAnswered) return;
  soloAnswered = true;
  stopSoloTimer();
  SFX.click();

  const q = soloQuestions[soloIndex];
  const correct = idx === q.answerIndex;

  if (correct) {
    soloScore += 10; soloCorrect++;
    soloStreak++;
    if (soloStreak > soloBestStreak) soloBestStreak = soloStreak;
    setTimeout(()=>SFX.correct(), 50);
    if (soloStreak >= 3) setTimeout(()=>SFX.streak(), 380);
  } else {
    soloWrong++; soloStreak = 0;
    setTimeout(()=>SFX.wrong(), 50);
  }

  // Reveal
  const opts = $("soloOptions").children;
  for (let i = 0; i < opts.length; i++) {
    opts[i].dataset.locked = "true";
    if (i === q.answerIndex) opts[i].classList.add("correct");
    else if (i === idx)      opts[i].classList.add("wrong");
    else                     opts[i].classList.add("dimmed");
  }
  $("soloScoreVal").innerText   = soloScore;
  $("soloCorrectVal").innerText = soloCorrect;
  $("soloStreakVal").innerText   = soloStreak+(soloStreak>=3?"🔥":"");

  showSoloToast(correct?"correct":"wrong");
  setTimeout(() => { soloIndex++; soloIndex < 20 ? renderSoloQ() : endSolo(); }, correct?1400:1800);
}

function startSoloTimer() {
  stopSoloTimer();
  soloTimerStart = performance.now();
  soloLastTick   = 20;
  const bar = $("soloTimerBar");
  const txt = $("soloTimerText");

  function tick(now) {
    const elapsed   = now - soloTimerStart;
    const remaining = Math.max(0, TIMER_MS - elapsed);
    const pct       = remaining / TIMER_MS;
    const secs      = Math.ceil(remaining / 1000);
    bar.style.width = pct*100+"%";
    bar.classList.toggle("low", pct<0.3);
    if (txt) txt.innerText = secs;
    if (secs <= 6 && secs !== soloLastTick) { soloLastTick = secs; SFX.tick(); }

    if (remaining > 0) {
      soloTimerRAF = requestAnimationFrame(tick);
    } else {
      soloAnswered = true; soloWrong++; soloStreak = 0;
      SFX.timeout();
      showSoloToast("timeout");
      const q = soloQuestions[soloIndex];
      const opts = $("soloOptions").children;
      for (let i = 0; i < opts.length; i++) {
        opts[i].dataset.locked = "true";
        if (i === q.answerIndex) opts[i].classList.add("correct");
        else                     opts[i].classList.add("dimmed");
      }
      setTimeout(() => { soloIndex++; soloIndex < 20 ? renderSoloQ() : endSolo(); }, 2000);
    }
  }
  soloTimerRAF = requestAnimationFrame(tick);
}

function stopSoloTimer() {
  if (soloTimerRAF) { cancelAnimationFrame(soloTimerRAF); soloTimerRAF = null; }
  const bar = $("soloTimerBar"); const txt = $("soloTimerText");
  if (bar) { bar.style.width="0%"; bar.classList.remove("low"); }
  if (txt) txt.innerText = "0";
}

function showSoloToast(type) {
  const toast = $("soloToast"); if (!toast) return;
  toast.className = "";
  if (type==="correct") {
    const b = soloStreak>=3?" 🔥×"+soloStreak:"";
    toast.innerText = "✓  Correct  +10"+b;
    toast.className = "correct-toast show";
  } else if (type==="wrong") {
    toast.innerText = "✗  Wrong answer";
    toast.className = "wrong-toast show";
  } else {
    toast.innerText = "⏱  Time's up!";
    toast.className = "timeout-toast show";
  }
  setTimeout(()=>toast.classList.remove("show"), 1800);
}

async function endSolo() {
  stopSoloTimer();
  SFX.finish();
  const pct = soloCorrect/20;
  let emoji="😅", title="Keep Practising!";
  if (pct>=0.9)      { emoji="🏆"; title="Outstanding!"; }
  else if (pct>=0.75){ emoji="🎉"; title="Great Job!"; }
  else if (pct>=0.5) { emoji="👍"; title="Not Bad!"; }

  $("resultEmoji").innerText  = emoji;
  $("resultTitle").innerText  = title;
  $("resultSub").innerText    = soloCorrect+"/20 correct · "+soloScore+" points";
  $("resultScore").innerText  = soloScore;
  $("statCorrect").innerText  = soloCorrect;
  $("statWrong").innerText    = soloWrong;
  $("statStreak").innerText   = soloBestStreak+(soloBestStreak>=3?"🔥":"");
  $("totalScore").innerText   = soloScore;
  show("soloResultScreen");

  if (myName && soloScore > 0) {
    await pushToLeaderboard(myName, myAvatar, soloScore, "solo");
    $("lbBadge").style.display = "";
    setTimeout(()=>switchTab("leaderboard"), 900);
  } else {
    $("lbBadge").style.display = "none";
  }
}

$("soloPlayAgainBtn").onclick = () => { SFX.start(); startSolo(); };

// ═════════════════════════════════════════════════════════════
//  MULTIPLAYER
// ═════════════════════════════════════════════════════════════

$("hostBtn").onclick = async () => {
  const name = $("nameInput").value.trim(); if (!name) return;
  myName = name;
  roomCode = Math.random().toString(36).substring(2,6).toUpperCase();
  roomRef  = doc(db, "rooms", roomCode);
  await setDoc(roomRef, { status:"waiting", host:uid, round:1, currentQuestion:0, questions:pickQuestions(20), answersCount:0, showAnswer:false });
  await setDoc(doc(roomRef,"players",uid), { name, avatar:myAvatar, score:0, roundScores:[0,0,0,0,0] });
  SFX.click();
  startLobby(name);
};

$("joinBtn").onclick = async () => {
  const code = $("roomInput").value.trim().toUpperCase();
  const name = $("nameInput").value.trim();
  if (!name||code.length!==4) return;
  myName  = name;
  roomRef = doc(db,"rooms",code);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return alert("Room not found!");
  roomCode = code;
  await setDoc(doc(roomRef,"players",uid), { name, avatar:myAvatar, score:0, roundScores:[0,0,0,0,0] });
  SFX.click();
  startLobby(name);
};

function startLobby(name) {
  $("playerName").innerText    = name;
  $("sidebarAvatar").innerText = myAvatar;
  $("roomLabel").innerText     = "ROOM "+roomCode;
  renderRoomCode(roomCode);
  const d = $("copyCodeDisplay"); if (d) d.innerText = roomCode||"----";
  show("lobbyScreen");
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
      setTimeout(()=>{ btn.classList.remove("copied"); $("copyLabel").innerText="Copy Code"; }, 2000);
    };
    navigator.clipboard.writeText(roomCode||"").then(done).catch(()=>{
      const el=document.createElement("textarea"); el.value=roomCode;
      document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el);
      done();
    });
  };
}

function subscribeToRoom() {
  onSnapshot(roomRef, snap => {
    const prev = gameData;
    gameData   = snap.data();
    if (!gameData) return;
    const isHost = gameData.host === uid;

    if (gameData.status === "waiting") {
      if (isHost) { $("startBtn").classList.remove("hidden"); $("lobbyStatus").innerText = "You are the host."; }
      else        { $("startBtn").classList.add("hidden");    $("lobbyStatus").innerText = "Waiting for host..."; }

    } else if (gameData.status === "playing") {
      show("gameScreen");
      const qIdx = gameData.currentQuestion;

      if (qIdx !== renderedQIndex) {
        renderedQIndex = qIdx; mySelection = null; hasAnswered = false; revealLocked = false;
        renderQuestion();
        if (!gameData.showAnswer) { SFX.reveal(); startTimer(); }

      } else if (gameData.showAnswer && prev && !prev.showAnswer) {
        stopTimer(); revealQuestion(); showAnswerToast();
      }

      if (isHost && !gameData.showAnswer && gameData.answersCount >= playerCount && playerCount > 0) doReveal();

    } else if (gameData.status === "roundEnd") {
      stopTimer(); show("roundWinnerScreen");
      $("nextLevelBtn").classList.toggle("hidden", !isHost);

    } else if (gameData.status === "seriesEnd") {
      stopTimer(); showSeriesWinner();
    }
  });
}

function subscribeToPlayers() {
  onSnapshot(collection(roomRef,"players"), snap => {
    playerCount = snap.size;
    const players = [];
    snap.forEach(d => players.push({ id:d.id, ...d.data() }));
    players.sort((a,b) => b.score - a.score);

    const list = $("playersList"); list.innerHTML = "";
    players.forEach(p => {
      const row = document.createElement("div");
      row.className = "player-row"+(p.id===uid?" me":"");
      row.innerHTML = `<span class="pr-av">${p.avatar||"🎮"}</span><span class="pr-name">${p.name}</span><span class="pts">${p.score}</span>`;
      list.appendChild(row);
      if (p.id === uid) { $("totalScore").innerText=p.score; $("sidebarAvatar").innerText=p.avatar||myAvatar; }
    });

    const isHost = gameData && gameData.host === uid;
    $("startBtn").disabled = !(isHost && snap.size >= 2);
    if (gameData && gameData.host===uid && gameData.status==="playing" && !gameData.showAnswer && gameData.answersCount>=playerCount && playerCount>0) doReveal();
  });
}

function renderQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];
  $("roundIndicator").innerText = "ROUND "+gameData.round+"  ·  Q "+(gameData.currentQuestion+1)+"/20";
  $("qTag").innerText           = "Question "+(gameData.currentQuestion+1)+" of 20";
  $("questionText").innerText   = q.question;
  const container = $("options"); container.innerHTML = "";
  q.options.forEach((opt,i) => {
    const div = makeOption(opt, letters[i]);
    if (hasAnswered && i===mySelection) div.classList.add("marked");
    if (hasAnswered) div.dataset.locked = "true";
    if (!hasAnswered) div.onclick = () => handleAnswer(i);
    container.appendChild(div);
  });
}

function revealQuestion() {
  const q = gameData.questions[gameData.currentQuestion];
  const letters = ["A","B","C","D"];
  const container = $("options"); container.innerHTML = "";
  q.options.forEach((opt,i) => {
    const div = makeOption(opt, letters[i]);
    div.dataset.locked = "true";
    if (i===q.answerIndex)    div.classList.add("correct");
    else if (i===mySelection) div.classList.add("wrong");
    else                      div.classList.add("dimmed");
    container.appendChild(div);
  });
}

async function handleAnswer(idx) {
  if (hasAnswered||gameData.showAnswer) return;
  hasAnswered = true; mySelection = idx;
  SFX.click(); renderQuestion();
  const q = gameData.questions[gameData.currentQuestion];
  if (idx === q.answerIndex) {
    const pRef = doc(roomRef,"players",uid);
    await runTransaction(db, async t => {
      const snap = await t.get(pRef); const p = snap.data();
      const rounds = [...p.roundScores]; rounds[gameData.round-1] += 10;
      t.update(pRef, { score:increment(10), roundScores:rounds });
    });
  }
  await updateDoc(roomRef, { answersCount:increment(1) });
}

async function doReveal() {
  if (revealLocked||!gameData||gameData.showAnswer) return;
  revealLocked = true;
  await updateDoc(roomRef, { showAnswer:true });
  setTimeout(async () => {
    if (!gameData) return;
    const nextQ = gameData.currentQuestion+1;
    if (nextQ < 20) {
      await updateDoc(roomRef, { currentQuestion:nextQ, showAnswer:false, answersCount:0 });
    } else {
      await updateDoc(roomRef, { status: gameData.round+1>5 ? "seriesEnd" : "roundEnd" });
    }
  }, 4000);
}

function startTimer() {
  stopTimer();
  timerStart = performance.now(); lastTickSec = 20;
  const bar = $("timerBar"); const txt = $("timerText");
  function tick(now) {
    const elapsed = now-timerStart, remaining = Math.max(0,TIMER_MS-elapsed);
    const pct = remaining/TIMER_MS, secs = Math.ceil(remaining/1000);
    bar.style.width = pct*100+"%"; bar.classList.toggle("low",pct<0.3);
    if (txt) txt.innerText = secs;
    if (secs<=6 && secs!==lastTickSec) { lastTickSec=secs; SFX.tick(); }
    if (remaining>0) { timerRAF=requestAnimationFrame(tick); }
    else if (gameData && gameData.host===uid && !gameData.showAnswer) doReveal();
  }
  timerRAF = requestAnimationFrame(tick);
}

function stopTimer() {
  if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF=null; }
  const bar=$("timerBar"); const txt=$("timerText");
  if (bar) { bar.style.width="0%"; bar.classList.remove("low"); }
  if (txt) txt.innerText="0";
}

function showAnswerToast() {
  const toast = $("answerToast"); if (!toast) return;
  const q = gameData.questions[gameData.currentQuestion];
  toast.className = "";
  if (!hasAnswered) { toast.innerText="⏱  Time's up!"; toast.className="timeout-toast show"; SFX.timeout(); }
  else if (mySelection===q.answerIndex) { toast.innerText="✓  Correct  +10"; toast.className="correct-toast show"; SFX.correct(); }
  else { toast.innerText="✗  Wrong answer"; toast.className="wrong-toast show"; SFX.wrong(); }
  setTimeout(()=>toast.classList.remove("show"), 3500);
}

function showSeriesWinner() {
  SFX.finish(); show("seriesWinnerScreen");
  onSnapshot(collection(roomRef,"players"), snap => {
    const players = [];
    snap.forEach(d => players.push({ id:d.id, ...d.data() }));
    players.sort((a,b)=>b.score-a.score);
    let html = `<table><tr><th></th><th>Player</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th><th>Total</th></tr>`;
    players.forEach((p,rank)=>{
      const medal=["🥇","🥈","🥉"][rank]||"";
      html+=`<tr class="${p.id===uid?"my-row":""}">
        <td>${p.avatar||"🎮"}</td><td style="text-align:left;font-weight:700">${medal} ${p.name}</td>
        <td>${p.roundScores[0]}</td><td>${p.roundScores[1]}</td><td>${p.roundScores[2]}</td><td>${p.roundScores[3]}</td><td>${p.roundScores[4]}</td>
        <td><strong>${p.score}</strong></td></tr>`;
      pushToLeaderboard(p.name, p.avatar, p.score, "multi");
    });
    $("seriesStats").innerHTML = html+"</table>";
  });
}

$("startBtn").onclick = () => {
  if (!gameData||gameData.host!==uid) return;
  SFX.start(); updateDoc(roomRef,{status:"playing"});
};
$("nextLevelBtn").onclick = async () => {
  if (!gameData||gameData.host!==uid) return;
  SFX.start();
  await updateDoc(roomRef,{ round:gameData.round+1, currentQuestion:0, status:"playing", questions:pickQuestions(20), answersCount:0, showAnswer:false });
};
