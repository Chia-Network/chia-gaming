const os = require("os");
const { Builder, Browser, By, Key, until } = require("selenium-webdriver");
const HALF_SECOND = 500;
const WAIT_ITERATIONS = 100;
const ADDRESS_RETRIES = 30;

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

function byAttributePrefix(attr, val) {
  return By.xpath(`//*[starts-with(@${attr},'${val}')]`);
}

function byElementAndAttribute(element, attr, val) {
  return By.xpath(`//${element}[@${attr}='${val}']`);
}

async function sendEnter(element) {
  await element.sendKeys(Key.ENTER);
}

async function waitEnabled(driver, element) {
  const actions = driver.actions({ async: true });
  for (var i = 0; i < WAIT_ITERATIONS; i++) {
    const enabled = await element.isEnabled();
    if (enabled) {
      return;
    }
    await actions.pause(HALF_SECOND).perform();
  }

  throw new Error('too many iterations waiting for enabled on element');
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
  console.log('finding simulator button');
  const simulatorButton = await driver.wait(
    until.elementLocated(byAttribute("aria-label", "select-simulator")),
  );
  console.log('clicking simulator button');
  await simulatorButton.click();
  console.log('done selecting wallet');
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
      stopButton = null;
    }
    await wait(driver, time);
  }
  if (!stopButton) {
    throw new Error(`could not select an element in ${WAIT_ITERATIONS}`);
  }
  return stopButton;
}

async function selectWalletConnect(driver) {
  const linkWalletButton = await driver.wait(
    until.elementLocated(byExactText("Link Wallet")),
  );
  await linkWalletButton.click();

  await wait(driver, 5.0);

  const wcUriBox = await driver.wait(
    until.elementLocated(
      byAttribute("aria-label", "wallet-connect-uri", "//textarea"),
    ),
  );
  const wcUri = await wcUriBox.getAttribute("value");
  console.log("wcUri", wcUri);

  const rng = Math.floor(Math.random() * 1000000);
  await fetch("http://localhost:3002/pair", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pairdata: wcUri,
      fingerprints: [rng],
    }),
  }).then((res) => res.json());

  await waitForNonError(
    driver,
    () => driver.wait(until.elementLocated(byAttribute("id", "subframe"))),
    (elt) => {},
    5.0,
  );
}

async function retrieveAddress(driver) {
  for (let i = 0; i < ADDRESS_RETRIES; i++) {
    const addressElt = await driver.wait(
      until.elementLocated(byAttribute("id", "blockchain-address")),
    );
    const text = await addressElt.getAttribute("textContent");
    try {
      const decoded = JSON.parse(text);
      if (decoded.address !== "" && decoded.puzzleHash !== "") {
        return decoded;
      }
    } catch (e) {
      await wait(driver, 1.0);
    }
  }

  throw new Error("Too many retries getting blockchain address");
}

async function getBalance(driver, puzzleHash) {
  return await fetch(`http://localhost:5800/get_balance?user=${puzzleHash}`, {
    method: "POST",
  }).then((res) => res.json());
}

function numberOrContainer(v) {
  const keys = Object.keys(v);
  if (keys.length !== 0) {
    return v[keys[0]];
  }
  return v;
}

function extractValue(handType, i) {
  const v = handType.values[i];
  return numberOrContainer(v);
}

// Determine whether the given finalCards can yield the given hand type.
function checkHandValueDescriptionVsHand(handType, finalCards) {
  // Sort by rank.
  const cardsByRank = finalCards.sort((a, b) => a[0] - b[0]);
  // We'll have a list of ranks.
  switch (handType.name) {
    case 'Flush':
      // We must have all matching suits.
      for (let c of finalCards) {
        if (c[1] !== extractValue(handType, 0)) {
          return false;
        }
      }
      break;

    case 'Straight flush':
    case 'Straight':
      // We must have 5 cards whose high card is the indicated value.
      let wantValue = extractValue(handType, 0) - 4;
      for (let c of cardsByRank) {
        console.log('straight', c[0], wantValue);
        if (c[0] !== wantValue) {
          return false;
        }
        wantValue += 1;
      }

      // Must be 5 the same suit.
      let suit = cardsByRank[0][1];
      if (handType.name === 'Straight flush') {
        for (let c of cardsByRank) {
          if (c[1] !== suit) {
            return false;
          }
        }
      }
      break;

    case 'Three of a kind':
    case 'Four of a kind':
    case 'Pair':
      // We must have 3 cards at the indicated rank.
      let count = 0;
      for (let c of cardsByRank) {
        if (c[0] === extractValue(handType, 0)) {
          count++;
        }
      }
      let expectedCount = handType.name === 'Pair' ? 2 : handType.name === 'Three of a kind' ? 3 : 4;
      return count === expectedCount;

    case 'Two pairs':
    case 'Full house': {
      // We must match the first 2 ranks.
      let counts = [0, 0, 0];
      for (let c of cardsByRank) {
        handType.values.map(numberOrContainer).forEach((v, i) => {
          if (c[0] === v) {
            counts[i] += 1;
          }
        });
      }
      let firstMatch = handType.name === 'Two pairs' ? 2 : 3;
      return counts[0] === firstMatch && counts[1] === 2;
    }

    case 'High card': {
      let wantValue = extractValue(handType, 0);
      let count = 0;
      for (let c of cardsByRank) {
        if (c[0] == wantValue) {
          count += 1;
        }
      }
      return count === 1;
    }
  }

  return true;
}

async function getHandDescription(driver, label) {
  const element = await driver.wait(until.elementLocated(byAttribute('aria-label', label)));
  const handDescription = await element.getAttribute('data-hand-description');
  return JSON.parse(handDescription);
}

// We might have extra symbols that will be considered for each suit here.
const suitsByName = {
  '♠': 1,
  '♥': 2,
  '♦': 3,
  '♣': 4
};

const ranksByName = {
  'A': 14,
  'K': 13,
  'Q': 12,
  'J': 11,
  'T': 10
};

function constructGameStyleCard(cardString) {
  // The card has a suit (> 256 unicode codepoint) and some other data.
  // if the other data is a number, then it becomes the rank, otherwise we have
  // a table to match it.
  const rank = cardString.slice(0, cardString.length - 1);
  const suit = cardString.slice(cardString.length - 1);
  console.log('gameStyleCard', rank, suit);
  let recognizedSuit = suitsByName[suit];
  let recognizedRank = ranksByName[rank];
  if (!recognizedSuit) {
    throw new Error(`unrecognized suit ${suit}`);
  }
  if (!recognizedRank) {
    recognizedRank = parseInt(rank);
  }
  return [recognizedRank, recognizedSuit];
}

function constructGameStyleCards(cardList) {
  return cardList.map(constructGameStyleCard);
}

function checkCardsInLog(handDescription, cards) {
  if (!checkHandValueDescriptionVsHand(
    handDescription,
    cards
  )) {
    const message = 'Bad cards given for hand';
    console.error(message, handDescription, cards);
    throw new Error(message);
  }
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

async function sendControlM(driver) {
  await sendControlChar(driver, "m");
}

module.exports = {
  wait,
  byExactText,
  byAttribute,
  byElementAndAttribute,
  byAttributePrefix,
  sendEnter,
  waitEnabled,
  selectSimulator,
  selectWalletConnect,
  retrieveAddress,
  getBalance,
  waitAriaEnabled,
  waitAriaDisabled,
  waitForNonError,
  sendControlChar,
  sendControlA,
  sendControlM,
  getHandDescription,
  checkCardsInLog,
  constructGameStyleCards,
};
