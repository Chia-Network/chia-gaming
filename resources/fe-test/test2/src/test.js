// Require modules used in the logic below
const process = require('process');
const jasmine = require('jasmine');
const os = require('os');
const fs = require('fs');
const geckodriver = require('geckodriver');
const webdriver = require('selenium-webdriver');
const {wait, byExactText, byAttribute, byElementAndAttribute, sendEnter, waitEnabled, selectSimulator} = require('../../test1/src/util.js');
const {Builder, Browser, By, Key, Service, until} = webdriver;
const wdio = require('webdriverio');
const waitPort = require('wait-port');

const baseUrl = fs.readFileSync('base.url').toString('utf8');
console.log('starting with url', baseUrl);

// Define a category of tests using test framework, in this case Jasmine
describe("Basic element tests", function() {
  it("starts", async function() {
    const gecko_process = await geckodriver.start({ port: 4444 });
    await waitPort({ port: 4444 });

    const driver = await wdio.remote({ capabilities: { browserName: 'firefox' } });
    await driver.url(baseUrl);

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
