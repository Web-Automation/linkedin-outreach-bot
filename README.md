# LinkedIn OutReach Bot Messenger

A Node.js + Puppeteer automation script that sends personalised messages to your LinkedIn connections with bulletproof duplicate-send prevention and two fully independent operating modes.

---

## Table of Contents

- [Two Operating Modes](#two-operating-modes)
- [What It Does](#what-it-does)
- [Use Cases](#use-cases)
- [How It Works — Step by Step](#how-it-works--step-by-step)
- [Duplicate-Send Protection](#duplicate-send-protection)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Message Templates](#message-templates)
- [Running the Script](#running-the-script)
- [Output Files](#output-files)
- [Troubleshooting](#troubleshooting)
- [Ethical Use & Disclaimer](#ethical-use--disclaimer)
- [Contributing](#contributing)
- [License](#license)

---

## Two Operating Modes

The entire behaviour of the script is controlled by a **single config value**:

```js
resetProgressDays: 0    // ← ONE-SHOT mode
resetProgressDays: N    // ← FOLLOW-UP mode  (N = number of days between re-sends)
```

You do **not** need to comment or uncomment anything else. Just change that one number.

---

### ONE-SHOT Mode — `resetProgressDays: 0`

**Use when:** Job applications, product launches, event invitations — anything where you want to reach each person exactly once.

**How the DOM check works:**
- Navigates to the person's compose URL.
- Checks for any conversation thread signals (`div.msg-s-message-list`, `time` heading, message bubble).
- If **any** of those exist → **SKIP**. Does not matter when the last message was.
- If **none** exist → **SEND**.

**Terminal output example:**
```
Messaging John Smith...  [SAFE | neg:(none)] Sent
Messaging Jane Doe...    [SKIP | neg:(msg-list,time-heading,msg-body)] Skipped
```

---

### FOLLOW-UP Mode — `resetProgressDays: N`

**Use when:** Daily check-ins, weekly newsletters, drip sequences — anything where you re-message the same people on a schedule.

**How the DOM check works:**
- Navigates to the person's compose URL.
- Reads **all** `<time class="msg-s-message-list__time-heading">` elements in the thread.
- Checks the **last** one (most recent date label).
- If its text is `"Today"` → **SKIP** (already messaged today).
- If its text is anything else — `"Saturday"`, `"Monday"`, `"April 18"`, etc. → **SEND** (last contact was a prior day; follow-up is appropriate).
- If there is **no thread at all** → **SEND** (first contact).

**Terminal output example:**
```
Messaging John Smith...  [SAFE | last:"Saturday"] Sent       ← had old thread, OK to follow up
Messaging Jane Doe...    [SKIP | last:"Today"] Skipped       ← already messaged today
Messaging Bob Lee...     [SAFE | no-thread] Sent             ← first contact
```

**Progress map purge:**
On startup, entries in `progress.json` older than `resetProgressDays` days are automatically removed. This makes those people visible to the scroll collector again. The DOM check then runs independently — so even after a progress reset, if someone was messaged today their thread will catch them.

---

### Quick Reference

| Goal | `resetProgressDays` | DOM check behaviour |
|---|---|---|
| Message everyone once, forever | `0` | Skip if any thread exists |
| Message daily (skip if sent today) | `1` | Skip if last heading = "Today" |
| Message weekly | `7` | Skip if last heading = "Today" |
| Message monthly | `30` | Skip if last heading = "Today" |
| Message quarterly | `90` | Skip if last heading = "Today" |

---

## What It Does

1. Opens Chrome using your existing profile so LinkedIn stays logged in across runs
2. Auto-logs in if the session has expired (handles OTP / CAPTCHA with a manual pause)
3. Scrolls your connections page and collects up to `bufferSize` profiles
4. For each profile, checks in real-time whether it is safe to send (mode-aware)
5. Types and sends a personalised message (with optional file attachment)
6. Saves progress to disk after every action — crash-safe and resumable
7. Logs every result (SENT / SKIPPED / FAILED) to a CSV file

---

## Use Cases

### 1. Job Search Outreach
```
resetProgressDays: 0
Attach: PDF resume
Message: Introduce yourself, mention experience, ask for referral
```

### 2. Product / Service Marketing
```
resetProgressDays: 0
Attach: Product one-pager or brochure
Message: "I recently launched [Product] — thought it might be relevant given your background..."
```

### 3. Event / Webinar Invitations
```
resetProgressDays: 0
Attach: Event flyer or agenda
Message: "I'm hosting a free webinar on [topic] on [date]..."
```

### 4. B2B Lead Generation
```
resetProgressDays: 30
Attach: Case study or capability deck
Message: "I work with [industry] companies to [solve problem]..."
```

### 5. Recruiting / Talent Sourcing
```
resetProgressDays: 0
Attach: Job description PDF
Message: "I came across your profile and think you'd be a great fit for [role]..."
```

### 6. Weekly Newsletter
```
resetProgressDays: 7
Attach: Nothing (link in message)
Message: "I published a piece on [topic] this week..."
```

### 7. Daily Follow-Up Sequences

Run the script on consecutive days with different messages:

```
Day 1: resetProgressDays: 0 — initial outreach message
Day 3: resetProgressDays: 3 — change MESSAGE to follow-up text, run again
Day 7: resetProgressDays: 7 — change MESSAGE to final touch, run again
```

Each run's DOM check independently verifies whether that specific person was messaged "Today", ensuring no accidental same-day double-send regardless of what the progress map says.

---

## How It Works — Step by Step

### Phase 1 — Startup
- Load `progress.json`; if `resetProgressDays > 0`, purge expired entries
- Print the active mode (ONE-SHOT / FOLLOW-UP) and its DOM check behaviour
- Launch Chrome with a dedicated user-data directory

### Phase 2 — Login Check
- Navigate to `/feed` — skip login if already there
- Otherwise type credentials with human-like delays
- Pause for manual CAPTCHA / OTP solving if required

### Phase 3 — Collect Connections
- Navigate to the connections page
- Read all `"Send a message to"` anchor links
- Skip keys already in the progress map
- Scroll with real mouse wheel events until `bufferSize` profiles are collected or the page is exhausted

### Phase 4 — Send Loop (per person)

**Step 1 — Progress check (Layer 1)**
Already in the map? Skip without any network call.

**Step 2 — Navigate to compose URL**

**Step 3 — URL validation (Layer 4)**
Redirected to `/feed` or `/inbox`? Skip.

**Step 4 — DOM settle**
Poll `innerHTML.length` every 300ms until stable for 900ms.

**Step 5 — Mode-aware DOM check (Layer 2)**

*ONE-SHOT:* Check for `div.msg-s-message-list`, `time.msg-s-message-list__time-heading`, `p.msg-s-event-listitem__body`. Any present → skip.

*FOLLOW-UP:* Read all `<time class="msg-s-message-list__time-heading">` elements; check if the last one says "Today". If yes → skip. Otherwise → proceed.

**Step 6 — Type message** (Shift+Enter for newlines)

**Step 7 — Pre-send re-check (Layer 3)**
Re-runs the same mode-aware DOM check after typing but before pressing Enter.

**Step 8 — Attach file** (if `cvPath` is set)

**Step 9 — Send** (press Enter)

**Step 10 — Save & log** (atomic write to `progress.json`, append to CSV)

**Step 11 — Wait** (random 8–20 seconds)

---

## Duplicate-Send Protection

| Layer | What It Does | Mode Behaviour |
|---|---|---|
| **1. progress.json** | Skips keys seen within the cooldown window | Same in both modes |
| **2. DOM check** | Reads thread state before typing | ONE-SHOT: skip if any thread exists · FOLLOW-UP: skip only if last time heading = "Today" |
| **3. Pre-send re-check** | Re-reads DOM after typing, before Enter | Same mode-aware logic as Layer 2 |
| **4. URL validation** | Aborts if LinkedIn redirected away from compose URL | Same in both modes |

Any single layer triggering is enough to skip. The script always errs on the side of not sending.

---

## Prerequisites

- **Node.js** v16 or later — [nodejs.org](https://nodejs.org)
- **Google Chrome** installed
- A LinkedIn account with connections
- **npm** (comes with Node.js)

---

## Installation

```bash
git clone https://github.com/Web-Automation/linkedin-outreach-bot.git
cd linkedin-messenger
npm install puppeteer-core
```

Then open `linkedinMessengerBot.js` and fill in your `CONFIG` values.

---

## Configuration

All settings live in the `CONFIG` object near the top of `linkedinMessengerBot.js`.

```js
const CONFIG = {

  // ── MODE SWITCH ─────────────────────────────────────────────────────
  // 0 = ONE-SHOT   : never re-message; skip if any conversation thread exists.
  // N = FOLLOW-UP  : re-message after N days; skip only if last msg was today.
  resetProgressDays: 0,

  // ── TARGETING ───────────────────────────────────────────────────────
  dailyLimit: 200,   // messages to SEND per run (skips don't count)
  bufferSize: 600,   // profiles to collect before the send loop starts

  // ── TIMING ──────────────────────────────────────────────────────────
  delayBetween:     [8, 20],       // seconds between sent messages [min, max]
  delayScroll:      [1000, 2000],  // ms between scroll actions [min, max]
  domSettleTimeout: 7000,          // ms to wait for DOM to stop mutating

  // ── CREDENTIALS ─────────────────────────────────────────────────────
  linkedinEmail:    "YOUR_EMAIL@example.com",
  linkedinPassword: "YOUR_PASSWORD",

  // ── FILES ───────────────────────────────────────────────────────────
  cvPath:       "/absolute/path/to/file.pdf",  // null = no attachment
  progressFile: "progress.json",
  logFile:      "messenger_log.csv",

  // ── CHROME ──────────────────────────────────────────────────────────
  // macOS  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  // Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  // Linux  : "/usr/bin/google-chrome"
  chromePath:  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  userDataDir: `${process.env.HOME}/puppeteer-linkedin-profile`,
};
```

### `dailyLimit` guidance

| Account age | Recommended limit |
|---|---|
| Brand new | 10–20/day |
| < 1 month | 20–50/day |
| Established (1+ year) | 50–150/day |
| Aged + Premium | Up to 200–250/day |

---

## Message Templates

Edit the `MESSAGE` constant at the top of `linkedinMessengerBot.js`. Use `\n` for line breaks. `{firstName}` is replaced with the recipient's first name automatically.

### Job Search
```js
const MESSAGE = `Hi {firstName},

I'm exploring Product Manager roles and would love to be considered if anything suitable opens up at your organisation. I bring 4 years in Fintech across B2B and D2C. Please find my resume attached. I'd truly appreciate a referral if you see a fit.`;
```

### Product Launch
```js
const MESSAGE = `Hi {firstName},

I just launched [ProductName] — it helps [audience] with [problem] in [unique way].

Would love your feedback: [link]`;
```

### Event Invitation
```js
const MESSAGE = `Hi {firstName},

I'm running a free webinar on [Topic] on [Date] and immediately thought of you.

It covers [key value]. Here's the link: [URL]`;
```

### B2B Outreach
```js
const MESSAGE = `Hi {firstName},

I help [industry] companies [solve specific problem]. Came across your profile and thought there could be a fit.

Would you be open to a quick 15-min call this week?`;
```

### Weekly Follow-Up
```js
const MESSAGE = `Hi {firstName},

Published a new piece on [topic] this week — thought of you given your work in [field].

[URL] — would love your take.`;
```

---

## Running the Script

```bash
node linkedinMessengerBot.js
```

Chrome opens in a visible window. Do not close it or the terminal while the script runs.

### Terminal output explained

**ONE-SHOT mode:**
```
Messaging John Smith...  [SAFE | neg:(none)] Sent
Messaging Jane Doe...    [SKIP | neg:(msg-list,time-heading)] Skipped
Messaging Bob Lee...     [redirect→https://www.linkedin.com/feed/] Skipped
```

**FOLLOW-UP mode:**
```
Messaging John Smith...  [SAFE | last:"Saturday"] Sent        ← old thread, safe to follow up
Messaging Jane Doe...    [SKIP | last:"Today"] Skipped        ← already messaged today
Messaging Bob Lee...     [SAFE | no-thread] Sent              ← first contact
```

---

## Output Files

### `progress.json`
```json
{
  "recipient:ACoAABcDE123": 1714000000000,
  "recipient:ACoAAXyZ456": 1714050000000
}
```
Delete this file to start completely fresh (everyone becomes eligible again).

### `messenger_log.csv`
```
"Timestamp","Name","URL","Status","Note"
"2024-04-25 10:32:11","John Smith","https://...","SENT",""
"2024-04-25 10:32:31","Jane Doe","https://...","SKIPPED","blocked by DOM check (pre-type)"
"2024-04-25 10:32:45","Bob Lee","https://...","FAILED","TimeoutError: waiting for selector..."
```

---

## Troubleshooting

**"No new connections found"**
All connections are in `progress.json` within the current cooldown. Increase `resetProgressDays`, wait for the cooldown, or grow your connections list.

**Script keeps redirecting to `/feed`**
LinkedIn may have rate-limited your messaging. Lower `dailyLimit`, increase `delayBetween`, and wait 24 hours.

**FOLLOW-UP mode: everyone is being skipped**
The DOM check found "Today" in every thread. Either you already ran the script today, or `domSettleTimeout` is too low (thread not fully loaded before check). Try increasing it to 10000.

**FOLLOW-UP mode: people being messaged twice in one day**
Should not happen — both the pre-check and pre-send check gate on "Today". If it does occur, ensure you are not running two instances simultaneously against the same `progress.json`.

**File not attaching**
Use an **absolute path** in `cvPath`. macOS example: `/Users/yourname/Documents/resume.pdf`. Windows: `C:\Users\yourname\Documents\resume.pdf`.

**"Execution context was destroyed" errors**
Normal — the script retries automatically. If persistent, increase `domSettleTimeout`.

**LinkedIn account restricted**
You sent too many messages too fast. Stop the script. Wait 24–48 hours. Lower `dailyLimit` and increase `delayBetween`. On new accounts, start at 20/day and ramp up slowly.

---

## Ethical Use & Disclaimer

**LinkedIn Terms of Service:** LinkedIn's User Agreement prohibits certain forms of automation. Use of this script may violate those terms and could result in account restriction or banning. Use at your own risk.

**Best practices:**
- Keep messages personal, relevant, and concise
- Only message people with a genuine reason for outreach
- Start with small batches (20–50/day) and scale only if you see positive responses
- Honour opt-outs immediately
- Do not use this to harass, deceive, or mislead anyone

The authors of this project take no responsibility for any consequences arising from its use.

---

## Contributing

Contributions welcome. Fork → branch → PR with a clear description of changes.

Ideas:
- Filter connections by job title or keyword before messaging
- A/B message rotation
- Dry-run mode (collect candidates, print, don't send)
- GUI config editor
- Scheduled / cron mode

---

## License

MIT License. See `LICENSE` for full terms.

---

*Built with Node.js and Puppeteer. Not affiliated with or endorsed by LinkedIn.*
