// Require modules used in the logic below
const jasmine = require("jasmine");
const fs = require("fs");
const os = require("os");
const { spawn } = require("node:child_process");
const {
  Builder,
  Browser,
  By,
  Key,
  WebDriver,
  until,
} = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const firefox = require("selenium-webdriver/firefox");
const {
  wait,
  byExactText,
  byAttribute,
  byElementAndAttribute,
  sendEnter,
  waitAriaEnabled,
  waitEnabled,
  waitAriaDisabled,
  selectSimulator,
  selectWalletConnect,
  waitForNonError,
  sendControlA,
  sendControlM,
  retrieveAddress,
  getBalance,
  checkCardsInLog,
  getHandDescription,
  constructGameStyleCards,
} = require("./util.js");

// Other browser
const geckodriver = require("geckodriver");

function makeFirefox() {
  const options1 = new firefox.Options();
  if (process.env.FIREFOX_HEADLESS) {
    options1.addArguments("-headless");
  }
  if (process.env.FIREFOX) {
    options1.setBinary(process.env.FIREFOX);
  }
  const handler = new Builder()
    .forBrowser(Browser.FIREFOX)
    .setFirefoxOptions(options1)
    .build();

  return handler;
}

function makeChrome() {
  const options1 = new chrome.Options();
  // Use headless and safe flags when requested; avoid forcing remote debugging
  // which can cause renderer connection failures in some environments.
  if (process.env.CHROME_HEADLESS) {
    // New headless mode for modern Chrome
    options1.addArguments("--headless=new");
    options1.addArguments("--no-sandbox");
    options1.addArguments("--disable-dev-shm-usage");
    options1.addArguments("--disable-gpu");
  }

  // You can use a remote Selenium Hub, but we are not doing that here
  // require("chromedriver");
  // Allow specifying a custom Chrome binary via environment variable.
  if (process.env.CHROME) {
    options1.setBinary(process.env.CHROME);
  }
  const handler = new Builder()
    .forBrowser(Browser.CHROME)
    .setChromeOptions(options1)
    .build();

  return handler;
}

const handler1 = makeChrome();
const handler2 = makeFirefox();

afterAll(() => {
  if (handler1) {
    handler1.quit();
  }
  if (handler2) {
    handler2.quit();
  }
});

async function clickMakeMove(handler, who, label) {
  console.log(`click make move ${who}, ${label}`);
  await wait(handler, 5.0);
  const makeMoveButton = await handler.wait(
    until.elementLocated(byExactText(label))
  );

  console.log("have enabled, clicking button");
  await makeMoveButton.click();
}

async function clickPopupButton(handler, buttonText) {
  // Fallback: locate the popup container then the button by visible text
  try {
    // Try current context first
    try {
      const popup = await handler.wait(
        until.elementLocated(By.css("div.fixed.inset-0.z-50")),
        8000
      );
      const button = await popup.findElement(
        By.xpath(`.//button[normalize-space(text())='${buttonText}']`)
      );
      await handler.wait(until.elementIsVisible(button), 3000);
      await handler.wait(until.elementIsEnabled(button), 3000);
      await handler.executeScript(
        'arguments[0].scrollIntoView({block:"center"});',
        button
      );
      await handler
        .actions({ async: true })
        .move({ origin: button })
        .click()
        .perform();
      console.log(`Clicked ${buttonText} via popup container`);
      return;
    } catch (e) {
      // try top-level document
      await handler.switchTo().defaultContent();
      const popup = await handler.wait(
        until.elementLocated(By.css("div.fixed.inset-0.z-50")),
        8000
      );
      const button = await popup.findElement(
        By.xpath(`.//button[normalize-space(text())='${buttonText}']`)
      );
      await handler.wait(until.elementIsVisible(button), 3000);
      await handler.wait(until.elementIsEnabled(button), 3000);
      await handler.executeScript(
        'arguments[0].scrollIntoView({block:"center"});',
        button
      );
      await handler
        .actions({ async: true })
        .move({ origin: button })
        .click()
        .perform();
      // switch back to subframe if needed
      try {
        await handler.switchTo().frame("subframe");
      } catch (ee) {}
      console.log(`Clicked ${buttonText} via popup container (top-level)`);
      return;
    }
  } catch (err) {
    console.error("Popup button not found or clickable:", err);
    try {
      const src = await handler.getPageSource();
      fs.writeFileSync("debug_accept_page.html", src);
    } catch (e2) {
      console.error("could not write page source", e2);
    }
    try {
      const shot = await handler.takeScreenshot();
      fs.writeFileSync("debug_accept.png", shot, "base64");
    } catch (e3) {
      console.error("could not take screenshot", e3);
    }
    throw err;
  }
}

