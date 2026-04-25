/**
 * LinkedIn Connection Messenger - Node.js + Puppeteer
 * =====================================================
 * 1. Opens Chrome with your existing profile (stays logged in)
 * 2. Auto-login if session has expired
 * 3. Scrolls the connections page and collects a large buffer of profiles
 * 4. Checks each profile in real-time -- skips anyone already messaged
 * 5. Sends personalised messages (+ attachment) until the daily target is hit
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  TWO OPERATING MODES — choose one in CONFIG                        │
 * │                                                                     │
 * │  ONE-SHOT  (resetProgressDays: 0)                                  │
 * │    • Never re-messages the same person.                            │
 * │    • DOM check: skip if ANY conversation thread exists.            │
 * │    • Use for: job applications, product launches, one-off blasts.  │
 * │                                                                     │
 * │  FOLLOW-UP  (resetProgressDays: N, N > 0)                         │
 * │    • Re-messages the same person after N days.                     │
 * │    • DOM check: skip only if the most-recent <time> heading says   │
 * │      "Today" — allows re-send when last message was any prior day. │
 * │    • Use for: daily follow-ups, weekly newsletters, drip sequences.│
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * DUPLICATE-SEND PREVENTION (layered defence):
 *
 *   Layer 1 -- progress.json
 *              Every sent/skipped key is saved atomically to disk (with a
 *              timestamp) after each action.  On the next run those keys are
 *              excluded before any network calls are made.
 *              If CONFIG.resetProgressDays > 0, entries older than that many
 *              days are automatically purged (follow-up mode).
 *
 *   Layer 2 -- MODE-AWARE DOM CHECK (alreadyMessaged)
 *              Before sending, navigates to the compose URL and checks the DOM.
 *
 *              ONE-SHOT MODE  (resetProgressDays === 0):
 *                Skip if ANY of these are present:
 *                  A) div.msg-s-message-list
 *                  B) time.msg-s-message-list__time-heading
 *                  C) p.msg-s-event-listitem__body
 *
 *              FOLLOW-UP MODE  (resetProgressDays > 0):
 *                Skip ONLY if the most-recent <time> heading text is "Today".
 *                If it's "Saturday", "Monday", a full date, etc. → safe to send.
 *                If there is no thread at all → safe to send.
 *
 *   Layer 3 -- Pre-send re-check
 *              A second fast DOM check runs immediately after typing but
 *              BEFORE pressing Enter, using the same mode-aware logic.
 *
 *   Layer 4 -- URL validation
 *              After navigating to composeUrl, the actual page URL is checked.
 *              A redirect to /feed, /inbox, or any other page aborts the send.
 */

const puppeteer = require("puppeteer-core");
const fs        = require("fs");
const readline  = require("readline");


// ===============================================================================
//  YOUR MESSAGE
//  ─────────────────────────────────────────────────────────────────────────────
//  Customise this for your use case.
//  {firstName} is replaced automatically with the recipient's first name.
//
//  Keep messages concise and personal-feeling. LinkedIn caps messages at
//  ~2000 characters. Shorter messages typically get higher response rates.
// ===============================================================================
const MESSAGE = `Hi,

I hope you're doing well. I am currently exploring opportunities for a Product Manager role and would be keen to be considered if there are any suitable openings within your organisation. I bring 4 years of experience in the Fintech domain, working across both B2B and D2C products. My experience includes driving end-to-end product initiatives such as API integrations, wireframing, and funnel analysis, where I have successfully improved key conversion metrics. I am proficient in Figma and Jira and have hands-on experience collaborating with and leading cross-functional teams. Please review my attached resume, and if you feel I'm a good fit, I would truly appreciate a referral for any suitable opportunity.`;


