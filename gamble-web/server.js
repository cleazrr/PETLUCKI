require("dotenv").config();

const express = require("express");
const cookieSession = require("cookie-session");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  REQUIRE_GUILD_MEMBER = "true",
  SESSION_SECRET,
  FIREBASE_PROJECT_ID = "gamble-4ceaf",
  FIREBASE_DATABASE_URL,
  GOOGLE_APPLICATION_CREDENTIALS,
  FIREBASE_SERVICE_ACCOUNT_JSON,
  PORT = 3000
} = process.env;

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SESSION_SECRET) {
  console.warn("Missing Discord/session environment variables.");
}

let credential;
if (FIREBASE_SERVICE_ACCOUNT_JSON) {
  credential = admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON));
} else {
  credential = admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential,
    projectId: FIREBASE_PROJECT_ID,
    databaseURL: FIREBASE_DATABASE_URL
  });
}

const firestore = admin.firestore();
const realtime = admin.database();

app.use(cookieSession({
  name: "gamble_session",
  keys: [SESSION_SECRET],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

const SUFFIXES = {
  k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15, qa: 1e15,
  qi: 1e18, sx: 1e21, sp: 1e24, oc: 1e27, no: 1e30, dc: 1e33
};

function parseAmount(input, balance = 0) {
  const text = String(input ?? "").toLowerCase().trim();
  if (text === "all") return balance;
  if (text === "half") return Math.floor(balance / 2);
  const match = text.match(/^(\\d+(?:\\.\\d+)?)\\s*([a-z]+)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  const suffix = match[2];
  if (!Number.isFinite(value)) return null;
  const multiplier = suffix ? SUFFIXES[suffix] : 1;
  if (!multiplier) return null;
  const result = Math.floor(value * multiplier);
  return Number.isSafeInteger(result) ? result : null;
}

function formatGems(n) {
  n = Number(n) || 0;
  const list = [["DC",1e33],["NO",1e30],["OC",1e27],["SP",1e24],["SX",1e21],
    ["QI",1e18],["QA",1e15],["T",1e12],["B",1e9],["M",1e6],["K",1e3]];
  for (const [s,m] of list) if (n >= m) return `${(n/m).toFixed(2).replace(/\\.00$/,"").replace(/(\\.\\d)0$/,"$1")}${s}`;
  return n.toLocaleString("en-US");
}

async function getProfile(id) {
  const ref = firestore.collection("wallets").doc(String(id));
  const snap = await ref.get();
  if (snap.exists) {
    const d = snap.data() || {};
    return {
      balance: Number(d.balance || 0),
      deposit_total: Number(d.deposit_total || 0),
      withdraw_total: Number(d.withdraw_total || 0),
      history: Array.isArray(d.history) ? d.history : []
    };
  }
  const r = await realtime.ref(`wallets/${id}`).get();
  if (r.exists()) {
    const d = r.val() || {};
    return {
      balance: Number(d.balance || 0),
      deposit_total: Number(d.deposit_total || 0),
      withdraw_total: Number(d.withdraw_total || 0),
      history: Array.isArray(d.history) ? d.history : []
    };
  }
  return { balance: 0, deposit_total: 0, withdraw_total: 0, history: [] };
}

async function saveProfile(id, profile) {
  const payload = {
    balance: String(Math.max(0, Math.floor(profile.balance))),
    deposit_total: String(Math.max(0, Math.floor(profile.deposit_total))),
    withdraw_total: String(Math.max(0, Math.floor(profile.withdraw_total))),
    history: (profile.history || []).slice(-30)
  };
  await firestore.collection("wallets").doc(String(id)).set(payload, { merge: true });
  await realtime.ref(`wallets/${id}`).set(payload);
  return payload;
}

async function changeBalance(id, delta, historyText = null) {
  const ref = firestore.collection("wallets").doc(String(id));
  const result = await firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const oldBalance = Number(d.balance || 0);
    const next = oldBalance + Number(delta);
    if (next < 0) throw new Error("INSUFFICIENT_BALANCE");
    const history = Array.isArray(d.history) ? d.history.slice(-29) : [];
    if (historyText) history.push(`\`${new Date().toISOString().slice(0,16).replace("T"," ")}\` ${historyText}`);
    const payload = {
      balance: String(Math.floor(next)),
      deposit_total: String(Number(d.deposit_total || 0)),
      withdraw_total: String(Number(d.withdraw_total || 0)),
      history
    };
    tx.set(ref, payload, { merge: true });
    return Math.floor(next);
  });
  return result;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Discord login required." });
  next();
}

async function discordToken(code) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: DISCORD_REDIRECT_URI
  });
  const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body
  });
  if (!tokenRes.ok) throw new Error("Discord token exchange failed");
  return tokenRes.json();
}

