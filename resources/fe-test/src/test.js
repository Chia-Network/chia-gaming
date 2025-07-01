// Require modules used in the logic below
const jasmine = require('jasmine');
const os = require('os');
const {Builder, By, Key, until} = require('selenium-webdriver');

// You can use a remote Selenium Hub, but we are not doing that here
require('chromedriver');
const driver = new Builder()
      .forBrowser('chrome')
      .build();

async function wait(secs) {
  const actions = driver.actions({async: true});
  await actions.pause(secs * 1000).perform();
}

function byExactText(str) {
  return By.xpath(`//*[text()='${str}']`);
}

function byAttribute(attr,val) {
  return By.xpath(`//*[@${attr}='${val}']`);
}

function byElementAndAttribute(element,attr,val) {
  return By.xpath(`//${element}[@${attr}='${val}']`);
}

// Define a category of tests using test framework, in this case Jasmine
describe("Basic element tests", function() {
  const baseUrl = "http://localhost:3000";

  it("starts", async function() {
    // Load the login page
    await driver.get(baseUrl);

    await driver.wait(until.elementLocated(byExactText("Connected Players")));

    // Test chat loopback
    // let chatEntry = await driver.wait(until.elementLocated(byElementAndAttribute("input", "id", "«r0»")));
    // await chatEntry.sendKeys("test?");
    // let chatButton = await driver.wait(until.elementLocated(byExactText("Send")));
    // chatButton.click();

    // await wait(1.0);

    // let chatFound = await driver.wait(until.elementLocated(byExactText("test?")));
    // expect(!!chatFound).toBe(true);

    // Try generating a room.
    let generateRoomButton = await driver.wait(until.elementLocated(byExactText("Generate Room")));
    await generateRoomButton.click();

      let gameId = await driver.wait(until.elementLocated(byAttribute("id", ":r5:")));
      let wager = await driver.wait(until.elementLocated(byAttribute("id", ":r7:")));

    await gameId.sendKeys("calpoker");
    await wager.sendKeys("200");

    let createButton = await driver.wait(until.elementLocated(byExactText("Create")));
    await createButton.click();

    await wait(2.0);

    let alert = await driver.switchTo().alert();
    let alertText = await alert.getText();
    await alert.accept();

    await driver.quit();
  }, 100000);
});
