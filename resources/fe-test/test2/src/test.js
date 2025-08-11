// Require modules used in the logic below
const process = require('process');
const jasmine = require('jasmine');
const os = require('os');
const fs = require('fs');
const {Builder, Browser, By, Key, until} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const {wait, byExactText, byAttribute, byElementAndAttribute, sendEnter, waitEnabled, selectSimulator} = require('../../test1/src/util.js');

const baseUrl = fs.readFileSync('base.url').toString('utf8');
console.log('starting with url', baseUrl);

const options2 = new chrome.Options();
options2.addArguments('--incognito');
options2.addArguments('--remote-debugging-port=9223');

const driver = new Builder()
      .forBrowser(Browser.CHROME)
      .setChromeOptions(options2)
      .usingPort(9223)
      .build();

// Define a category of tests using test framework, in this case Jasmine
describe("Basic element tests", function() {
  it("starts", async function() {
    // Load the login page
    await driver.get(baseUrl);

    // Select simulator
    console.log('select simulator');
    selectSimulator(driver);

    // focus the iframe
    console.log('focus iframe');
    const iframe = await driver.wait(until.elementLocated(byAttribute("id", "subframe")));
    await driver.switchTo().frame(iframe);

    console.log('wait for game start');
    await driver.wait(until.elementLocated(byAttribute("aria-label", "waiting-state")));

    await driver.wait(until.elementLocated(byAttribute("aria-label", "make-move")));

    await driver.quit();
  }, 100000);
});