async function discordUser(accessToken) {
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) throw new Error("Discord user lookup failed");
  return r.json();
}

async function isGuildMember(accessToken, guildId) {
  if (!guildId) return true;
  const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return r.ok;
}

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: REQUIRE_GUILD_MEMBER === "true" ? "identify guilds" : "identify",
    state,
    prompt: "consent"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send("Invalid OAuth state.");
    }
    delete req.session.oauthState;

    const token = await discordToken(req.query.code);
    const user = await discordUser(token.access_token);

    if (REQUIRE_GUILD_MEMBER === "true" && DISCORD_GUILD_ID) {
      const member = await isGuildMember(token.access_token, DISCORD_GUILD_ID);
      if (!member) return res.status(403).send("You must be a member of the Discord server.");
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      global_name: user.global_name || user.username,
      avatar: user.avatar,
      avatarUrl: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) % 5n)}.png`
    };

    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.status(500).send("Discord login failed.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const profile = await getProfile(req.session.user.id);
  res.json({ user: req.session.user, profile, formattedBalance: formatGems(profile.balance) });
});

app.get("/api/leaderboard", async (_req, res) => {
  const snap = await firestore.collection("wallets").get();
  const rows = snap.docs.map(d => ({ id: d.id, balance: Number(d.data().balance || 0) }))
    .sort((a,b) => b.balance - a.balance).slice(0, 10);
  const out = [];
  for (const row of rows) {
    let user = null;
    try {
      const r = await fetch(`https://discord.com/api/v10/users/${row.id}`, {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN || ""}` }
      });
      if (r.ok) user = await r.json();
    } catch {}
    out.push({ ...row, name: user?.global_name || user?.username || `User ${row.id}`, formatted: formatGems(row.balance) });
  }
  res.json(out);
});

const games = {
  blackjack: { name: "Blackjack", icon: "cards" },
  mines: { name: "Mines", icon: "mine" },
  colordice: { name: "Color Dice", icon: "dice" },
  coinflip: { name: "Coinflip", icon: "coin" },
  duel: { name: "Duel", icon: "swords" }
};

app.get("/api/games", (_req,res) => res.json(Object.entries(games).map(([id,v]) => ({id,...v}))));

const sessions = new Map();

app.post("/api/games/mines/start", requireAuth, async (req,res) => {
  const bet = parseAmount(req.body.amount, (await getProfile(req.session.user.id)).balance);
  const level = Math.max(1, Math.min(19, Number(req.body.level || 1)));
  if (!bet || bet <= 0) return res.status(400).json({error:"Invalid bet."});
  try {
    await changeBalance(req.session.user.id, -bet, `⛏️ Mines bet **${formatGems(bet)}**`);
  } catch { return res.status(400).json({error:"Not enough Gems."}); }

  const bombs = new Set();
  while (bombs.size < level) bombs.add(Math.floor(Math.random()*20));
  const id = crypto.randomUUID();
  sessions.set(id, {type:"mines", userId:req.session.user.id, bet, level, bombs, revealed:new Set(), over:false});
  res.json({id, bet, level, tiles:20});
});

