import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc,
  collection, onSnapshot, addDoc
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_DOMAIN",
  projectId: "YOUR_PROJECT_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let uid, roomCode, roomRef;

const home = document.getElementById("homeScreen");
const lobby = document.getElementById("lobbyScreen");
const game = document.getElementById("gameScreen");

const startBtn = document.getElementById("startBtn");

signInAnonymously(auth).then(res => uid = res.user.uid);

// Utils
function show(screen){
  home.classList.add("hidden");
  lobby.classList.add("hidden");
  game.classList.add("hidden");
  screen.classList.remove("hidden");
}

function renderMatchId(code){
  [...code].forEach((c,i)=>{
    document.getElementById("m"+(i+1)).innerText = c;
  });
}

// Host
document.getElementById("hostBtn").onclick = async ()=>{
  const name = nameInput.value.trim();
  if(!name) return alert("Enter name");

  roomCode = Math.random().toString(36).substring(2,6).toUpperCase();
  roomRef = doc(db,"rooms",roomCode);

  await setDoc(roomRef,{
    status:"waiting",
    host:uid
  });

  await setDoc(doc(roomRef,"players",uid),{
    name,score:0
  });

  document.getElementById("playerName").innerText = name;
  document.getElementById("roomLabel").innerText = "ROOM "+roomCode;
  renderMatchId(roomCode);

  show(lobby);
  watchPlayers();
};

// Join
document.getElementById("joinBtn").onclick = async ()=>{
  const code = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();
  if(code.length!==4) return alert("Enter 4-letter room code");

  roomRef = doc(db,"rooms",code);
  const snap = await getDoc(roomRef);
  if(!snap.exists()) return alert("Room not found");

  roomCode = code;

  await setDoc(doc(roomRef,"players",uid),{
    name,score:0
  });

  document.getElementById("playerName").innerText = name;
  document.getElementById("roomLabel").innerText = "ROOM "+roomCode;
  renderMatchId(roomCode);

  show(lobby);
  watchPlayers();
};

// Player watcher
function watchPlayers(){
  const playersCol = collection(roomRef,"players");
  onSnapshot(playersCol,snap=>{
    playersList.innerHTML="";
    snap.forEach(d=>{
      playersList.innerHTML += `<div>${d.data().name}</div>`;
    });

    // ENABLE START when 2 players
    if(snap.size >= 2){
      startBtn.disabled = false;
    }
  });
}

// START GAME
startBtn.onclick = ()=>{
  show(game);
  loadQuestion();
};

function loadQuestion(){
  questionText.innerText = "Sample Question?";
  options.innerHTML = "";
  ["A","B","C","D"].forEach(o=>{
    const div = document.createElement("div");
    div.className="option";
    div.innerText = o;
    options.appendChild(div);
  });
}
