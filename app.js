import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, onSnapshot, runTransaction, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
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

// --- DESIGN SETTINGS ---
const AVAILABLE_COLORS = ['#ffb84d', '#3498db', '#e74c3c', '#9b59b6', '#2ecc71', '#16a085', '#f1c40f', '#e67e22'];
const BADGE_DEFS = {
    "victor": { icon: "🏆", title: "Duo Winner" },
    "expert": { icon: "🎯", title: "Score 200 in a Level" }
};

let uid, roomCode, roomRef, gameData, gameTimer, isSolo = false;
let allQuestions = [];
let mySelection = null;
let userData = null;

// --- INITIALIZE ---
signInAnonymously(auth).then(async (res) => {
    uid = res.user.uid;
    allQuestions = parseQuestions();
    await loadProfile();
    renderColorGrid();
    loadLeaderboard();
});

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

// --- PROFILE LOGIC ---
async function loadProfile() {
    const userRef = doc(db, "users", uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
        userData = snap.data();
    } else {
        userData = { name: "Guest", careerPts: 0, color: AVAILABLE_COLORS[0], badges: [], wins: 0 };
        await setDoc(userRef, userData);
    }
    updateSidebarUI();
    renderBadges();
}

function updateSidebarUI() {
    document.getElementById("sidebarCircle").style.backgroundColor = userData.color;
    document.getElementById("playerName").innerText = userData.name;
    document.getElementById("totalScore").innerText = userData.careerPts;
    document.getElementById("nameInput").value = userData.name !== "Guest" ? userData.name : "";
}

function renderColorGrid() {
    const grid = document.getElementById("colorGrid");
    grid.innerHTML = "";
    AVAILABLE_COLORS.forEach(c => {
        const div = document.createElement("div");
        div.className = "color-option" + (userData.color === c ? " selected" : "");
        div.style.backgroundColor = c;
        div.onclick = () => selectColor(c);
        grid.appendChild(div);
    });
}

async function selectColor(c) {
    userData.color = c;
    await updateDoc(doc(db, "users", uid), { color: c });
    updateSidebarUI();
    renderColorGrid();
}

function renderBadges() {
    const container = document.getElementById("badgeContainer");
    container.innerHTML = "";
    Object.keys(BADGE_DEFS).forEach(id => {
        const unlocked = userData.badges.includes(id);
        container.innerHTML += `<div class="badge-item ${unlocked ? 'unlocked' : ''}" title="${BADGE_DEFS[id].title}">${BADGE_DEFS[id].icon}</div>`;
    });
}

// --- LEADERBOARD ---
function loadLeaderboard() {
    const q = query(collection(db, "users"), orderBy("careerPts", "desc"), limit(10));
    onSnapshot(q, snap => {
        const body = document.getElementById("globalLeaderboardBody");
        body.innerHTML = "";
        snap.forEach((d, i) => {
            const u = d.data();
            body.innerHTML += `<tr><td>${i+1}</td><td style="text-align:left"><span class="list-icon" style="background:${u.color}"></span> ${u.name}</td><td>${u.careerPts}</td></tr>`;
        });
    });
}

// --- NAVIGATION ---
const show = (id) => { document.querySelectorAll('section').forEach(s => s.classList.add('hidden')); document.getElementById(id).classList.remove('hidden'); };
document.getElementById("toProfileBtn").onclick = () => show("profileScreen");
document.getElementById("sidebarProfileTrigger").onclick = () => show("profileScreen");
document.getElementById("backHomeBtn").onclick = () => show("homeScreen");

document.getElementById("hostBtn").onclick = () => startMatch("host");
document.getElementById("joinBtn").onclick = () => startMatch("join");
document.getElementById("soloBtn").onclick = () => startMatch("solo");

async function startMatch(mode) {
    const name = document.getElementById("nameInput").value.trim() || "Guest";
    userData.name = name;
    await updateDoc(doc(db, "users", uid), { name });
    updateSidebarUI();

    if (mode === "solo") {
        isSolo = true;
        gameData = { status: "playing", round: 1, currentQuestion: 0, questions: getRandQs(), showAnswer: false };
        show("gameScreen"); renderGame();
    } else if (mode === "host") {
        isSolo = false;
        roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        roomRef = doc(db, "rooms", roomCode);
        await setDoc(roomRef, { status: "waiting", host: uid, round: 1, currentQuestion: 0, questions: getRandQs(), answersCount: 0, showAnswer: false });
        await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0,0,0,0,0], color: userData.color });
        enterLobby();
    } else {
        const code = document.getElementById("roomInput").value.trim().toUpperCase();
        roomRef = doc(db, "rooms", code);
        const s = await getDoc(roomRef);
        if(!s.exists()) return alert("Room missing");
        roomCode = code;
        await setDoc(doc(roomRef, "players", uid), { name, score: 0, roundScores: [0,0,0,0,0], color: userData.color });
        enterLobby();
    }
}

function getRandQs() { return [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 20); }

