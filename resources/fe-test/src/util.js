const os = require("os");
const { Builder, Browser, By, Key, until } = require("selenium-webdriver");
const HALF_SECOND = 500;
const WAIT_ITERATIONS = 100;

async function wait(driver, secs) {
  const actions = driver.actions({ async: true });
  await actions.pause(secs * 1000).perform();
}

function byExactText(str) {
  return By.xpath(`//*[text()='${str}']`);
}

function byAttribute(attr, val, sub) {
  if (!sub) {
    sub = "";
  }
  return By.xpath(`//*[@${attr}='${val}']${sub}`);
}

function byElementAndAttribute(element, attr, val) {
  return By.xpath(`//${element}[@${attr}='${val}']`);
}

async function sendEnter(element) {
  await element.sendKeys(Key.ENTER);
}

async function waitEnabled(driver, element) {
  const actions = driver.actions({ async: true });
  for (var i = 0; i < WAIT_ITERATIONS && !element.isEnabled(); i++) {
    await actions.pause(HALF_SECOND).perform();
  }
}

/// waitAriaDisabledState:
///     pass desired_state="enabled" to wait for an element to become enabled.
///     pass desired_state != "enabled" to wait for an element to become disabled.
async function waitAriaDisabledState(driver, element, desired_state) {
  const actions = driver.actions({ async: true });
  for (let i = 0; i < WAIT_ITERATIONS; i++) {
    const shouldExit = await element.getAttribute("aria-disabled");
    if (desired_state == "enabled") {
      if (shouldExit.toString() !== "true") {
        return;
      }
    } else {
      if (shouldExit.toString() == "true") {
        return;
      }
    }
    await actions.pause(HALF_SECOND).perform();
  }
  throw new Error("failed to wait for enabled element");
}

async function waitAriaEnabled(driver, element) {
  return await waitAriaDisabledState(driver, element, "enabled");
}

async function waitAriaDisabled(driver, element) {
  return await waitAriaDisabledState(driver, element, "disabled");
}

async function selectSimulator(driver) {
  const controlMenu = await driver.wait(
    until.elementLocated(byAttribute("aria-label", "control-menu")),
  );
  await controlMenu.click();

  const simulatorButton = await driver.wait(
    until.elementLocated(byAttribute("aria-label", "select-simulator")),
  );
  await simulatorButton.click();
}

async function waitForNonError(driver, select, extra, time) {
  let stopButton = null;
  for (var i = 0; i < WAIT_ITERATIONS; i++) {
    try {
      stopButton = await select();
      await extra(stopButton);
      break;
    } catch (e) {
      console.log("waiting for stop button got stale ref", i, e);
    }
    await wait(driver, time);
  }
  if (!stopButton) {
    throw new Error(`could not select an element in ${WAIT_ITERATIONS}`);
  }
  return stopButton;
}

async function sendControlChar(driver, char) {
  const actions = driver.actions({ async: true });
  if (os.platform() === "darwin") {
    await actions
      .pause(2000)
      .keyDown(Key.COMMAND)
      .sendKeys(char)
      .keyUp(Key.COMMAND)
      .pause(500)
      .perform();
  } else {
    await actions
      .pause(2000)
      .keyDown(Key.CONTROL)
      .sendKeys(char)
      .keyUp(Key.CONTROL)
      .pause(500)
      .perform();
  }
}

async function sendControlA(driver) {
  await sendControlChar(driver, "a");
}

module.exports = {
  wait,
  byExactText,
  byAttribute,
  byElementAndAttribute,
  sendEnter,
  waitEnabled,
  selectSimulator,
  waitAriaEnabled,
  waitAriaDisabled,
  waitForNonError,
  sendControlChar,
  sendControlA,
};
