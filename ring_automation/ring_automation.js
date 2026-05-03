// Prefer API bulk download: ../ring-tools/ring-download/download.js (RING_TOKEN). Use this Playwright flow only if needed.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, 'ring_downloads');

if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clean(str) {
  return str.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function makeFolder(dateText) {
  // Saturday, April 25, 1:21 PM
  const nowYear = new Date().getFullYear();

  const parts = dateText.replace(',', '').split(' ');
  const month = parts[1];
  const day = parts[2];
  const time = parts.slice(3).join('_');

  const yearFolder = path.join(ROOT, String(nowYear));
  const monthFolder = path.join(yearFolder, `${month}`);
  const dayFolder = path.join(monthFolder, `${day}`);

  fs.mkdirSync(dayFolder, { recursive: true });

  return { folder: dayFolder, time };
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    acceptDownloads: true
  });

  const page = await context.newPage();

  await page.goto('https://account.ring.com/account/activity-history');

  console.log("Login manually, then press Enter.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('', async () => {
    const processed = new Set();
    let idle = 0;

    while (idle < 10) {
      const events = page.locator('img[src*="person-detected"], img[src*="bell"], img[src*="disabled"]');
      const count = await events.count();

      let newOnes = 0;

      for (let i = 0; i < count; i++) {
        try {
          const row = events.nth(i).locator('xpath=ancestor::div[1]');
          const key = clean(await row.textContent());

          if (processed.has(key)) continue;
          processed.add(key);

          await row.scrollIntoViewIfNeeded();
          await row.click({ force: true });
          await sleep(2000);

          const eventType = clean(await page.locator('text=Person Detected, text=Missed Ring, text=Answered Ring').first().textContent());
          const dateText = clean(await page.locator('text=/April|May|June|July|August|September|October|November|December|January|February|March/').first().textContent());

          const info = makeFolder(dateText);

          const filename = `${info.time}_${eventType}.mp4`;
          const filepath = path.join(info.folder, filename);

          const btn = page.locator('img[src*="download"]').last();

          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            btn.click({ force: true })
          ]);

          await download.saveAs(filepath);

          console.log(`Saved: ${filepath}`);
          newOnes++;

          await sleep(1200);

        } catch (e) {
          console.log("Skip one row");
        }
      }

      if (newOnes === 0) idle++;
      else idle = 0;

      await page.mouse.move(200, 700);
      await page.mouse.wheel(0, 3000);
      await sleep(2500);
    }

    console.log("All done.");
    rl.close();
  });
})();
