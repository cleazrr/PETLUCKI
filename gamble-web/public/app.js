const $=s=>document.querySelector(s);
let me=null, currentGame=null, mineState=null, blackjackState=null;

const icons={cards:"♣",mine:"◆",dice:"◈",coin:"●",swords:"⚔"};
const descriptions={
 blackjack:"Beat the dealer without going over 21. Hit, stand, or double down.",
 mines:"Pick safe tiles, build your multiplier, then cash out before the bomb.",
 colordice:"Choose a color and roll until a winning color appears.",
 coinflip:"Pick heads or tails and flip for a 2x payout.",
 duel:"Roll against the house. Highest 1–100 wins the pot."
};

async function api(url,opts={}){
 const r=await fetch(url,{headers:{"Content-Type":"application/json",...(opts.headers||{})},...opts});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(data.error||"Request failed");
 return data;
}

async function boot(){
 try{
   me=await api("/api/me");
   $("#login").classList.add("hidden"); $("#dashboard").classList.remove("hidden");
   renderAccount(); updateBalance(); renderGames();
 }catch{
   $("#login").classList.remove("hidden");
   $("#dashboard").classList.add("hidden");
 }
}
function renderAccount(){
 const u=me.user;
 $("#account").innerHTML=`<div class="user-chip"><img src="${u.avatarUrl}"><span>${escapeHtml(u.global_name)}</span><button class="logout" onclick="logout()">×</button></div>`;
}
function updateBalance(){ $("#balance").textContent=me.formattedBalance; }
async function refresh(){me=await api("/api/me");renderAccount();updateBalance();}
function renderGames(){
 $("#game-grid").innerHTML=Object.entries(descriptions).map(([id,d])=>`<article class="game-card" onclick="openGame('${id}')"><div class="game-icon">${icons[id==="blackjack"?"cards":id]}</div><span class="pill">PLAY</span><h3>${title(id)}</h3><p>${d}</p></article>`).join("");
}
function title(s){return s[0].toUpperCase()+s.slice(1).replace("colordice"," Color Dice")}
function shell(titleText,body){$("#dashboard").classList.add("hidden");$("#leaderboard-view").classList.add("hidden");const v=$("#game-view");v.classList.remove("hidden");v.innerHTML=`<div class="game-panel"><div class="game-head"><div><button class="back" onclick="home()">← Back</button><h2>${titleText}</h2></div></div>${body}</div>`}
function home(){currentGame=null;$("#game-view").classList.add("hidden");$("#leaderboard-view").classList.add("hidden");$("#dashboard").classList.remove("hidden")}
async function openGame(id){
 currentGame=id;
 if(id==="mines")return minesUI();
 if(id==="blackjack")return blackjackUI();
 if(id==="colordice")return colorDiceUI();
 if(id==="coinflip")return coinflipUI();
 if(id==="duel")return duelUI();
}
function amountForm(button,extra=""){return `<div class="form-row"><input id="amount" class="input" placeholder="Bet amount (e.g. 100k, all)">${extra}<button class="primary" onclick="${button}">Play</button></div>`}
function minesUI(){shell("Mines",`${amountForm("startMines()",'<input id="level" class="input" type="number" min="1" max="19" value="3" placeholder="Bombs">')}<div id="mine-area"></div>`)}
async function startMines(){
 try{const x=await api("/api/games/mines/start",{method:"POST",body:JSON.stringify({amount:$("#amount").value,level:Number($("#level").value)})});mineState={...x,revealed:[]};renderMine();}
 catch(e){alert(e.message)}
}
function renderMine(){
 const m=mineState;
 $("#mine-area").innerHTML=`<div class="stats"><div class="stat"><span>Bet</span><strong>${fmt(m.bet)}</strong></div><div class="stat"><span>Bombs</span><strong>${m.level}</strong></div><div class="stat"><span>Safe</span><strong>${m.revealed.length}/${20-m.level}</strong></div></div><div class="tile-grid">${Array.from({length:20},(_,i)=>`<button class="tile ${m.revealed.includes(i)?"safe":""}" onclick="pickMine(${i})">${m.revealed.includes(i)?"◆":"?"}</button>`).join("")}</div><button class="primary" onclick="cashMine()">Cash Out</button>`}