// ===============================================================================
//  CONFIGURATION
//  ─────────────────────────────────────────────────────────────────────────────
//  ┌──────────────────────────────────────────────────────────────────────────┐
//  │  HOW TO SWITCH MODES                                                    │
//  │                                                                          │
//  │  ONE-SHOT (never re-message):                                           │
//  │    resetProgressDays: 0      ← set this                                 │
//  │                                                                          │
//  │  FOLLOW-UP (re-message after N days, skip only if messaged today):      │
//  │    resetProgressDays: 1      ← daily follow-up                          │
//  │    resetProgressDays: 7      ← weekly newsletter                        │
//  │    resetProgressDays: 30     ← monthly re-engagement                    │
//  │                                                                          │
//  │  That single value controls BOTH the progress-map expiry AND the DOM    │
//  │  check behaviour.  Nothing else needs to be changed.                    │
//  └──────────────────────────────────────────────────────────────────────────┘
// ===============================================================================
const CONFIG = {

  // -- Mode switch --------------------------------------------------------------
  // 0  = ONE-SHOT   : never re-message; DOM check skips if any thread exists.
  // N  = FOLLOW-UP  : re-message after N days; DOM check skips only if
  //                   the most-recent time heading in the thread says "Today".
  resetProgressDays: 0,

  // -- Targeting ----------------------------------------------------------------
  dailyLimit: 200,   // messages to SEND per run (skips don't count)
  bufferSize: 600,   // profiles to collect before the send loop starts

  // -- Timing -------------------------------------------------------------------
  delayBetween:  [8, 20],        // seconds between sent messages [min, max]
  delayScroll:   [1000, 2000],   // ms between scroll actions [min, max]
  domSettleTimeout: 7000,        // ms to wait for DOM to stop mutating

  // -- URLs ---------------------------------------------------------------------
  connectionsUrl: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
  loginUrl:       "https://www.linkedin.com/login",

  // -- Files --------------------------------------------------------------------
  progressFile: "progress.json",
  logFile:      "messenger_log.csv",

  // -- LinkedIn credentials (used only if session has expired) ------------------
  linkedinEmail:    "yourUsername",
  linkedinPassword: "yourPassword",

  // -- Attachment ---------------------------------------------------------------
  // Absolute path to any file you want to attach (PDF resume, brochure, etc.)
  // Set to null or "" to send with no attachment.
  cvPath: "/absolute/path/to/your/file.pdf",

  // -- Chrome executable --------------------------------------------------------
  // macOS  (default):
  chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // Windows (uncomment):
  // chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Linux   (uncomment):
  // chromePath: "/usr/bin/google-chrome",

  // -- Chrome user-data directory -----------------------------------------------
  userDataDir: `${process.env.HOME}/puppeteer-linkedin-profile`,
};


// ===============================================================================
//  UTILITY FUNCTIONS
// ===============================================================================

function randomDelay(minMs, maxMs) {
  return new Promise(r =>
    setTimeout(r, Math.floor(Math.random() * (maxMs - minMs) + minMs))
  );
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function urlKey(rawUrl) {
  try {
    const u = new URL(
      rawUrl.startsWith("http") ? rawUrl : "https://www.linkedin.com" + rawUrl
    );
    const recipient = u.searchParams.get("recipient");
    if (recipient) return `recipient:${recipient}`;
    return u.pathname;
  } catch {
    return rawUrl;
  }
}

function loadProgress() {
  if (!fs.existsSync(CONFIG.progressFile)) return new Map();

  const raw = JSON.parse(fs.readFileSync(CONFIG.progressFile, "utf8"));

  // Auto-migrate legacy array format → { key: timestamp } object
  let data = Array.isArray(raw)
    ? Object.fromEntries(raw.map(k => [k, 0]))
    : raw;

  // Purge expired entries (only when resetProgressDays > 0)
  if (CONFIG.resetProgressDays > 0) {
    const cutoffMs = Date.now() - CONFIG.resetProgressDays * 24 * 60 * 60 * 1000;
    let purged = 0;
    data = Object.fromEntries(
      Object.entries(data).filter(([, ts]) => {
        if (ts === 0)      return true;  // legacy entry — keep forever
        if (ts > cutoffMs) return true;  // within cooldown — keep
        purged++;
        return false;                    // expired — drop
      })
    );
    if (purged > 0) {
      console.log(
        `  Progress reset: ${purged} entr${purged === 1 ? "y" : "ies"} expired ` +
        `after ${CONFIG.resetProgressDays} day(s) — those people are eligible again.\n`
      );
    }
  }

  return new Map(Object.entries(data));
}

function saveProgress(map) {
  const tmp = CONFIG.progressFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
  fs.renameSync(tmp, CONFIG.progressFile);
}

function logResult(name, url, status, note = "") {
  const needsHeader = !fs.existsSync(CONFIG.logFile);
  const timestamp   = new Date().toISOString().replace("T", " ").slice(0, 19);
  const row         = `"${timestamp}","${name}","${url}","${status}","${note}"\n`;
  if (needsHeader) {
    fs.writeFileSync(CONFIG.logFile, `"Timestamp","Name","URL","Status","Note"\n`);
  }
  fs.appendFileSync(CONFIG.logFile, row);
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function humanType(page, selector, text) {
  await page.focus(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomBetween(40, 130) });
  }
}


