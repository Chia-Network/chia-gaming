import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import {
  DEFAULT_TIMEOUT_MS,
  log,
  fail,
  waitFor,
  waitClickable,
  clickByTestId,
  typeInto,
  clickTab,
  switchToLobbyFrame,
  switchToMain,
  dismissOverlays,
  maybeClick,
  playCardSelectionIfNeeded,
  waitForBetweenHands,
  performCleanShutdown,
  POLL_MS,
} from "./lib/wait.mjs";

const ROLE = (process.env.ROLE || "").toLowerCase();
const PLAYER_URL = process.env.PLAYER_URL || "http://server:3002";
const TRACKER_URL = process.env.TRACKER_URL || "http://server:3003";
const OPPONENT_NAME = process.env.OPPONENT_NAME || (ROLE === "alice" ? "Bob" : "Alice");
const ALIAS = process.env.ALIAS || (ROLE === "alice" ? "Alice" : "Bob");
const SELENIUM_URL = process.env.SELENIUM_URL || "http://127.0.0.1:4444/wd/hub";

if (ROLE !== "alice" && ROLE !== "bob") {
  fail(ROLE || "unknown", `ROLE must be alice or bob, got: ${process.env.ROLE}`);
}

async function connectSimulator(driver) {
  await maybeClick(driver, By.xpath("//button[normalize-space()='Start over']"));
  await waitClickable(
    driver,
    By.xpath("//button[contains(normalize-space(),'Continue with Simulator')]"),
  ).then((el) => el.click());
  await clickByTestId(driver, "sim-connect");
  await waitFor(
    driver,
    until.elementLocated(By.xpath("//*[contains(normalize-space(),'Connected')]")),
    DEFAULT_TIMEOUT_MS,
    "simulator connected",
  );
  log(ROLE, "simulator connected");
}

async function connectTracker(driver) {
  await clickTab(driver, "Tracker");
  await typeInto(driver, By.css('[data-testid="tracker-url"]'), TRACKER_URL);
  await clickByTestId(driver, "tracker-connect");
  await waitFor(
    driver,
    until.elementLocated(By.css("#tracker-iframe")),
    DEFAULT_TIMEOUT_MS,
    "tracker iframe",
  );
  log(ROLE, "tracker connected");
}

async function joinLobby(driver) {
  await switchToLobbyFrame(driver);
  await typeInto(driver, By.css('[data-testid="lobby-alias"]'), ALIAS);
  await clickByTestId(driver, "lobby-join");
  await waitFor(
    driver,
    async () => {
      const body = await driver.findElement(By.css("body")).getText();
      return body.includes("Connected Players") || body.includes(ALIAS);
    },
    DEFAULT_TIMEOUT_MS,
    "lobby joined",
  );
  log(ROLE, `joined lobby as ${ALIAS}`);
}

async function aliceChallenge(driver) {
  await switchToLobbyFrame(driver);
  await waitFor(
    driver,
    async () => {
      const body = await driver.findElement(By.css("body")).getText();
      return body.includes(OPPONENT_NAME);
    },
    DEFAULT_TIMEOUT_MS,
    `opponent ${OPPONENT_NAME} in lobby`,
  );
  const challengeButtons = await driver.findElements(By.css('[data-testid="lobby-challenge"]'));
  for (const btn of challengeButtons) {
    if (await btn.isDisplayed() && await btn.isEnabled()) {
      await btn.click();
      break;
    }
  }
  await clickByTestId(driver, "lobby-send-challenge");
  log(ROLE, `challenged ${OPPONENT_NAME}`);
  await switchToMain(driver);
}

async function bobAcceptChallenge(driver) {
  await switchToLobbyFrame(driver);
  await waitFor(
    driver,
    until.elementLocated(By.css('[data-testid="lobby-accept"]')),
    DEFAULT_TIMEOUT_MS,
    "incoming challenge accept button",
  );
  await clickByTestId(driver, "lobby-accept");
  log(ROLE, "accepted challenge");
  await switchToMain(driver);
}

