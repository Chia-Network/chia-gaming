const {Builder, Browser, By, Key, until} = require('selenium-webdriver');

async function wait(driver, secs) {
    const actions = driver.actions({async: true});
    await actions.pause(secs * 1000).perform();
}

function byExactText(str) {
    return By.xpath(`//*[text()='${str}']`);
}

function byAttribute(attr,val,sub) {
    if (!sub) {
        sub = '';
    }
    return By.xpath(`//*[@${attr}='${val}']${sub}`);
}

function byElementAndAttribute(element,attr,val) {
    return By.xpath(`//${element}[@${attr}='${val}']`);
}

async function sendEnter(element) {
    await element.sendKeys(Key.ENTER);
}

async function waitEnabled(driver, element) {
    const actions = driver.actions({async: true});
    for (var i = 0; i < 10 && !element.isEnabled(); i++) {
        await actions.pause(500);
    }
}

async function waitAriaEnabled(driver, element) {
    const actions = driver.actions({async: true});
    let i = 0;
    while (i < 10) {
        const shouldExit = await element.getAttribute("aria-disabled");
        if (shouldExit.toString() !== "true") {
            return;
        }
        await actions.pause(500);
    }
}

async function selectSimulator(driver) {
    const controlMenu = await driver.wait(until.elementLocated(byAttribute("aria-label", "control-menu")));
    controlMenu.click();
    const simulatorButton = await driver.wait(until.elementLocated(byExactText("Simulator")));
    simulatorButton.click();
}

async function getPlayerCards(driver, iAmPlayer) {
    const firstEightCards = [];
    for (var i = 0; i < 8; i++) {
        const card = await driver.wait(until.elementLocated(byAttribute("aria-label", `card-${iAmPlayer}-${i}`)));
        firstEightCards.push(card);
    }

    return firstEightCards;
}

async function waitForNonError(driver, select, extra, time) {
    let stopButton = null;
    for (var i = 0; i < 10; i++) {
        try {
            stopButton = await select();
            await extra(stopButton);
            break;
        } catch (e) {
            console.log('waiting for stop button got stale ref', i, e);
        }
        await wait(driver, time);
    }
    return stopButton;
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
    getPlayerCards,
    waitForNonError
};