// ===============================================================================
//  SAFE PAGE EVALUATE
//  Wraps page.evaluate() with automatic retry on context-destruction errors.
//  Extra arguments after maxRetries are forwarded into the page function.
// ===============================================================================

async function safeEvaluate(page, fn, fallback = null, maxRetries = 3, ...fnArgs) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await page.evaluate(fn, ...fnArgs);
    } catch (err) {
      const isContextError =
        err.message?.includes("Execution context was destroyed") ||
        err.message?.includes("Cannot find context")             ||
        err.message?.includes("Target closed");

      if (!isContextError || attempt === maxRetries - 1) return fallback;

      await randomDelay(1500, 3000);
    }
  }
  return fallback;
}


// ===============================================================================
//  DOM STABILITY POLLER
// ===============================================================================

async function waitForDomSettle(page, timeoutMs = CONFIG.domSettleTimeout) {
  const pollMs     = 300;
  const stableGoal = 3;
  const deadline   = Date.now() + timeoutMs;

  let lastLen    = -1;
  let stableHits = 0;

  while (Date.now() < deadline) {
    const len = await safeEvaluate(
      page,
      () => document.body ? document.body.innerHTML.length : 0,
      -1
    );

    if (len !== -1 && len === lastLen) {
      stableHits++;
      if (stableHits >= stableGoal) return;
    } else {
      stableHits = 0;
      lastLen    = len;
    }

    await new Promise(r => setTimeout(r, pollMs));
  }
}


// ===============================================================================
//  MODE-AWARE DOM STATE READER
//  ─────────────────────────────────────────────────────────────────────────────
//
//  ONE-SHOT MODE  (followUpMode === false):
//    Checks for ANY conversation thread.  Even one message bubble = skip.
//    Negative signals (any one triggers skip):
//      A) div.msg-s-message-list
//      B) time.msg-s-message-list__time-heading
//      C) p.msg-s-event-listitem__body
//    safeToSend = true  only when NONE of A, B, C are present.
//
//  FOLLOW-UP MODE  (followUpMode === true):
//    Reads all <time class="msg-s-message-list__time-heading"> elements and
//    checks the text of the LAST one (most recent message date).
//    Skip ONLY when that text is exactly "Today".
//    Examples that mean SAFE TO SEND:
//      "Saturday", "Monday", "April 18", "March 3, 2024", "" (no thread at all)
//    Examples that mean SKIP:
//      "Today"
//    safeToSend = true  when lastTimeHeadingText !== "today" (case-insensitive).
//
//  WHY POSITIVE SIGNALS ARE NOT USED AS A GATE:
//    The "New message" title and recipient typeahead appear on both already-
//    messaged and not-yet-messaged pages — unreliable. Logged for debugging only.
// ===============================================================================