function enterLobby() {
    document.getElementById("roomLabel").innerText = "ROOM " + roomCode;
    [...roomCode].forEach((c, i) => document.getElementById("m" + (i + 1)).innerText = c);
    show("lobbyScreen"); watchRoom();
}

// --- GAMEPLAY ---
function watchRoom() {
    onSnapshot(roomRef, snap => {
        gameData = snap.data();
        if (!gameData) return;
        if (gameData.status === "playing") { show("gameScreen"); renderGame(); }
        else if (gameData.status === "roundEnd") show("roundWinnerScreen");
        else if (gameData.status === "seriesEnd") showSeriesWinner();
        
        const host = gameData.host === uid;
        document.getElementById("startBtn").classList.toggle("hidden", !host);
        document.getElementById("lobbyStatus").innerText = host ? "Wait for players..." : "Waiting for host...";
    });

    onSnapshot(collection(roomRef, "players"), snap => {
        const list = document.getElementById("playersList");
        list.innerHTML = "";
        snap.forEach(d => {
            const p = d.data();
            list.innerHTML += `<div><span><span class="list-icon" style="background:${p.color}"></span>${p.name}</span> <span>${p.score}</span></div>`;
        });
        if (gameData?.host === uid) document.getElementById("startBtn").disabled = snap.size < 2;
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
        div.className = "option";
        if (mySelection === i && !gameData.showAnswer) div.classList.add("marked");
        if (gameData.showAnswer) {
            if (i === q.answerIndex) div.classList.add("correct");
            else if (mySelection === i) div.classList.add("wrong");
        }
        div.innerText = opt;
        div.onclick = () => handleAnswer(i, q.answerIndex);
        container.appendChild(div);
    });
    if (!gameData.showAnswer) startTimer();
    else clearInterval(gameTimer);
}

function startTimer() {
    clearInterval(gameTimer);
    let timeLeft = 20;
    gameTimer = setInterval(() => {
        timeLeft -= 0.1;
        document.getElementById("timerBar").style.width = (timeLeft / 20) * 100 + "%";
        if (timeLeft <= 0) { clearInterval(gameTimer); if (isSolo || uid === gameData.host) triggerNext(); }
    }, 100);
}

async function handleAnswer(idx, correct) {
    if (mySelection !== null) return;
    mySelection = idx;
    renderGame();
    if (idx === correct) {
        await updateCareer(10, 10);
        if (!isSolo) {
            const pRef = doc(roomRef, "players", uid);
            await runTransaction(db, async (t) => {
                const p = (await t.get(pRef)).data();
                const r = p.roundScores; r[gameData.round - 1] += 10;
                t.update(pRef, { score: p.score + 10, roundScores: r });
            });
        }
    }
    if (isSolo) setTimeout(triggerNext, 500);
    else {
        await updateDoc(roomRef, { answersCount: gameData.answersCount + 1 });
        if (gameData.answersCount + 1 >= 2 && uid === gameData.host) triggerNext();
    }
}

async function triggerNext() {
    const next = async () => {
        mySelection = null;
        if (gameData.currentQuestion + 1 < 20) {
            if(isSolo) { gameData.currentQuestion++; renderGame(); }
            else await updateDoc(roomRef, { currentQuestion: gameData.currentQuestion + 1, showAnswer: false, answersCount: 0 });
        } else {
            if(isSolo) show("roundWinnerScreen");
            else await updateDoc(roomRef, { status: "roundEnd" });
        }
    };
    if (isSolo) next();
    else { await updateDoc(roomRef, { showAnswer: true }); setTimeout(next, 3000); }
}

async function updateCareer(pts, currentScore) {
    const userRef = doc(db, "users", uid);
    await runTransaction(db, async (t) => {
        const d = (await t.get(userRef)).data();
        let b = d.badges || [];
        if(currentScore >= 200 && !b.includes("expert")) b.push("expert");
        t.update(userRef, { careerPts: (d.careerPts || 0) + pts, badges: b });
    });
    loadProfile();
}

document.getElementById("startBtn").onclick = () => updateDoc(roomRef, { status: "playing" });
document.getElementById("nextLevelBtn").onclick = async () => {
    if (gameData.round < 5) {
        if(isSolo) { gameData.round++; gameData.currentQuestion = 0; gameData.questions = getRandQs(); show("gameScreen"); renderGame(); }
        else await updateDoc(roomRef, { round: gameData.round + 1, currentQuestion: 0, status: "playing", questions: getRandQs(), answersCount: 0, showAnswer: false });
    } else {
        if(isSolo) showSeriesWinner();
        else await updateDoc(roomRef, { status: "seriesEnd" });
    }
};

async function showSeriesWinner() {
    show("seriesWinnerScreen");
    const body = document.getElementById("seriesStats");
    let html = `<table><tr><th>Player</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th><th>Total</th></tr>`;
    if(isSolo) html += `<tr><td>${userData.name}</td><td colspan="5">Solo Finish</td><td>${document.getElementById("totalScore").innerText}</td></tr>`;
    else {
        const snap = await getDoc(collection(roomRef, "players")); // Simplified Duo logic
        // Duo table logic here
    }
    body.innerHTML = html + "</table>";
}