app.post("/api/games/mines/pick", requireAuth, async (req,res) => {
  const s = sessions.get(req.body.id);
  if (!s || s.type !== "mines" || s.userId !== req.session.user.id || s.over) return res.status(400).json({error:"Game unavailable."});
  const i = Number(req.body.index);
  if (!Number.isInteger(i) || i < 0 || i >= 20 || s.revealed.has(i)) return res.status(400).json({error:"Invalid tile."});
  if (s.bombs.has(i)) {
    s.over = true; sessions.delete(req.body.id);
    await saveProfile(req.session.user.id, await getProfile(req.session.user.id).then(p => {
      p.history.push(`\`${new Date().toISOString().slice(0,16).replace("T"," ")}\` 💣 Mines lost **${formatGems(s.bet)}**`);
      return p;
    }));
    return res.json({result:"bomb", revealed:[...s.bombs]});
  }
  s.revealed.add(i);
  const multiplier = 1 + (s.level * s.revealed.size) / 100;
  const payout = Math.floor(s.bet * multiplier);
  if (s.revealed.size >= 20-s.level) {
    s.over = true; sessions.delete(req.body.id);
    await changeBalance(req.session.user.id, payout, `🏆 Mines cleared **+${formatGems(payout-s.bet)}**`);
    return res.json({result:"clear", revealed:[...s.revealed], multiplier, payout});
  }
  res.json({result:"safe", revealed:[...s.revealed], multiplier, payout});
});

app.post("/api/games/mines/cashout", requireAuth, async (req,res) => {
  const s = sessions.get(req.body.id);
  if (!s || s.type !== "mines" || s.userId !== req.session.user.id || s.over || !s.revealed.size) return res.status(400).json({error:"Cannot cash out yet."});
  const multiplier = 1 + (s.level * s.revealed.size) / 100;
  const payout = Math.floor(s.bet * multiplier);
  s.over = true; sessions.delete(req.body.id);
  await changeBalance(req.session.user.id, payout, `⛏️ Mines cashout **+${formatGems(payout-s.bet)}**`);
  res.json({result:"cashout", payout, multiplier});
});