async function pickMine(i){try{const x=await api("/api/games/mines/pick",{method:"POST",body:JSON.stringify({id:mineState.id,index:i})});if(x.result==="bomb"){alert("Boom — you lost the bet.");mineState=null;await refresh();return minesUI()}mineState.revealed=x.revealed;if(x.result==="clear")alert(`Cleared! ${fmt(x.payout)} paid.`);renderMine();await refresh()}catch(e){alert(e.message)}}
async function cashMine(){try{const x=await api("/api/games/mines/cashout",{method:"POST",body:JSON.stringify({id:mineState.id})});alert(`Cashed out ${fmt(x.payout)}.`);mineState=null;await refresh();minesUI()}catch(e){alert(e.message)}}

function blackjackUI(){shell("Blackjack",amountForm("startBlackjack()")+`<div id="bj-area"></div>`)}
async function startBlackjack(){try{blackjackState=await api("/api/games/blackjack/start",{method:"POST",body:JSON.stringify({amount:$("#amount").value})});renderBJ()}catch(e){alert(e.message)}}
function card(c){if(!c)return`<div class="card">?</div>`;return`<div class="card">${c.rank}<br>${c.suit}</div>`}
function renderBJ(){const s=blackjackState;$("#bj-area").innerHTML=`<h3>Dealer</h3><div class="cards">${s.dealer.map(card).join("")}</div><h3>You — ${s.score}</h3><div class="cards">${s.player.map(card).join("")}</div><div class="form-row"><button class="primary" onclick="bjAction('hit')">Hit</button><button class="primary" onclick="bjAction('stand')">Stand</button></div>`}
async function bjAction(action){try{const x=await api("/api/games/blackjack/action",{method:"POST",body:JSON.stringify({id:blackjackState.id,action})});blackjackState={...blackjackState,...x};renderBJ();if(x.result!=="continue"){alert(`${x.result.toUpperCase()} — ${fmt(x.payout)}`);await refresh()}}catch(e){alert(e.message)}}

function colorDiceUI(){shell("Color Dice",`${amountForm("playColorDice()",'<select id="color" class="input"><option value="red">Red</option><option value="blue">Blue</option><option value="green">Green</option><option value="yellow">Yellow</option></select>')}<div id="result"></div>`)}
async function playColorDice(){try{const x=await api("/api/games/colordice/start",{method:"POST",body:JSON.stringify({amount:$("#amount").value,color:$("#color").value})});$("#result").innerHTML=`<div class="result">${x.rolls.join(" → ")}<br>${x.result==="win"?"You won "+fmt(x.payout):"You lost the bet."}</div>`;await refresh()}catch(e){alert(e.message)}}
function coinflipUI(){shell("Coinflip",`${amountForm("playCoinflip()",'<select id="side" class="input"><option value="heads">Heads</option><option value="tails">Tails</option></select>')}<div id="result"></div>`)}
async function playCoinflip(){try{const x=await api("/api/games/coinflip",{method:"POST",body:JSON.stringify({amount:$("#amount").value,side:$("#side").value})});$("#result").innerHTML=`<div class="result">Result: ${x.outcome.toUpperCase()} — ${x.result==="win"?"Won "+fmt(x.payout):"Lost"}</div>`;await refresh()}catch(e){alert(e.message)}}
function duelUI(){shell("Duel",`${amountForm("playDuel()")}<div id="result"></div>`)}
async function playDuel(){try{const x=await api("/api/games/duel",{method:"POST",body:JSON.stringify({amount:$("#amount").value})});$("#result").innerHTML=`<div class="result">You: ${x.you} — Opponent: ${x.opponent}<br>${x.result.toUpperCase()} ${x.payout?fmt(x.payout):""}</div>`;await refresh()}catch(e){alert(e.message)}}

async function leaderboard(){
 $("#dashboard").classList.add("hidden");$("#game-view").classList.add("hidden");const v=$("#leaderboard-view");v.classList.remove("hidden");
 const rows=await api("/api/leaderboard");v.innerHTML=`<div class="game-panel"><div class="game-head"><div><button class="back" onclick="home()">← Back</button><h2>Leaderboard</h2></div></div>${rows.map((r,i)=>`<div class="leader-row"><span class="rank">#${i+1}</span><span>${escapeHtml(r.name)}</span><strong>${r.formatted} Gems</strong></div>`).join("")}</div>`;
}
async function logout(){await api("/auth/logout",{method:"POST"});location.reload()}
function fmt(n){return Number(n).toLocaleString("en-US")+" Gems"}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
document.querySelectorAll("[data-page]").forEach(b=>b.onclick=()=>b.dataset.page==="leaderboard"?leaderboard():home());
$("#theme").onclick=()=>{document.body.classList.toggle("light");localStorage.theme=document.body.classList.contains("light")?"light":"dark"};
if(localStorage.theme==="light")document.body.classList.add("light");
boot();
