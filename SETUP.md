# 168极速赛车 Chase Bot — Setup Guide

## What it does

Monitors live draws every 25 seconds and sends a Telegram alert the moment a
chase-pattern condition is met:

| Signal | Rule | Example |
|---|---|---|
| 冠亚和 单双 | Same side ≥ 2 consecutive draws | 双→双 → chase **单** |
| 冠亚和 大小 | Same side ≥ 2 consecutive draws | 大→大 → chase **小** |
| 第七名 单双 | Same side ≥ 1 draw | 单 → chase **双** |
| 第七名 大小 | Same side ≥ 1 draw | 大 → chase **小** |

Data scraped from: `https://www.kjapi.com/kj/index/newjssc168.html`

---

## Step-by-step setup

### Step 1 — Create your Telegram bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. `168 Chase Bot`) and a username (e.g. `my168chasebot`)
4. BotFather replies with a token like:
   ```
   5432198765:AAHdqTcvCH1vGWJxfSeofSh0K9DMugKPThw
   ```
5. Copy and save this token

### Step 2 — Install Node.js

Download from https://nodejs.org (LTS version, 18+).

Verify:
```bash
node --version   # should show v18.x or higher
npm --version
```

### Step 3 — Set up the bot files

```bash
# Create a folder
mkdir 168chase && cd 168chase

# Copy index.js and .env.example here, then:
npm install

# Create .env from the example
cp .env.example .env
```

Edit `.env`:
```
BOT_TOKEN=5432198765:AAHdqTcvCH1vGWJxfSeofSh0K9DMugKPThw
POLL_MS=25000
```

### Step 4 — Run the bot

```bash
node index.js
```

You should see:
```
🏎  168极速赛车 Chase Bot
   Poll: every 25s
   URL:  https://www.kjapi.com/kj/index/newjssc168.html
   Rules:
     [gyDS] 冠亚和 单双  gap=2
     [gyDX] 冠亚和 大小  gap=2
     [p7DS] 第七名 单双  gap=1
     [p7DX] 第七名 大小  gap=1

[NEW] #588012 10:34:22  nums=1,7,4,8,9,5,6,2,3,10  ...
```

### Step 5 — Talk to your bot on Telegram

Open Telegram, search your bot by username, send `/start`.

Commands:
| Command | What it does |
|---|---|
| `/predict` | Show current signal status for all 4 rules |
| `/history` | Last 10 draws with labels |
| `/auto` | Toggle auto-push (only fires when a signal is active) |
| `/status` | Bot uptime, draw count, last issue |
| `/help` | Show help |

---

## Step 6 (optional) — Run 24/7 with PM2

```bash
npm install -g pm2
pm2 start index.js --name 168chase
pm2 save
pm2 startup    # follow the printed command to auto-start on reboot
```

Check logs:
```bash
pm2 logs 168chase
```

---

## How `/auto` works

Auto-push is **signal-gated**:
- After every new draw, the bot evaluates all 4 signals
- Only sends a message if **at least one signal is active**
- Stays silent when no conditions are met (no spam)

---

## Definitions

```
冠亚和 = champion (1st place) + runner-up (2nd place) car numbers
  单双: sum odd = 单,  sum even = 双
  大小: sum ≥ 12 = 大, sum ≤ 11 = 小

第七名 = 7th place car number
  单双: number odd = 单,  number even = 双
  大小: number > 5 = 大,  number ≤ 5  = 小
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond | Check BOT_TOKEN in .env, restart |
| `[scrape] parse failed` in logs | Site may be down or HTML changed; wait and retry |
| No draws being detected | Site may cache; poll_ms=25000 should catch every draw |
| `403 Forbidden` in logs | User blocked the bot; ignored automatically |
