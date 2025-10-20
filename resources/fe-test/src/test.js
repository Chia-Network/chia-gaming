// Require modules used in the logic below
const jasmine = require('jasmine');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const {Builder, Browser, By, Key, WebDriver, until} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const firefox = require('selenium-webdriver/firefox');
const {wait, byExactText, byAttribute, byElementAndAttribute, sendEnter, waitAriaEnabled, selectSimulator, selectWalletConnect, waitForNonError, sendControlA, getAddress, getBalance, retrieveAddress} = require('./util.js');

// Other browser
const geckodriver = require('geckodriver');

function makeFirefox() {
  const options1 = new firefox.Options();
  if (process.env.FIREFOX_HEADLESS) {
    options1.addArguments('-headless');
  }
  if (process.env.FIREFOX) {
    options1.setBinary(process.env.FIREFOX);
  }
  const driver = new Builder()
    .forBrowser(Browser.FIREFOX)
    .setFirefoxOptions(options1)
    .build();

  return driver;
}

function makeChrome() {
  const options1 = new chrome.Options();
  options1.addArguments('--remote-debugging-port=9222');

  // You can use a remote Selenium Hub, but we are not doing that here
  require('chromedriver');
  const driver = new Builder()
    .forBrowser(Browser.CHROME)
    .setChromeOptions(options1)
    .build();

  return driver;
}

const driver1 = makeChrome();
const driver2 = makeFirefox();

afterAll(() => {
    if (driver1) { driver1.close(); }
    if (driver2) { driver2.close(); }
});

async function clickMakeMove(driver, who) {
    console.log(`click make move ${who}`);
    const makeMoveButton = await waitForNonError(driver, () => driver.wait(until.elementLocated(byAttribute("aria-label", "make-move"))), (elt) => waitAriaEnabled(driver, elt), 1.0);
    await makeMoveButton.click();
}

async function firefox_start_and_first_move(selectWallet, driver, baseUrl) {
  console.log('firefox start', baseUrl, driver);
  await driver.get(baseUrl);

  await selectWallet(driver);

  await driver.wait(until.elementLocated(byAttribute("id", "subframe")));

  await driver.switchTo().frame('subframe');

  console.log('Wait for handshake on bob side');
  await driver.wait(until.elementLocated(byAttribute("aria-label", "waiting-state")));

  console.log('Wait for the make move button');
  await clickMakeMove(driver, 'bob');

  console.log('Bob passing back to alice');
  return driver;
}

async function getCardText(driver, card) {
  const rawText = await card.getAttribute('innerText');
  return rawText.split(/[ \t\r\n]/)[0];
}

async function clickFourCards(driver, who, picks) {
  await driver.wait(until.elementLocated(byAttribute("aria-label", `card-true-0`)));
  const resultCards = [];

  for (let i = 0; i < 8; i++) {
    const card = await driver.wait(until.elementLocated(byAttribute("aria-label", `card-true-${i}`)));

    resultCards.push(await getCardText(driver, card));
  }

  for (let i = 0; i < 8; i++) {
    if (picks & (1 << i)) {
      await wait(driver, 1.0);
      const card = await driver.wait(until.elementLocated(byAttribute("aria-label", `card-true-${i}`)));
      console.log(`click card ${who} ${i}`);
      await card.click();
    }
  }

  console.log(`make move (${who})`);
  await wait(driver, 1.0);
  await clickMakeMove(driver, who);

  return resultCards;
}

async function firefox_press_button_second_game(driver) {
  await clickMakeMove(driver, 'bob');
}

async function gotShutdown(driver) {
  await driver.wait(until.elementLocated(byExactText("Cal Poker - shutdown succeeded")));
}

async function initiateGame(driver, gameTotal, eachHand) {
  console.log('waiting for generate button');
  let generateRoomButton = await driver.wait(until.elementLocated(byAttribute("aria-label", "generate-room")));
  await generateRoomButton.click();

  let gameId = await driver.wait(until.elementLocated(byAttribute("aria-label", "game-id", "//input")), 1000);
  let wager = await driver.wait(until.elementLocated(byAttribute("aria-label", "game-wager", "//input")), 1000);
  let perHand = await driver.wait(until.elementLocated(byAttribute("aria-label", "per-hand", "//input")), 1000);

  await gameId.sendKeys("calpoker");
  await wager.sendKeys("200");

  // If each hand is specified, also set it.
  if (eachHand) {
    await perHand.click();
    await sendControlA(driver);
    await perHand.sendKeys(eachHand.toString());
  }

  let createButton = await driver.wait(until.elementLocated(byExactText("Create")), 1000);
  console.log('click create');
  await createButton.click();

  console.log('focus alert');
  await driver.wait(until.alertIsPresent());
  let alert = await waitForNonError(driver, () => driver.switchTo().alert(), () => {}, 1.0);
  await alert.accept();

  await wait(driver, 1.0);

   // Check that we got a url.
  let partnerUrlSpan = await driver.wait(until.elementLocated(byAttribute("aria-label", "partner-target-url")));
  console.log('partner url', partnerUrlSpan);
  let partnerUrl = await partnerUrlSpan.getAttribute("innerText");
  console.log('partner url text', partnerUrl);
  expect(partnerUrl.substr(0, 4)).toBe('http');

  return partnerUrl;
}

