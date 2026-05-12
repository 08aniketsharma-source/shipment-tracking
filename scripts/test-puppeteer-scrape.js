/**
 * Proof-of-concept: Puppeteer headless browser scraper for carrier tracking
 * Tests whether a real headless Chrome can extract tracking data from carrier sites
 *
 * Usage:
 *   node scripts/test-puppeteer-scrape.js <tracking_number> [mode]
 *
 * Examples:
 *   node scripts/test-puppeteer-scrape.js 1Z999AA10123456784
 *   node scripts/test-puppeteer-scrape.js 7489274725 air
 *   node scripts/test-puppeteer-scrape.js MAEU123456789 sea
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const TRACKING_NUM = process.argv[2];
const MODE = (process.argv[3] || '').toLowerCase();

if (!TRACKING_NUM) {
  console.error('Usage: node scripts/test-puppeteer-scrape.js <tracking_number> [mode]');
  process.exit(1);
}

// ── Detect carrier from tracking number pattern ──────────────────────────────
function detectCarrier(num, mode) {
  const n = num.trim().toUpperCase();
  if (mode === 'sea' || /^(MAEU|MSCU|HLCU|COSU|CMDU|OOLU|EGLV|YMLU)/.test(n)) return 'maersk';
  if (/^1Z[A-Z0-9]{16}$/.test(n)) return 'ups';
  if (/^\d{12}$/.test(n) || /^\d{15}$/.test(n) || /^\d{20}$/.test(n)) return 'fedex';
  if (/^\d{10}$/.test(n) || /^\d{9}$/.test(n)) return 'fedex';
  if (/^\d{3}-\d{8}$/.test(n) || (mode === 'air' && /^\d{11}$/.test(n))) return 'dhl';
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) return 'dhl'; // universal postal
  return 'unknown';
}

// ── Carrier tracking URLs ─────────────────────────────────────────────────────
function getTrackingUrl(num, carrier) {
  switch (carrier) {
    case 'fedex':  return `https://www.fedex.com/fedextrack/?trknbr=${num}`;
    case 'ups':    return `https://www.ups.com/track?tracknum=${num}`;
    case 'dhl':    return `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
    case 'maersk': return `https://www.maersk.com/tracking/${num}`;
    default:       return `https://parcelsapp.com/en/tracking/${num}`;
  }
}

// ── Carrier-specific data extractors ─────────────────────────────────────────
async function extractFedEx(page) {
  // Wait for status element
  await page.waitForSelector('[data-testid="status-heading"], .status-text, .twc-milestone-header', { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    const status = document.querySelector('[data-testid="status-heading"], .status-text, h2.twc-milestone-header')?.textContent?.trim();
    const eta = document.querySelector('[data-testid="est-delivery-date"], .estimated-delivery-date, .twc-estimated-delivery')?.textContent?.trim();
    const events = [...document.querySelectorAll('.twc-scan-detail, [data-testid="activity-item"]')].slice(0, 8).map(el => ({
      date: el.querySelector('.twc-scan-date, [data-testid="activity-date"]')?.textContent?.trim(),
      status: el.querySelector('.twc-scan-status, [data-testid="activity-description"]')?.textContent?.trim(),
      location: el.querySelector('.twc-scan-location, [data-testid="activity-location"]')?.textContent?.trim(),
    }));
    return { status, eta, events };
  });
}

async function extractUPS(page) {
  await page.waitForSelector('.ups-status, [data-automation="shipment-status"], h2', { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    const status = document.querySelector('[data-automation="shipment-status"], .ups-status')?.textContent?.trim();
    const eta = document.querySelector('[data-automation="delivery-date"]')?.textContent?.trim();
    const events = [...document.querySelectorAll('[data-automation="activity-row"]')].slice(0, 8).map(el => ({
      date: el.querySelector('[data-automation="activity-date"]')?.textContent?.trim(),
      status: el.querySelector('[data-automation="activity-description"]')?.textContent?.trim(),
      location: el.querySelector('[data-automation="activity-location"]')?.textContent?.trim(),
    }));
    return { status, eta, events };
  });
}

async function extractDHL(page) {
  await page.waitForSelector('.tracking__status, .c-tracking-result__status', { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    const status = document.querySelector('.tracking__status, .c-tracking-result__status')?.textContent?.trim();
    const eta = document.querySelector('.tracking__delivery-date, .c-tracking-result__eta')?.textContent?.trim();
    const events = [...document.querySelectorAll('.tracking__event, .c-tracking-result__event')].slice(0, 8).map(el => ({
      date: el.querySelector('.tracking__event-date, time')?.textContent?.trim(),
      status: el.querySelector('.tracking__event-status, .event-description')?.textContent?.trim(),
      location: el.querySelector('.tracking__event-location')?.textContent?.trim(),
    }));
    return { status, eta, events };
  });
}

async function extractMaersk(page) {
  await page.waitForSelector('[class*="transport-phase"], [class*="milestone"], h2', { timeout: 25000 }).catch(() => {});
  return page.evaluate(() => {
    const status = document.querySelector('[class*="transport-phase__title"], [class*="milestone__title"]')?.textContent?.trim();
    const eta = document.querySelector('[class*="eta"], [class*="arrival-date"]')?.textContent?.trim();
    const events = [...document.querySelectorAll('[class*="transport-event"], [class*="milestone-item"]')].slice(0, 8).map(el => ({
      date: el.querySelector('[class*="date"], time')?.textContent?.trim(),
      status: el.querySelector('[class*="description"], [class*="title"]')?.textContent?.trim(),
      location: el.querySelector('[class*="location"]')?.textContent?.trim(),
    }));
    return { status, eta, events };
  });
}

async function extractGeneric(page) {
  // Fallback: grab visible text that looks like a status/date
  return page.evaluate(() => {
    const bodyText = document.body.innerText.substring(0, 3000);
    const statusMatch = bodyText.match(/(delivered|in transit|out for delivery|picked up|customs|exception|arrived|departed)/i);
    const etaMatch = bodyText.match(/(?:estimated|expected|delivery)\s*(?:date|delivery)?[:\s]*([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    return {
      status: statusMatch ? statusMatch[0] : null,
      eta: etaMatch ? etaMatch[1] : null,
      bodyPreview: bodyText.substring(0, 500),
    };
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const carrier = detectCarrier(TRACKING_NUM, MODE);
  const url = getTrackingUrl(TRACKING_NUM, carrier);

  console.log('\n── Puppeteer Carrier Scrape Test ───────────────────────────');
  console.log(`  Tracking #:  ${TRACKING_NUM}`);
  console.log(`  Detected:    ${carrier.toUpperCase()}`);
  console.log(`  URL:         ${url}`);
  console.log('──────────────────────────────────────────────────────────────\n');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',  // hide automation flag
      '--disable-infobars',
      '--window-size=1280,800',
    ],
  });

  const page = await browser.newPage();

  // Appear as a real browser
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1280, height: 800 });

  // Intercept and block heavy/unnecessary resources to speed up load
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log('Launching headless Chrome and navigating...');
  const startTime = Date.now();

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Page loaded in ${loadTime}s`);

    // Dismiss cookie/GDPR banners (common across carrier sites)
    const cookieBtnSelectors = [
      'button#onetrust-accept-btn-handler',
      'button[id*="accept"]',
      'button[class*="accept-all"]',
      '[data-testid="accept-all-cookies"]',
      '#acceptAll',
      '.cookie-accept',
      'button::-p-text(Accept All)',
      'button::-p-text(ACCEPT ALL COOKIES)',
    ];
    for (const sel of cookieBtnSelectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        console.log(`Dismissed cookie banner: ${sel}`);
        await new Promise(r => setTimeout(r, 2000)); // wait for page to re-render after consent
        break;
      }
    }

    // Take a screenshot to visually confirm what was rendered
    const screenshotPath = `/tmp/puppeteer-test-${carrier}-${TRACKING_NUM}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`Screenshot saved: ${screenshotPath}`);

    // Dump a snippet of the DOM text to help diagnose selector issues
    const domSnippet = await page.evaluate(() => document.body.innerText.substring(0, 1500));
    console.log('\n── Page text (first 1500 chars) ─────────────────────────────');
    console.log(domSnippet);
    console.log('─────────────────────────────────────────────────────────────\n');

    // Extract tracking data using carrier-specific extractor
    let data;
    switch (carrier) {
      case 'fedex':  data = await extractFedEx(page);  break;
      case 'ups':    data = await extractUPS(page);    break;
      case 'dhl':    data = await extractDHL(page);    break;
      case 'maersk': data = await extractMaersk(page); break;
      default:       data = await extractGeneric(page); break;
    }

    console.log('\n── Extracted Data ───────────────────────────────────────────');
    console.log(JSON.stringify(data, null, 2));

    // Also grab page title for quick sanity check
    const title = await page.title();
    console.log(`\nPage title: "${title}"`);

    const hasData = data.status || data.eta || (data.events && data.events.some(e => e.status));
    console.log('\n── Result ───────────────────────────────────────────────────');
    console.log(hasData
      ? '✅  SUCCESS — Puppeteer extracted tracking data'
      : '⚠️  PARTIAL — Page loaded but no structured data extracted (check screenshot)');

  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    const errScreenshot = `/tmp/puppeteer-error-${carrier}.png`;
    await page.screenshot({ path: errScreenshot }).catch(() => {});
    console.log(`Error screenshot: ${errScreenshot}`);
  } finally {
    await browser.close();
  }
})();