async function firefox_start_and_first_move(selectWallet, handler, baseUrl) {
  console.log("firefox start", baseUrl, handler);
  await handler.get(baseUrl);

  await selectWallet(handler);

  await handler.wait(until.elementLocated(byAttribute("id", "subframe")));

  await handler.switchTo().frame("subframe");

  console.log("Wait for Accept Invite");

  await clickPopupButton(handler, "Accept & Join");

  console.log("Clicked Accept & Join");
  console.log("Wait for handshake on bob side");
  await handler.wait(
    until.elementLocated(byAttribute("aria-label", "waiting-state"))
  );

  console.log("Wait for the make move button");
  await clickMakeMove(handler, "bob", "Start Game");

  console.log("Bob passing back to alice");
  return handler;
}

const cardNumericRanks = {
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};
function isCardRank(ch) {
  return (ch >= "0" && ch <= "9") || cardNumericRanks[ch];
}

async function getCardText(handler, card) {
  const rawText = await card.getAttribute("textContent");
  const result = [];
  let accum = "";
  let state = 0;

  function pushCard(c) {
    Object.keys(cardNumericRanks).forEach((r) => {
      c = c.replace(r, cardNumericRanks[r]);
    });
    result.push(c);
  }

  for (let ch of rawText) {
    switch (state) {
      case 0:
        if (ch.charCodeAt(0) > 255) {
          state = 1;
        }
        accum += ch;
        break;

      case 1:
        if (isCardRank(ch)) {
          pushCard(accum);
          accum = ch;
          state = 0;
          break;
        }

        accum += ch;
        break;
    }
  }

  if (accum.length) {
    pushCard(accum);
  }

  return result;
}

async function clickFourCards(handler, who, picks) {
  await handler.wait(
    until.elementLocated(byAttribute("data-card-id", `player-0`))
  );
  const resultCards = [];

  for (let i = 0; i < 8; i++) {
    const card = await handler.wait(
      until.elementLocated(byAttribute("data-card-id", `player-${i}`))
    );
    const cardText = await getCardText(handler, card);
    resultCards.push(cardText[0]);
  }

  for (let i = 0; i < 8; i++) {
    if (picks & (1 << i)) {
      await wait(handler, 1.0);
      const card = await handler.wait(
        until.elementLocated(byAttribute("data-card-id", `player-${i}`))
      );
      console.log(`click card ${who} ${i}`);
      await card.click();
    }
  }

  console.log(`make move (${who})`);
  await wait(handler, 1.0);
  await clickMakeMove(handler, who, "Swap Cards");

  return resultCards;
}

async function firefox_press_button_second_game(handler) {
  await clickMakeMove(handler, "bob", "Start New Game");
}

async function gotShutdown(handler) {
  await handler.wait(
    until.elementLocated(byExactText("Cal Poker - shutdown succeeded")),
  );
}