async function prepareBrowser(driver) {
  await driver.switchTo().defaultContent();
  await driver.switchTo().parentFrame();
  await driver.get('about:blank');
}

function stripCards(cards) {
  return cards.map((c) => c.replace('+', ''));
}

async function getCards(driver, label) {
  const hand = await driver.wait(until.elementLocated(byAttribute("aria-label", label)));
  const text = await hand.getAttribute('innerText');
  return text.split(/[ \t\r\n]/);
}

async function verifyCardsWithLog(driver, cards) {
  const gameLogHeadingTitle = await driver.wait(until.elementLocated(byAttribute("aria-label", "game-log-heading")));
  console.log('gonna click the game log heading');
  await gameLogHeadingTitle.click();

  console.log('gonna find our hand in the most recent log entry');
  const rawCardList = await getCards(driver, "my-start-hand-0");
  const theirRawList = await getCards(driver, "opponent-start-hand-0");
  const myUsedList = await getCards(driver, "my-used-hand-0");
  const theirUsedList = await getCards(driver, "opponent-used-hand-0");
  const cardList = stripCards(rawCardList);
  const theirList = stripCards(theirRawList);

  function rawCardsToGiven(rawCardList) {
    const givenCards = {};

    stripCards(rawCardList.filter((c) => c.indexOf('+') != -1)).forEach((c) => {
      givenCards[c] = true;
    });

    return givenCards;
  }

  function countUses(collection, list) {
    let count = 0;
    list.forEach((c) => { if (collection[c]) { count++; } });
    return count;
  }

  const givenCards = rawCardsToGiven(rawCardList);
  const theirGivenCards = rawCardsToGiven(theirRawList);

  if (cardList.toString() !== cards.toString()) {
    throw new Error("Log doesn't show the cards we knew we had.");
  }

  // None of the cards in givenCards should appear in my used list.
  myUsedList.forEach((c) => {
    if (givenCards[c]) { throw new Error("We used a card we gave away"); }
  });

  // None of the cards in theirGivenCards should appear their used list.
  theirUsedList.forEach((c) => {
    if (theirGivenCards[c]) { throw new Error("Opponent used a card they gave away"); }
  });

  // At least one of their given cards should appear in my used list.
  let myUsesOfTheirCards = countUses(theirGivenCards, myUsedList);
  if (myUsesOfTheirCards == 0) {
    throw new Error("We didn't use any cards given by opponent.");
  }

  let theirUsesOfMyCards = countUses(givenCards, theirUsedList);
  if (theirUsesOfMyCards == 0) {
    throw new Error("They didn't use any cards given by us.");
  }
}

