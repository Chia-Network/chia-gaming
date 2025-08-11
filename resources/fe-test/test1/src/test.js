// Require modules used in the logic below
const jasmine = require('jasmine');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node:child_process');
const {Builder, Browser, By, Key, until} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const {wait, byExactText, byAttribute, byElementAndAttribute, sendEnter, waitEnabled, selectSimulator} = require('./util.js');

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
    console.log('wait for enabled');
    await waitEnabled(driver, generateRoomButton); 
    console.log('press enter');
    await sendEnter(generateRoomButton);

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

    console.log('spawn second browser');
    fs.writeFileSync('../test2/base.url', partnerUrl);
    const test2 = spawn('./node_modules/.bin/jest', ['--useStderr', '--silent=false'], {
	cwd: '../test2'
    });
    test2.stdout.on('data', (data) => {
        console.log('stdout data from test2', data.toString('utf8'));
    });
    test2.stderr.on('data', (data) => {
        console.log('stderr data from test2', data.toString('utf8'));
    });
    test2.on('close', (exitcode) => {
	console.log('test2 closed with code', exitcode);
    });

    console.log('wait for game to start');
    await driver.wait(until.elementLocated(byAttribute("aria-label", "waiting-state")));

    await driver.wait(until.elementLocated(byAttribute("aria-label", "make-move")));

    // Player1 and Player2 are in the game.

    console.log('quit');
    await driver.quit();
  }, 100000);
});