async function initiateGame(handler, gameTotal, eachHand) {
  console.log("waiting for generate button");
  let generateRoomButton = await handler.wait(
    until.elementLocated(byAttribute("aria-label", "generate-room"))
  );
  await generateRoomButton.click();

  // Choose game
  let gameId = await handler.wait(
    until.elementLocated(byAttribute("aria-label", "game-id")),
    10000
  );
  await gameId.click();
  let choice = await waitForNonError(
    handler,
    () =>
      handler.wait(
        until.elementLocated(byAttribute("data-testid", "choose-calpoker"))
      ),
    () => true,
    1.0
  );
  console.log("choice element", choice);
  await choice.click();

  let wager = await handler.wait(
    until.elementLocated(byAttribute("aria-label", "game-wager", "//input")),
    1000
  );
  let perHand = await handler.wait(
    until.elementLocated(byAttribute("aria-label", "per-hand", "//input")),
    1000
  );

  await wager.sendKeys("200");

  // If each hand is specified, also set it.
  if (eachHand) {
    await perHand.click();
    await sendControlA(handler);
    await perHand.sendKeys(eachHand.toString());
  }

  let createButton = await handler.wait(
    until.elementLocated(byExactText("Create")),
    1000
  );
  console.log("click create");
  await createButton.click();

  // The button now has the aria-label on the button element itself.
  let copyButton = await handler.wait(
    until.elementLocated(byAttribute("aria-label", "ContentCopyIcon"))
  );
  await handler.executeScript(
    'arguments[0].scrollIntoView({block: "center", inline: "center"});',
    copyButton
  );
  try {
    await copyButton.click();
  } catch (e1) {
    try {
      const ancestorButton = await copyButton.findElement(
        By.xpath('ancestor::button | ancestor::div[@role="button"]')
      );
      await handler.executeScript(
        'arguments[0].scrollIntoView({block: "center", inline: "center"});',
        ancestorButton
      );
      await ancestorButton.click();
    } catch (e2) {
      await handler.executeScript("arguments[0].click();", copyButton);
    }
  }

  await wait(handler, 1.0);

  // Check that we got a url.
  let partnerUrlSpan = await handler.wait(
    until.elementLocated(byAttribute("aria-label", "partner-target-url"))
  );
  console.log("partner url", partnerUrlSpan);
  let partnerUrl = await partnerUrlSpan.getAttribute("textContent");
  console.log("partner url text", partnerUrl);
  expect(partnerUrl.substr(0, 4)).toBe("http");

  return partnerUrl;
}

async function prepareBrowser(handler) {
  await handler.switchTo().defaultContent();
  await handler.switchTo().parentFrame();
  await handler.get("about:blank");
}

function stripCards(cards) {
  return cards.map((c) => c.replace("+", ""));
}

async function getCards(handler, label) {
  console.log("getCards", label);

  const hand = await handler.wait(
    until.elementLocated(byAttribute("data-testid", label))
  );
  console.log("foundHand", hand);

  return getCardText(handler, hand);
}

async function verifyCardsWithLog(handler, cards) {
  await wait(handler, 5.0);

  await handler.executeScript("window.scroll(0, 0);");
  const gameLogExpandButton = await handler.wait(
    until.elementLocated(byAttribute("data-testid", "log-expand-button-0"))
  );
  console.log("gonna click the game log heading");
  await gameLogExpandButton.click();

  console.log("gonna find our hand in the most recent log entry");
  const rawCardList = await getCards(handler, "my-start-hand-0");
  const theirRawList = await getCards(handler, "opponent-start-hand-0");
  const myUsedList = await getCards(handler, "my-used-hand-0");
  const theirUsedList = await getCards(handler, "opponent-used-hand-0");
  const myFinalList = await getCards(handler, "my-final-hand-0");
  const theirFinalList = await getCards(handler, "opponent-final-hand-0");
  const cardList = stripCards(rawCardList);
  const theirList = stripCards(theirRawList);

  function countUses(collection, list) {
    let count = 0;
    list.forEach((c) => {
      if (collection[c]) {
        count++;
      }
    });
    return count;
  }

  if (JSON.stringify(cardList) !== JSON.stringify(cards)) {
    console.log(cardList, cards);
    throw new Error("Log doesn't show the cards we knew we had.");
  }

  // Check the outcome cards against the hand description.
  const myLogEntryDesc = await getHandDescription(
    handler,
    "my-used-hand-0-description"
  );
  const theirLogEntryDesc = await getHandDescription(
    handler,
    "opponent-used-hand-0-description"
  );

  function checkUsedVsFinal(used, final) {
    used.forEach((u) => {
      let count = 0;
      final.forEach((c) => {
        if (u == c) {
          count += 1;
        }
      });
      if (count !== 1) {
        console.log("used", used);
        console.log("final", final);
        throw new Error(`Card ${u} didn't appear in final hand ${myFinalList}`);
      }
    });
  }

  checkUsedVsFinal(myUsedList, myFinalList);
  checkUsedVsFinal(theirUsedList, theirFinalList);

  const convertedMyUsedCards = constructGameStyleCards(myUsedList);
  const convertedTheirUsedCards = constructGameStyleCards(theirUsedList);
  checkCardsInLog(myLogEntryDesc, convertedMyUsedCards);
  checkCardsInLog(theirLogEntryDesc, convertedTheirUsedCards);
}

