import { until, By } from "selenium-webdriver";

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const POLL_MS = 500;

export function log(role, msg) {
  console.log(`[e2e:${role}] ${msg}`);
}

export function fail(role, msg) {
  console.error(`[e2e:${role}] FAIL: ${msg}`);
  process.exit(1);
}

export async function waitFor(driver, condition, timeoutMs = DEFAULT_TIMEOUT_MS, label = "condition") {
  try {
    return await driver.wait(condition, timeoutMs, label);
  } catch (err) {
    throw new Error(`${label} timed out after ${timeoutMs}ms: ${err.message}`);
  }
}

export async function waitVisible(driver, locator, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return waitFor(
    driver,
    until.elementLocated(locator),
    timeoutMs,
    `visible: ${locator}`,
  );
}

export async function waitClickable(driver, locator, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const el = await waitVisible(driver, locator, timeoutMs);
  await waitFor(
    driver,
    until.elementIsEnabled(el),
    timeoutMs,
    `clickable: ${locator}`,
  );
  return el;
}

export async function clickWhenReady(driver, locator, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const el = await waitClickable(driver, locator, timeoutMs);
  await el.click();
}

export async function clickByTestId(driver, testId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await clickWhenReady(driver, By.css(`[data-testid="${testId}"]`), timeoutMs);
}

export async function typeInto(driver, locator, text, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const el = await waitClickable(driver, locator, timeoutMs);
  await el.clear();
  await el.sendKeys(text);
}

export async function clickTab(driver, label) {
  const buttons = await driver.findElements(By.xpath(`//button[normalize-space()="${label}"]`));
  for (const btn of buttons) {
    if (await btn.isDisplayed()) {
      await btn.click();
      return;
    }
  }
  throw new Error(`Tab not found: ${label}`);
}

export async function switchToLobbyFrame(driver) {
  await driver.switchTo().defaultContent();
  const frame = await waitVisible(driver, By.css("#tracker-iframe"));
  await driver.switchTo().frame(frame);
}

export async function switchToMain(driver) {
  await driver.switchTo().defaultContent();
}

export async function dismissOverlays(driver, role) {
  await switchToMain(driver);
  for (let i = 0; i < 8; i++) {
    const dismissButtons = await driver.findElements(
      By.xpath("//button[normalize-space()='Dismiss']"),
    );
    let clicked = false;
    for (const btn of dismissButtons) {
      try {
        if (await btn.isDisplayed() && await btn.isEnabled()) {
          await btn.click();
          clicked = true;
          log(role, "dismissed overlay");
          await driver.sleep(300);
        }
      } catch {
        // stale element; continue
      }
    }
    if (!clicked) break;
  }
}

export async function maybeClick(driver, locator) {
  const els = await driver.findElements(locator);
  for (const el of els) {
    try {
      if (await el.isDisplayed() && await el.isEnabled()) {
        await el.click();
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export async function playCardSelectionIfNeeded(driver, role) {
  await switchToMain(driver);
  await dismissOverlays(driver, role);

  const playBtn = await driver.findElements(
    By.xpath("//button[contains(normalize-space(),'Play Selected Cards') or contains(normalize-space(),'Select 4 cards')]"),
  );
  for (const btn of playBtn) {
    if (!(await btn.isDisplayed())) continue;
    if (!(await btn.isEnabled())) {
      const cards = await driver.findElements(By.css('[data-card-id^="my-"]'));
      let picked = 0;
      for (const card of cards) {
        if (picked >= 4) break;
        try {
          if (await card.isDisplayed() && await card.isEnabled()) {
            await card.click();
            picked++;
            await driver.sleep(100);
          }
        } catch {
          // continue
        }
      }
      if (picked >= 4 && await btn.isEnabled()) {
        await btn.click();
        log(role, "submitted card selection");
        return true;
      }
      return false;
    }
    await btn.click();
    log(role, "clicked play/move button");
    return true;
  }
  return false;
}

export async function waitForBetweenHands(driver, role, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await waitFor(
    driver,
    async () => {
      await switchToMain(driver);
      const newHand = await driver.findElements(By.xpath("//button[normalize-space()='New Hand']"));
      for (const btn of newHand) {
        if (await btn.isDisplayed()) return true;
      }
      return false;
    },
    timeoutMs,
    "between-hands (New Hand visible)",
  );
  log(role, "hand complete — between-hands UI visible");
}

export async function performCleanShutdown(driver, role, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await switchToMain(driver);
  await clickTab(driver, "Game");
  await dismissOverlays(driver, role);

  // End Session lives in compose-proposal mode; reach it via Close from decision mode.
  const closed = await maybeClick(
    driver,
    By.css('[data-testid="between-hand-close"]'),
  );
  if (closed) {
    log(role, "opened compose-proposal via Close");
    await driver.sleep(500);
  }

  await clickByTestId(driver, "end-session", timeoutMs);
  log(role, "clicked End Session");

  await waitFor(
    driver,
    async () => {
      await switchToMain(driver);
      const idle = await driver.findElements(
        By.xpath("//*[contains(normalize-space(),'No active game session')]"),
      );
      for (const el of idle) {
        if (await el.isDisplayed()) return true;
      }
      const resolved = await driver.findElements(
        By.xpath("//*[contains(normalize-space(),'Resolved')]"),
      );
      for (const el of resolved) {
        if (await el.isDisplayed()) return true;
      }
      return false;
    },
    timeoutMs,
    "session resolved / idle",
  );
  log(role, "clean shutdown complete");
}
