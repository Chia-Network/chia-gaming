// Require modules used in the logic below
const jasmine = require('jasmine');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const {Builder, Browser, By, Key, WebDriver, until} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const firefox = require('selenium-webdriver/firefox');
const {wait, byExactText, byAttribute, byElementAndAttribute, sendEnter, waitEnabled, selectSimulator} = require('./util.js');

// Other browser
const geckodriver = require('geckodriver');

async function test2(baseUrl) {
  const options1 = new firefox.Options();
  options1.addArguments('-headless');
  if (process.env.FIREFOX) {
    options1.setBinary(process.env.FIREFOX);
  }
  const driver = new Builder()
    .forBrowser(Browser.FIREFOX)
    .setFirefoxOptions(options1)
    .build();

  await driver.get(baseUrl);

  // Select simulator
  console.log('select simulator');
  selectSimulator(driver);

  // focus the iframe
  console.log('focus iframe');
  const iframe = await driver.wait(until.elementLocated(byAttribute("id", "subframe")));
  await driver.switchTo().frame(iframe);

  console.log('Wait for handshake on bob side');
  await driver.wait(until.elementLocated(byAttribute("aria-label", "waiting-state")));

  return driver;
}

// Main session
const options1 = new chrome.Options();
options1.addArguments('--remote-debugging-port=9222');

// You can use a remote Selenium Hub, but we are not doing that here
require('chromedriver');
const driver = new Builder()
  .forBrowser(Browser.CHROME)
  .setChromeOptions(options1)
  .build();

// Define a category of tests using test framework, in this case Jasmine
describe("Basic element tests", function() {
  const baseUrl = "http://localhost:3000";

  it("starts", async function() {
    // Load the login page
    await driver.get(baseUrl);

    console.log('15 second wait to open dev tools');
    await wait(driver, 15.0);

    // Select simulator
    selectSimulator(driver);

    // focus the iframe
    const iframe = await driver.wait(until.elementLocated(byAttribute("id", "subframe")));
    await driver.switchTo().frame(iframe);

    // Test chat loopback
    // let chatEntry = await driver.wait(until.elementLocated(byElementAndAttribute("input", "id", "«r0»")));
    // await chatEntry.sendKeys("test?");
    // let chatButton = await driver.wait(until.elementLocated(byExactText("Send")));
    // chatButton.click();

    // await wait(1.0);

    // let chatFound = await driver.wait(until.elementLocated(byExactText("test?")));
    // expect(!!chatFound).toBe(true);

    // Try generating a room.
    console.log('waiting for generate button');
    let generateRoomButton = await driver.wait(until.elementLocated(byAttribute("aria-label", "generate-room")));
    generateRoomButton.click();

    let gameId = await driver.wait(until.elementLocated(byAttribute("aria-label", "game-id", "//input")), 1000);
    let wager = await driver.wait(until.elementLocated(byAttribute("aria-label", "game-wager", "//input")), 1000);

    await gameId.sendKeys("calpoker");
    await wager.sendKeys("200");

    let createButton = await driver.wait(until.elementLocated(byExactText("Create")), 1000);
    await createButton.click();

    await wait(driver, 2.0);

    let alert = await driver.switchTo().alert();
    let alertText = await alert.getText();
    await alert.accept();

    await wait(driver, 1.0);

   // Check that we got a url.
    let partnerUrlSpan = await driver.wait(until.elementLocated(byAttribute("aria-label", "partner-target-url")));
    console.log('partner url', partnerUrlSpan);
    let partnerUrl = await partnerUrlSpan.getAttribute("innerText");
    console.log('partner url text', partnerUrl);
    expect(partnerUrl.substr(0, 4)).toBe('http');

    // Spawn second browser.
    await test2(partnerUrl).catch((e) => {
      console.error('error executing browser 2', e);
      driver.quit();
    }).then(async (ffdriver) => {
      console.log('wait for game to start on alice side');
      await driver.wait(until.elementLocated(byAttribute("aria-label", "waiting-state")));

      console.log('wait for alice make move button');
      await driver.wait(until.elementLocated(byAttribute("aria-label", "make-move")));
      // Player1 and Player2 are in the game.

      console.log('quit');
      await driver.quit();
      await ffdriver.quit();
    });

  }, 1 * 60 * 60 * 1000);
});