async function reloadBrowser(handler, selectWallet) {
  console.log("reloading");
  await handler.navigate().refresh();
  console.log("selecting wallet");
  await selectWallet(handler);
  console.log("done reloading?");
  await handler.wait(until.elementLocated(byAttribute("id", "subframe")));
  await handler.switchTo().frame("subframe");
}

// Define a category of tests using test framework, in this case Jasmine
describe("Out of money test", function () {
  const baseUrl = "http://localhost:3000";
  const handler = handler1;
  const ffhandler = handler2;

  async function testOneGameEconomicResult(selectWallet) {
    // Load the login page
    await handler.get(baseUrl);

    await selectWallet(handler);

    await wait(handler, 5.0);

    await handler.switchTo().frame("subframe");

    const partnerUrl = await initiateGame(handler, 200);

    // Spawn second browser.
    console.log("second browser start");
    await firefox_start_and_first_move(selectWallet, ffhandler, partnerUrl);

    console.log("wait for alice make move button");
    await clickMakeMove(handler, "alice", "Start Game");

    await clickFourCards(ffhandler, "bob", 0xaa);

    console.log("selecting alice cards");
    await clickFourCards(handler, "alice", 0x55);

    console.log("stop the game");
    await handler.switchTo().defaultContent();

    // 2. re-enter iframe
    const iframe = await handler.wait(
      until.elementLocated(By.css('iframe[src*="view=game"]')),
      20000
    );
    await handler.switchTo().frame(iframe);

    // 3. locate button INSIDE iframe
    let stopButton = await waitForNonError(
      handler,
      () =>
        handler.wait(
          until.elementLocated(byAttribute("data-testid", "stop-playing"))
        ),
      (elt) => waitEnabled(handler, elt),
      1.0
    );
    await stopButton.click();

    console.log("awaiting shutdown");

    await gotShutdown(ffhandler);
    await gotShutdown(handler);
  }

 async function testTwoGamesAndShutdown(selectWallet) {
    // Load the login page
    await handler.get(baseUrl);

    await selectWallet(handler);

    await wait(handler, 5.0);

    // Test chat loopback
    // let chatEntry = await handler.wait(until.elementLocated(byElementAndAttribute("input", "id", "«r0»")));
    // await chatEntry.sendKeys("test?");
    // let chatButton = await handler.wait(until.elementLocated(byExactText("Send")));
    // chatButton.click();

    // await wait(1.0);

    // let chatFound = await handler.wait(until.elementLocated(byExactText("test?")));
    // expect(!!chatFound).toBe(true);

    // Try generating a room.

    await handler.switchTo().frame("subframe");

    const partnerUrl = await initiateGame(handler, 200);

    // Spawn second browser.
    console.log("second browser start");
    await firefox_start_and_first_move(selectWallet, ffhandler, partnerUrl);

    const address1 = await retrieveAddress(handler);
    const preBalance1 = await getBalance(handler, address1.puzzleHash);
    const address2 = await retrieveAddress(ffhandler);
    const preBalance2 = await getBalance(ffhandler, address2.puzzleHash);

    console.log("wait for alice make move button");
    await clickMakeMove(handler, "alice", "Start Game");

    let allBobCards = await clickFourCards(ffhandler, 'bob', 0xaa);

    console.log('selecting alice cards');
    let allAliceCards = await clickFourCards(handler, 'alice', 0x55);

    console.log('bob cards', allBobCards);
    console.log('alice cards', allAliceCards);

    console.log("first game complete");

    await firefox_press_button_second_game(ffhandler);

    console.log('check alice cards');
    await verifyCardsWithLog(handler, allAliceCards);

    console.log('check bob cards');
    await verifyCardsWithLog(ffhandler, allBobCards);

    console.log('alice random number (2)');
    await clickMakeMove(handler, 'alice', "Start New Game");

    await clickFourCards(ffhandler, 'bob', 0xaa);

    console.log('selecting alice cards (2)');
    await clickFourCards(handler, 'alice', 0x55);

    console.log("stop the game (2)");
    await handler.executeScript('window.scroll(0, 0);');
    let stopButton = await waitForNonError(
      handler,
      () =>
      handler.wait(
        until.elementLocated(byAttribute("data-testid", "stop-playing")),
      ),
      (elt) => waitEnabled(handler, elt),
      1.0,
    );
    await stopButton.click();

    const logEntries = [];
    let expectedPost1 = preBalance1 + 200;
    let expectedPost2 = preBalance2 + 200;
    const outcomeToAddition = { lose: -10, win: 10, tie: 0 };

    console.log("searching for outcome");
    for (let i = 0; i < 2; i++) {
      const logEntryMe = await handler.wait(
        until.elementLocated(byAttribute("data-testid", `log-entry-me-${i}`)),
      );
      const outcomeMe = await logEntryMe.getAttribute("textContent");
      const addition =
        outcomeMe.indexOf("You Won") != -1
          ? 10
          : outcomeMe.indexOf("Opponent Won") != -1
            ? -10
            : 0;
      expectedPost1 += addition;
      expectedPost2 -= addition;
    }

    console.log("awaiting shutdown");
    await gotShutdown(ffhandler);
    await gotShutdown(handler);

    console.log("terminating");

    const postBalance1 = await getBalance(handler, address1.puzzleHash);
    const postBalance2 = await getBalance(ffhandler, address2.puzzleHash);

    console.log("balance1", preBalance1, postBalance1);
    console.log("balance2", preBalance2, postBalance2);

    if (postBalance1 != expectedPost1 || postBalance2 != expectedPost2) {
      throw new Error("Failed expected balance check");
    }
  }


  async function testRunOutOfMoney(selectWallet) {
    // Load the login page
    console.log("handler.get", baseUrl, handler);
    await handler.get(baseUrl);

    await selectWallet(handler);

    await wait(handler, 5.0);

    await handler.switchTo().frame("subframe");

    const partnerUrl = await initiateGame(handler, 200, 300);

    // Spawn second browser.
    console.log("second browser start");
    await firefox_start_and_first_move(selectWallet, ffhandler, partnerUrl);

    console.log("wait for alice make move button");
    await clickMakeMove(handler, "alice", "Start Game");

    console.log("selecting bob cards");
    await clickFourCards(ffhandler, "bob", 0xaa);

    console.log("selecting alice cards");
    await clickFourCards(handler, "alice", 0x55);

    console.warn("get ff shutdown");
    await gotShutdown(ffhandler);
    console.warn("get chrome shutdown");
    await gotShutdown(handler);

    await wait(handler, 5.0);
  }

  async function testOneGameReload(selectWallet) {
    // Load the login page
    await handler.get(baseUrl);

    await selectWallet(handler);

    await wait(handler, 5.0);

    await handler.switchTo().frame("subframe");

    const partnerUrl = await initiateGame(handler, 200);

    // Spawn second browser.
    console.log("second browser start");
    await firefox_start_and_first_move(selectWallet, ffhandler, partnerUrl);

    console.log("wait for alice make move button");
    await clickMakeMove(handler, "alice", "Start Game");

    /*
    Disable save / load testing
    console.log('wait before reloading');
    await wait(handler, 10.0);
    await reloadBrowser(handler, selectWallet);
    console.log('wait after reloading');
    await wait(handler, 10.0);
    */

    console.log("selecting bob cards");
    await clickFourCards(ffhandler, "bob", 0xaa);

    console.log("selecting alice cards");
    await clickFourCards(handler, "alice", 0x55);

    await wait(handler, 5.0);

    console.log("stop the game");
    await handler.executeScript("window.scroll(0, 0);");
    let stopButton = await waitForNonError(
      handler,
      () =>
        handler.wait(
          until.elementLocated(byAttribute("data-testid", "stop-playing"))
        ),
      (elt) => waitEnabled(handler, elt),
      1.0
    );
    await stopButton.click();

    console.log("awaiting shutdown");

    console.warn("get ff shutdown");
    await gotShutdown(ffhandler);
    console.warn("get chrome shutdown");
    await gotShutdown(handler);

    await wait(handler, 5.0);
  }

  it(
    "starts",
    async function () {
      // Terminate early if we didn't get the browsers we wanted.
      expect(!!handler1 && !!handler2).toBe(true);

      await testTwoGamesAndShutdown(selectSimulator);

      await prepareBrowser(handler1);
      await prepareBrowser(handler2);

      await testRunOutOfMoney(selectSimulator);

      await prepareBrowser(handler1);
      await prepareBrowser(handler2);

      await testOneGameReload(selectSimulator);

      await prepareBrowser(handler1);
      await prepareBrowser(handler2);

      await testTwoGamesAndShutdown(selectWalletConnect);
    },
    1 * 60 * 60 * 1000
  );
});