async function readDomState(page) {
  const followUpMode = CONFIG.resetProgressDays > 0;

  const defaultState = {
    hasNewMsgTitle:      false,
    hasRecipientInput:   false,
    hasMsgList:          true,
    hasTimeHeading:      true,
    hasMsgBody:          true,
    lastTimeHeadingText: "",
    messagedToday:       true,
    looksUsed:           true,
    safeToSend:          false,
    mode:                followUpMode ? "follow-up" : "one-shot",
  };

  return await safeEvaluate(
    page,
    (isFollowUp) => {
      // ── Informational (not used in gate) ──────────────────────────────────
      const titleEl = document.querySelector(
        "div.shared-title-bar__title h2, div.msg-title-bar__title-bar-title h2"
      );
      const hasNewMsgTitle =
        titleEl !== null &&
        titleEl.textContent.trim().toLowerCase() === "new message";

      const hasRecipientInput =
        document.querySelector("div.msg-connections-typeahead__added-recipients") !== null;

      // ── Negative signals: conversation thread markers ─────────────────────
      const hasMsgList =
        document.querySelector("div.msg-s-message-list") !== null;

      const hasTimeHeading =
        document.querySelector("time.msg-s-message-list__time-heading") !== null;

      const hasMsgBody =
        document.querySelector("p.msg-s-event-listitem__body") !== null;

      // ── Most-recent time heading text ─────────────────────────────────────
      // querySelectorAll returns elements in DOM order (oldest → newest).
      // We want the LAST one = most recent date label in the thread.
      const timeEls = document.querySelectorAll("time.msg-s-message-list__time-heading");
      const lastTimeHeadingText = timeEls.length > 0
        ? timeEls[timeEls.length - 1].textContent.trim()
        : "";

      const messagedToday = lastTimeHeadingText.toLowerCase() === "today";
      const looksUsed     = hasMsgList || hasTimeHeading || hasMsgBody;

      // ── safeToSend decision ───────────────────────────────────────────────
      let safeToSend;
      if (isFollowUp) {
        // FOLLOW-UP MODE: only block if last message was today.
        // A thread from Saturday / any prior day → allowed (follow-up scenario).
        // No thread at all → allowed.
        safeToSend = !messagedToday;
      } else {
        // ONE-SHOT MODE: block if any thread exists at all.
        safeToSend = !looksUsed;
      }

      return {
        hasNewMsgTitle,
        hasRecipientInput,
        hasMsgList,
        hasTimeHeading,
        hasMsgBody,
        lastTimeHeadingText,
        messagedToday,
        looksUsed,
        safeToSend,
        mode: isFollowUp ? "follow-up" : "one-shot",
      };
    },
    defaultState,
    3,          // maxRetries (positional arg for safeEvaluate)
    followUpMode
  );
}


// ===============================================================================
//  REAL-TIME "ALREADY MESSAGED?" CHECK
// ===============================================================================

async function alreadyMessaged(page, composeUrl) {
  const followUpMode = CONFIG.resetProgressDays > 0;

  try {
    await page.goto(composeUrl, { waitUntil: "domcontentloaded" });

    const actualUrl   = page.url();
    const urlMismatch =
      !actualUrl.includes("messaging/compose") &&
      !actualUrl.includes("messaging/thread");

    if (urlMismatch) {
      process.stdout.write(`[redirect→${actualUrl.slice(0, 40)}] `);
      return true;
    }

    await waitForDomSettle(page);

    const state = await readDomState(page);

    // Build log suffix based on mode
    let logSuffix;
    if (followUpMode) {
      logSuffix = state.lastTimeHeadingText
        ? `last:"${state.lastTimeHeadingText}"`
        : "no-thread";
    } else {
      const negativeHits = [
        state.hasMsgList     ? "msg-list"     : null,
        state.hasTimeHeading ? "time-heading" : null,
        state.hasMsgBody     ? "msg-body"     : null,
      ].filter(Boolean);
      logSuffix = `neg:(${negativeHits.join(",") || "none"})`;
    }

    const verdict = state.safeToSend ? "SAFE" : "SKIP";
    process.stdout.write(`[${verdict} | ${logSuffix}] `);

    return !state.safeToSend;

  } catch (err) {
    process.stdout.write(`[nav-err: ${err.message?.slice(0, 30)}] `);
    return true;
  }
}


// ===============================================================================
//  COLLECT CONNECTIONS
// ===============================================================================

