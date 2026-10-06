# Gamble Website

Discord-only login, Blurple flat UI, dark/light mode, and a wallet schema compatible with the supplied Discord bot.

## Games included

- Blackjack
- Mines
- Color Dice
- Coinflip
- Duel
- Leaderboard

The supplied bot exposes the same five games through slash commands and stores wallets using the Discord user ID as the account key. The website follows that same convention.

## 1. Install

```bash
npm install
```

Copy `.env.example` to `.env`.

## 2. Discord OAuth2

In the Discord Developer Portal, create/use the same Application that owns your bot.

OAuth2 redirect URI:

```text
http://localhost:3000/auth/discord/callback
```

For production, use your real HTTPS domain instead.

Put these in `.env`:

```env
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://your-domain.com/auth/discord/callback
DISCORD_GUILD_ID=your_server_id
REQUIRE_GUILD_MEMBER=true
```

The site requests `identify` and, when member-only access is enabled, `guilds`.

Never put `DISCORD_CLIENT_SECRET` in frontend JavaScript.

## 3. Firebase

Use the SAME Firebase project as the bot:

```env
FIREBASE_PROJECT_ID=gamble-4ceaf
FIREBASE_DATABASE_URL=https://gamble-4ceaf-default-rtdb.asia-southeast1.firebasedatabase.app
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
```

The bot's supplied code uses:

```text
Firestore collection: wallets
Document ID: Discord user ID
Fields:
  balance
  deposit_total
  withdraw_total
  history
```

The website reads/writes that same structure and mirrors changes to RTDB.

Keep `serviceAccountKey.json` server-side only. Do not put it under `public/`.

## 4. Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Important production note

For production, put the game API behind HTTPS and keep the Firebase service account private.

For the strongest consistency between the Discord bot and website, route all balance mutations through one backend wallet service or convert both sides to the same Firestore transaction-based wallet functions. The supplied bot currently performs read/modify/write operations, so simultaneous bot + website bets can otherwise race.

If Gems ever become redeemable for real money or anything of real-world value, add the appropriate age, jurisdiction, KYC/AML, responsible-gambling, payment, and licensing controls before launching.