app.post("/api/games/blackjack/start", requireAuth, async (req,res) => {
  const p = await getProfile(req.session.user.id);
  const bet = parseAmount(req.body.amount, p.balance);
  if (!bet || bet <= 0 || p.balance < bet) return res.status(400).json({error:"Invalid or insufficient bet."});
  await changeBalance(req.session.user.id, -bet, `🃏 Blackjack bet **${formatGems(bet)}**`);
  const suits=["♠","♥","♦","♣"], ranks=["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  let deck=[]; for(let n=0;n<6;n++) for(const su of suits) for(const ra of ranks) deck.push({suit:su,rank:ra});
  deck.sort(()=>Math.random()-0.5);
  const handScore = h => { let x=0,a=0; for(const c of h){x += ["J","Q","K"].includes(c.rank)?10:c.rank==="A"?11:Number(c.rank); if(c.rank==="A")a++} while(x>21&&a--)x-=10; return x; };
  const s={type:"blackjack",userId:req.session.user.id,bet,deck,player:[deck.pop(),deck.pop()],dealer:[deck.pop(),deck.pop()],over:false};
  const id=crypto.randomUUID(); sessions.set(id,s);
  res.json({id,player:s.player,dealer:[s.dealer[0],null],score:handScore(s.player)});
});

app.post("/api/games/blackjack/action", requireAuth, async (req,res) => {
  const s=sessions.get(req.body.id);
  if(!s||s.type!=="blackjack"||s.userId!==req.session.user.id||s.over)return res.status(400).json({error:"Game unavailable."});
  const score=h=>{let x=0,a=0;for(const c of h){x+=["J","Q","K"].includes(c.rank)?10:c.rank==="A"?11:Number(c.rank);if(c.rank==="A")a++}while(x>21&&a--)x-=10;return x};
  if(req.body.action==="hit"){
    s.player.push(s.deck.pop());
    if(score(s.player)>21){s.over=true;sessions.delete(req.body.id);return res.json({result:"lose",player:s.player,dealer:s.dealer,score:score(s.player),dealerScore:score(s.dealer),payout:0});}
    return res.json({result:"continue",player:s.player,dealer:[s.dealer[0],null],score:score(s.player)});
  }
  if(req.body.action==="stand"){
    while(score(s.dealer)<17)s.dealer.push(s.deck.pop());
    const ps=score(s.player),ds=score(s.dealer); let payout=0,result="lose";
    if(ds>21||ps>ds){payout=s.bet*2;result="win"} else if(ps===ds){payout=s.bet;result="push"}
    if(payout)await changeBalance(req.session.user.id,payout,`🃏 Blackjack ${result} **${formatGems(payout)}**`);
    s.over=true;sessions.delete(req.body.id);
    return res.json({result,player:s.player,dealer:s.dealer,score:ps,dealerScore:ds,payout});
  }
  return res.status(400).json({error:"Unknown action."});
});

app.post("/api/games/colordice/start", requireAuth, async (req,res) => {
  const p=await getProfile(req.session.user.id); const bet=parseAmount(req.body.amount,p.balance);
  if(!bet||bet<=0||p.balance<bet)return res.status(400).json({error:"Invalid or insufficient bet."});
  const color=["red","blue","green","yellow"].includes(req.body.color)?req.body.color:"red";
  await changeBalance(req.session.user.id,-bet,`🎨 Color Dice bet **${formatGems(bet)}**`);
  const rolls=[]; let winnerColor; do { winnerColor=["red","blue","green","yellow"][Math.floor(Math.random()*4)]; rolls.push(winnerColor); } while(rolls.length<2 && winnerColor!==color);
  const payout=winnerColor===color?bet*4:0;
  if(payout)await changeBalance(req.session.user.id,payout,`🎨 Color Dice win **+${formatGems(payout-bet)}**`);
  res.json({color,rolls,result:winnerColor===color?"win":"lose",payout});
});

app.post("/api/games/coinflip", requireAuth, async (req,res) => {
  const p=await getProfile(req.session.user.id); const bet=parseAmount(req.body.amount,p.balance);
  if(!bet||bet<=0||p.balance<bet)return res.status(400).json({error:"Invalid or insufficient bet."});
  const side=req.body.side==="tails"?"tails":"heads";
  await changeBalance(req.session.user.id,-bet,`🪙 Coinflip bet **${formatGems(bet)}**`);
  const outcome=Math.random()<.5?"heads":"tails"; const win=outcome===side; const payout=win?bet*2:0;
  if(payout)await changeBalance(req.session.user.id,payout,`🪙 Coinflip win **+${formatGems(bet)}**`);
  res.json({side,outcome,result:win?"win":"lose",payout});
});

app.post("/api/games/duel", requireAuth, async (req,res) => {
  const p=await getProfile(req.session.user.id); const bet=parseAmount(req.body.amount,p.balance);
  if(!bet||bet<=0||p.balance<bet)return res.status(400).json({error:"Invalid or insufficient bet."});
  await changeBalance(req.session.user.id,-bet,`⚔️ Duel bet **${formatGems(bet)}**`);
  const you=1+Math.floor(Math.random()*100), bot=1+Math.floor(Math.random()*100);
  let payout=0,result="lose"; if(you>bot){payout=bet*2;result="win"} else if(you===bot){payout=bet;result="push"}
  if(payout)await changeBalance(req.session.user.id,payout,`⚔️ Duel ${result} **${formatGems(payout)}**`);
  res.json({you,opponent:bot,result,payout});
});

app.listen(PORT,()=>console.log(`Gamble website running at http://localhost:${PORT}`));