async function collectConnections(page, progressMap) {
  console.log("\nNavigating to connections page...");
  await page.goto(CONFIG.connectionsUrl, { waitUntil: "domcontentloaded" });
  await randomDelay(2000, 4000);

  const connections = [];
  const seenKeys    = new Set();

  let scrollPass        = 0;
  const maxScrolls      = 500;
  const maxStaleScrolls = 100;
  let   noNewInARow     = 0;
  let   prevTotalCards  = 0;
  let   totalCardStale  = 0;
  const SCROLL_STEP     = 600;

  console.log(`Collecting up to ${CONFIG.bufferSize} candidate profiles...\n`);

  const viewport = await safeEvaluate(
    page,
    () => ({ width: window.innerWidth, height: window.innerHeight }),
    { width: 1280, height: 800 }
  );
  await page.mouse.move(viewport.width / 2, viewport.height / 2);

  while (connections.length < CONFIG.bufferSize && scrollPass < maxScrolls) {

    const found = await safeEvaluate(
      page,
      () => {
        const links = document.querySelectorAll('a[aria-label^="Send a message to"]');
        return [...links].map(a => ({
          ariaLabel:   a.getAttribute("aria-label") || "",
          composeHref: a.getAttribute("href")       || "",
        }));
      },
      []
    );

    const totalCards = found.length;
    let addedThisPass = 0;

    for (const { ariaLabel, composeHref } of found) {
      if (!composeHref || !composeHref.includes("messaging/compose")) continue;

      const fullUrl = composeHref.startsWith("http")
        ? composeHref
        : "https://www.linkedin.com" + composeHref;

      const key = urlKey(fullUrl);

      if (seenKeys.has(key))    continue;
      seenKeys.add(key);

      if (progressMap.has(key)) continue;

      const name      = ariaLabel.replace("Send a message to", "").trim();
      const firstName = name.split(" ")[0] || "there";

      connections.push({ name, firstName, composeUrl: fullUrl, key });
      addedThisPass++;

      if (connections.length >= CONFIG.bufferSize) break;
    }

    noNewInARow = addedThisPass === 0 ? noNewInARow + 1 : 0;
    if (totalCards === prevTotalCards) {
      totalCardStale++;
    } else {
      totalCardStale = 0;
      prevTotalCards = totalCards;
    }

    process.stdout.write(
      `  -> ${connections.length}/${CONFIG.bufferSize} collected` +
      ` | scroll #${scrollPass + 1}` +
      ` | cards: ${totalCards}` +
      ` | stale: ${noNewInARow}/${maxStaleScrolls}   \r`
    );

    const prevHeight = await safeEvaluate(page, () => document.body.scrollHeight, 0);

    const ticks = 4;
    for (let t = 0; t < ticks; t++) {
      await page.mouse.wheel({ deltaY: SCROLL_STEP });
      await randomDelay(150, 300);
    }
    await randomDelay(...CONFIG.delayScroll);

    const newHeight = await safeEvaluate(page, () => document.body.scrollHeight, prevHeight);
    if (newHeight <= prevHeight) {
      for (let t = 0; t < 2; t++) {
        await page.mouse.wheel({ deltaY: -300 });
        await randomDelay(120, 240);
      }
      await randomDelay(400, 700);
      for (let t = 0; t < ticks; t++) {
        await page.mouse.wheel({ deltaY: SCROLL_STEP });
        await randomDelay(120, 240);
      }
      await randomDelay(800, 1500);
    }

    const finalHeight  = await safeEvaluate(page, () => document.body.scrollHeight, prevHeight);
    const pageAtBottom = finalHeight <= prevHeight;

    if (pageAtBottom && noNewInARow >= maxStaleScrolls && totalCardStale >= 10) {
      console.log(`\n  End of list — no more profiles.`);
      console.log(`  (DOM cards: ${totalCards} | skipped (prev runs): ${seenKeys.size - connections.length})`);
      break;
    }

    scrollPass++;
  }

  console.log(`\nBuffer ready — ${connections.length} candidates collected.\n`);
  return connections;
}


// ===============================================================================
//  SEND A SINGLE MESSAGE
// ===============================================================================