async function waitForGameSession(driver) {
  await waitFor(
    driver,
    async () => {
      await switchToMain(driver);
      const body = await driver.findElement(By.css("body")).getText();
      return (
        body.includes("Setting up channel") ||
        body.includes("Propose terms") ||
        body.includes("Send Proposal") ||
        body.includes("Do you want to accept")
      );
    },
    DEFAULT_TIMEOUT_MS,
    "game session started",
  );
  await clickTab(driver, "Game");
  log(ROLE, "game session visible");
}

async function dismissUntilActive(driver) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await dismissOverlays(driver, ROLE);
    await switchToMain(driver);
    const body = await driver.findElement(By.css("body")).getText();
    if (
      body.includes("Propose terms") ||
      body.includes("Send Proposal") ||
      body.includes("Do you want to accept") ||
      body.includes("Select 4 cards") ||
      body.includes("Play Selected Cards") ||
      body.includes("New Hand")
    ) {
      return;
    }
    await driver.sleep(POLL_MS);
  }
  throw new Error("timed out waiting for channel to become active");
}

async function aliceSendProposal(driver) {
  await dismissUntilActive(driver);
  await clickByTestId(driver, "send-proposal");
  log(ROLE, "sent game proposal");
}

async function bobAcceptProposal(driver) {
  await dismissUntilActive(driver);
  await waitFor(
    driver,
    until.elementLocated(By.css('[data-testid="accept-proposal"]')),
    DEFAULT_TIMEOUT_MS,
    "accept proposal button",
  );
  await clickByTestId(driver, "accept-proposal");
  log(ROLE, "accepted game proposal");
}

async function playHand(driver) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await dismissOverlays(driver, ROLE);
    await playCardSelectionIfNeeded(driver, ROLE);
    await switchToMain(driver);
    const body = await driver.findElement(By.css("body")).getText();
    if (body.includes("New Hand")) {
      log(ROLE, "detected New Hand during play loop");
      return;
    }
    if (body.includes("Winner!") || body.includes("Win") || body.includes("Lose") || body.includes("Tie")) {
      await driver.sleep(2000);
    }
    await driver.sleep(500);
  }
  throw new Error("timed out during calpoker hand");
}

async function main() {
  log(ROLE, `starting E2E (player=${PLAYER_URL} tracker=${TRACKER_URL})`);

  const options = new chrome.Options();
  options.addArguments("--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu");

  const driver = await new Builder()
    .forBrowser("chrome")
    .usingServer(SELENIUM_URL)
    .setChromeOptions(options)
    .build();

  driver.manage().setTimeouts({ implicit: 0, pageLoad: 120000, script: 60000 });

  try {
    await driver.get(PLAYER_URL);
    log(ROLE, "loaded player app");

    await connectSimulator(driver);
    await connectTracker(driver);
    await joinLobby(driver);
    await switchToMain(driver);

    if (ROLE === "alice") {
      await aliceChallenge(driver);
    } else {
      await bobAcceptChallenge(driver);
    }

    await waitForGameSession(driver);
    await dismissUntilActive(driver);

    if (ROLE === "alice") {
      await aliceSendProposal(driver);
    } else {
      await bobAcceptProposal(driver);
    }

    await playHand(driver);
    await waitForBetweenHands(driver, ROLE);
    await performCleanShutdown(driver, ROLE);

    log(ROLE, "PASS");
  } catch (err) {
    console.error(`[e2e:${ROLE}] ERROR:`, err);
    try {
      const screenshot = await driver.takeScreenshot();
      console.log(`[e2e:${ROLE}] screenshot(base64): ${screenshot.slice(0, 80)}...`);
    } catch {
      // ignore
    }
    fail(ROLE, err.message || String(err));
  } finally {
    await driver.quit();
  }
}

main();