// Define a category of tests using test framework, in this case Jasmine
describe("Out of money test", function() {
  const baseUrl = "http://localhost:3000";
  const driver = driver1;
  const ffdriver = driver2;

  async function testOneGameEconomicResult(selectWallet) {
    // Load the login page
    await driver.get(baseUrl);

    await selectWallet(driver);

    await wait(driver, 5.0);

    await driver.switchTo().frame('subframe');

    const partnerUrl = await initiateGame(driver, 200);

    // Spawn second browser.
    console.log('second browser start');
    await firefox_start_and_first_move(selectWallet, ffdriver, partnerUrl);

    console.log('wait for alice make move button');
    await clickMakeMove(driver, 'alice');

    await clickFourCards(ffdriver, 'bob', 0xaa);

    console.log('selecting alice cards');
    await clickFourCards(driver, 'alice', 0x55);

    console.log('stop the game');
    let stopButton = await waitForNonError(driver, () => driver.wait(until.elementLocated(byAttribute("aria-label", "stop-playing"))), (elt) => waitAriaEnabled(driver, elt), 1.0);
    await stopButton.click();

    console.log('awaiting shutdown');

    await gotShutdown(ffdriver);
    await gotShutdown(driver);
}

  async function testTwoGamesAndShutdown(selectWallet) {
    // Load the login page
    await driver.get(baseUrl);

    await selectWallet(driver);

    await wait(driver, 5.0);

    // Test chat loopback
    // let chatEntry = await driver.wait(until.elementLocated(byElementAndAttribute("input", "id", "«r0»")));
    // await chatEntry.sendKeys("test?");
    // let chatButton = await driver.wait(until.elementLocated(byExactText("Send")));
    // chatButton.click();

    // await wait(1.0);

    // let chatFound = await driver.wait(until.elementLocated(byExactText("test?")));
    // expect(!!chatFound).toBe(true);

    // Try generating a room.

    await driver.switchTo().frame('subframe');

    const partnerUrl = await initiateGame(driver, 200);

    // Spawn second browser.
    console.log('second browser start');
    await firefox_start_and_first_move(selectWallet, ffdriver, partnerUrl);

    const address1 = await retrieveAddress(driver);
    const preBalance1 = await getBalance(driver, address1.puzzleHash);
    const address2 = await retrieveAddress(ffdriver);
    const preBalance2 = await getBalance(ffdriver, address2.puzzleHash);

    console.log('wait for alice make move button');
    await clickMakeMove(driver, 'alice');

    let allBobCards = await clickFourCards(ffdriver, 'bob', 0xaa);

    console.log('selecting alice cards');
    let allAliceCards = await clickFourCards(driver, 'alice', 0x55);

    // Hit the title for the expanded view
    console.log('bob cards', allBobCards);
    console.log('alice cards', allAliceCards);

    console.log('first game complete');
    await firefox_press_button_second_game(ffdriver);

    console.log('check alice cards');
    await verifyCardsWithLog(driver, allAliceCards);

    console.log('check bob cards');
    await verifyCardsWithLog(ffdriver, allBobCards);

    console.log('alice random number (2)');
    await clickMakeMove(driver, 'alice');

    await clickFourCards(ffdriver, 'bob', 0xaa);

    console.log('selecting alice cards (2)');
    await clickFourCards(driver, 'alice', 0x55);

    console.log('stop the game');
    let stopButton = await waitForNonError(driver, () => driver.wait(until.elementLocated(byAttribute("aria-label", "stop-playing"))), (elt) => waitAriaEnabled(driver, elt), 1.0);
    await stopButton.click();

    const logEntries = [];
    let expectedPost1 = preBalance1 + 200;
    let expectedPost2 = preBalance2 + 200;
    const outcomeToAddition = {"lose":-10, "win":10, "tie":0};

    console.log('searching for outcome');
    for (let i = 0; i < 2; i++) {
        const logEntryMe = await driver.wait(until.elementLocated(byAttribute("aria-label", `log-entry-me-${i}`)));
        const logEntryOpponent = await driver.wait(until.elementLocated(byAttribute("aria-label", `log-entry-opponent-${i}`)));
        const outcomeMe = await logEntryMe.getAttribute("innerText");
        const outcomeOpponent = await logEntryOpponent.getAttribute("innerText");
        const addition = (outcomeMe.indexOf("WINNER") != -1) ? 10 : (outcomeOpponent.indexOf("WINNER") != -1) ? -10 : 0;
        expectedPost1 += addition;
        expectedPost2 -= addition;
    }

    console.log('awaiting shutdown');
    await gotShutdown(ffdriver);
    await gotShutdown(driver);

    console.log('terminating');

    const postBalance1 = await getBalance(driver, address1.puzzleHash);
    const postBalance2 = await getBalance(ffdriver, address2.puzzleHash);

    console.log('balance1', preBalance1, postBalance1);
    console.log('balance2', preBalance2, postBalance2);

    if (postBalance1 != expectedPost1 || postBalance2 != expectedPost2) {
        throw new Error('Failed expected balance check');
    }

    await wait(driver, 30.0);
}

  async function testRunOutOfMoney(selectWallet) {
    // Load the login page
    console.log('driver.get', baseUrl, driver);
    await driver.get(baseUrl);

    await selectSimulator(driver);

    await wait(driver, 5.0);

    await driver.switchTo().frame('subframe');

    const partnerUrl = await initiateGame(driver, 200, 300);

    // Spawn second browser.
    console.log('second browser start');
    await firefox_start_and_first_move(selectWallet, ffdriver, partnerUrl);

    console.log('wait for alice make move button');
    await clickMakeMove(driver, 'alice');

    console.log('selecting bob cards');
    await clickFourCards(ffdriver, 'bob', 0xaa);

    console.log('selecting alice cards');
    await clickFourCards(driver, 'alice', 0x55);

    console.warn('get ff shutdown');
    await gotShutdown(ffdriver);
    console.warn('get chrome shutdown');
    await gotShutdown(driver);

    await wait(driver, 5.0);
  }

  it("starts", async function() {
    // Terminate early if we didn't get the browsers we wanted.
    expect(!!driver1 && !!driver2).toBe(true);

    await testTwoGamesAndShutdown(selectSimulator);

    await prepareBrowser(driver1);
    await prepareBrowser(driver2);

    await testRunOutOfMoney(selectSimulator);

    await prepareBrowser(driver1);
    await prepareBrowser(driver2);

    await testTwoGamesAndShutdown(selectWalletConnect);

  }, 1 * 60 * 60 * 1000);
});