async function sendMessage(page, connection) {
  const { name, firstName, composeUrl, key } = connection;
  const messageText = MESSAGE.replace(/\{firstName\}/g, firstName);

  try {
    process.stdout.write(`  Messaging ${name}... `);

    // ── Step 1: Mode-aware DOM check ─────────────────────────────────────────
    const conversationExists = await alreadyMessaged(page, composeUrl);
    if (conversationExists) {
      console.log("Skipped");
      logResult(name, composeUrl, "SKIPPED", "blocked by DOM check (pre-type)");
      return { result: "skipped", key };
    }

    await randomDelay(1000, 2000);

    // ── Step 2: Locate message textbox ────────────────────────────────────────
    const msgBoxSelector = [
      "div.msg-form__contenteditable",
      "div[role='textbox']",
      "div[contenteditable='true']",
    ].join(", ");

    await page.waitForSelector(msgBoxSelector, { timeout: 10000 });
    await page.click(msgBoxSelector);
    await randomDelay(500, 1200);

    // ── Step 3: Type message ──────────────────────────────────────────────────
    const lines = messageText.split("\n");
    for (let li = 0; li < lines.length; li++) {
      await page.click(msgBoxSelector);
      if (lines[li].length > 0) {
        await page.keyboard.type(lines[li], { delay: randomBetween(40, 100) });
      }
      if (li < lines.length - 1) {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Shift");
        await randomDelay(80, 180);
      }
    }
    await randomDelay(800, 1800);

    // ── Step 4: PRE-SEND re-check (mode-aware) ────────────────────────────────
    const stateBeforeSend = await readDomState(page);
    if (!stateBeforeSend.safeToSend) {
      await page.click(msgBoxSelector);
      await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.press("a");
      await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.press("Backspace");

      process.stdout.write("[pre-send check failed] ");
      console.log("Skipped");
      logResult(name, composeUrl, "SKIPPED", "blocked by DOM check (pre-send)");
      return { result: "skipped", key };
    }

    // ── Step 5: Attach file (optional) ───────────────────────────────────────
    if (CONFIG.cvPath) {
      try {
        const fileInput = await page.waitForSelector("input[type='file']", {
          timeout: 10000,
          visible: false,
        });
        await fileInput.uploadFile(CONFIG.cvPath);
        process.stdout.write("File attached. ");
        await randomDelay(4000, 7000);
      } catch {
        process.stdout.write("(no attachment) ");
      }
    }

    // ── Step 6: Send ──────────────────────────────────────────────────────────
    await page.click(msgBoxSelector);
    await page.keyboard.press("Enter");
    await randomDelay(1000, 2000);

    console.log("Sent");
    logResult(name, composeUrl, "SENT");
    return { result: "sent", key };

  } catch (err) {
    const note = err.message?.slice(0, 80) || "unknown error";
    console.log(`Failed — ${note}`);
    logResult(name, composeUrl, "FAILED", note);
    return { result: "failed", key };
  }
}


// ===============================================================================
//  AUTO-LOGIN
// ===============================================================================

async function ensureLoggedIn(page, browser) {
  console.log("Checking login status...");
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await randomDelay(2000, 3000);

  if (page.url().includes("/feed")) {
    console.log("Already logged in — session still active!\n");
    return;
  }

  console.log("Session expired. Starting auto-login...\n");
  await page.goto(CONFIG.loginUrl, { waitUntil: "domcontentloaded" });
  await randomDelay(1500, 2500);

  console.log("  Typing email...");
  await page.waitForSelector("#username", { timeout: 10000 });
  await humanType(page, "#username", CONFIG.linkedinEmail);
  await randomDelay(500, 1000);

  console.log("  Typing password...");
  await page.waitForSelector("#password", { timeout: 10000 });
  await humanType(page, "#password", CONFIG.linkedinPassword);
  await randomDelay(600, 1200);

  console.log("  Clicking Sign in...");
  await page.click("button[aria-label='Sign in'][type='submit']");

  console.log("  Waiting for response...");
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await randomDelay(2000, 3500);

  const postLoginUrl = page.url();
  console.log(`  Landed on: ${postLoginUrl}\n`);

  if (postLoginUrl.includes("/feed")) {
    console.log("Logged in successfully!\n");

  } else if (
    postLoginUrl.includes("/checkpoint") ||
    postLoginUrl.includes("/challenge")  ||
    postLoginUrl.includes("/authwall")
  ) {
    console.log("LinkedIn requires identity verification.");
    console.log("   Complete the steps in the Chrome window (OTP / CAPTCHA).\n");
    await waitForEnter("   Once you see the feed, press ENTER to continue...\n");

    if (!page.url().includes("/feed")) {
      console.log("Still not on feed. Closing in 5s...");
      await randomDelay(5000, 5000);
      await browser.close();
      process.exit(1);
    }
    console.log("Verification passed!\n");

  } else if (postLoginUrl.includes("/login")) {
    console.log("Login failed. Check CONFIG.linkedinEmail and CONFIG.linkedinPassword.");
    await browser.close();
    process.exit(1);

  } else {
    console.log(`Unexpected URL: ${postLoginUrl}`);
    await waitForEnter("   If logged in press ENTER, or Ctrl+C to abort...\n");
  }
}


// ===============================================================================
//  MAIN
// ===============================================================================

(async () => {

  const progressMap  = loadProgress();
  const followUpMode = CONFIG.resetProgressDays > 0;

  console.log("============================================");
  console.log("      LinkedIn Connection Messenger          ");
  console.log("============================================\n");
  console.log(`Mode                  : ${followUpMode ? `FOLLOW-UP (every ${CONFIG.resetProgressDays} day(s))` : "ONE-SHOT (never re-message)"}`);
  console.log(`Previously messaged   : ${progressMap.size}`);
  console.log(`Send target this run  : ${CONFIG.dailyLimit} messages`);
  console.log(`Collection buffer     : ${CONFIG.bufferSize} profiles`);
  console.log(`DOM settle timeout    : ${CONFIG.domSettleTimeout}ms`);
  console.log("");
  console.log("   Duplicate-send protection layers:");
  console.log("   1. progress.json  — skip keys seen within the cooldown window");
  if (followUpMode) {
    console.log("   2. DOM (FOLLOW-UP) — skip if most-recent time heading = \"Today\"");
    console.log("                        allow if thread exists but last msg was a prior day");
  } else {
    console.log("   2. DOM (ONE-SHOT)  — skip if msg-list / time-heading / msg-body found");
  }
  console.log("   3. Pre-send check — re-read DOM after typing, before Enter");
  console.log("   4. URL validation — abort if LinkedIn redirected away\n");

  console.log("Launching Chrome...\n");
  const browser = await puppeteer.launch({
    executablePath:  CONFIG.chromePath,
    userDataDir:     CONFIG.userDataDir,
    headless:        false,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const pages = await browser.pages();
  const page  = pages[0] || await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await ensureLoggedIn(page, browser);

  const candidates = await collectConnections(page, progressMap);

  if (candidates.length === 0) {
    console.log("No new connections found. Exiting.");
    await browser.close();
    return;
  }

  console.log("-".repeat(52));
  console.log(`Send loop — target: ${CONFIG.dailyLimit} sent (skips don't count)`);
  console.log("-".repeat(52) + "\n");

  let sent    = 0;
  let skipped = 0;
  let failed  = 0;

  for (let i = 0; i < candidates.length; i++) {

    if (sent >= CONFIG.dailyLimit) {
      console.log(`\nTarget of ${CONFIG.dailyLimit} reached!`);
      break;
    }

    const conn            = candidates[i];
    const { result, key } = await sendMessage(page, conn);

    if (result === "sent") {
      sent++;
      progressMap.set(key, Date.now());
      saveProgress(progressMap);

    } else if (result === "skipped") {
      skipped++;
      progressMap.set(key, Date.now());
      saveProgress(progressMap);

    } else {
      failed++;
      // failed keys NOT saved — retried on next run
    }

    console.log(
      `  [${i+1}/${candidates.length}]` +
      ` Sent:${sent}/${CONFIG.dailyLimit}` +
      ` Skipped:${skipped}` +
      ` Failed:${failed}` +
      ` Need:${CONFIG.dailyLimit - sent}`
    );

    if (result === "sent" && sent < CONFIG.dailyLimit) {
      const waitSecs = randomBetween(...CONFIG.delayBetween);
      console.log(`  Waiting ${waitSecs.toFixed(1)}s...\n`);
      await new Promise(r => setTimeout(r, waitSecs * 1000));
    }
  }

  if (sent < CONFIG.dailyLimit) {
    console.log(`\nRan out of candidates. Sent ${sent}/${CONFIG.dailyLimit}.`);
    console.log(`   Increase CONFIG.bufferSize (${CONFIG.bufferSize}) for more profiles.`);
  }

  console.log("\n" + "=".repeat(52));
  console.log("Run complete!");
  console.log(`   Sent        : ${sent}`);
  console.log(`   Skipped     : ${skipped}`);
  console.log(`   Failed      : ${failed}`);
  console.log(`   Total ever  : ${progressMap.size}`);
  console.log(`   Log         : ${CONFIG.logFile}`);
  console.log("=".repeat(52) + "\n");

  await waitForEnter("Press ENTER to close the browser...");
  await browser.close();
})();