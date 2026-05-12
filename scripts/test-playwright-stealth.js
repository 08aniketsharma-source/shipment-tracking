/**
 * Playwright + Stealth Plugin — carrier tracking scrape test
 *
 * Usage:
 *   node scripts/test-playwright-stealth.js <tracking_number> [carrier]
 *
 * Examples:
 *   node scripts/test-playwright-stealth.js 449044304137821 fedex
 *   node scripts/test-playwright-stealth.js 1Z999AA10123456784 ups
 *   node scripts/test-playwright-stealth.js 1234567890 dhl
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const NUM  = process.argv[2];
const HINT = (process.argv[3] || '').toLowerCase();

if (!NUM) {
  console.error('Usage: node scripts/test-playwright-stealth.js <tracking_number> [carrier]');
  process.exit(1);
}

function detectCarrier(num, hint) {
  if (hint && ['fedex','ups','dhl','maersk'].includes(hint)) return hint;
  const n = num.trim().toUpperCase();
  if (/^1Z[A-Z0-9]{16}$/.test(n)) return 'ups';
  if (/^\d{12}$|^\d{15}$|^\d{20}$|^\d{10}$/.test(n)) return 'fedex';
  if (/^\d{3}-\d{8}$/.test(n) || /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) return 'dhl';
  if (/^(MAEU|MSCU|HLCU|COSU|CMDU)/.test(n)) return 'maersk';
  return 'fedex'; // default
}

function getUrl(num, carrier) {
  switch (carrier) {
    case 'fedex':  return `https://www.fedex.com/fedextrack/?trknbr=${num}`;
    case 'ups':    return `https://www.ups.com/track?tracknum=${num}&loc=en_US&requester=ST/trackdetails`;
    case 'dhl':    return `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
    case 'maersk': return `https://www.maersk.com/tracking/${num}`;
    default:       return `https://www.fedex.com/fedextrack/?trknbr=${num}`;
  }
}

// ── Try to dismiss any cookie/consent banner ──────────────────────────────────
async function dismissCookies(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button[id*="accept-all"]',
    'button[class*="accept-all"]',
    '[data-testid="accept-all-cookies"]',
    '#acceptAll',
    'button >> text=Accept All',
    'button >> text=ACCEPT ALL COOKIES',
    'button >> text=Accept Cookies',
    'button >> text=I Accept',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await btn.click();
      console.log(`  Cookie banner dismissed (${sel})`);
      await page.waitForTimeout(2000);
      return;
    }
  }
}

// ── Extract data from FedEx ───────────────────────────────────────────────────
async function extractFedEx(page) {
  // Wait up to 15s for any tracking-related content
  await page.waitForSelector(
    '[class*="TrackingResult"], [class*="tracking"], [data-testid*="track"], .twc-milestone-header, [class*="milestone"]',
    { timeout: 15000 }
  ).catch(() => {});

  return page.evaluate(() => {
    // Try multiple possible selectors (FedEx changes their classes regularly)
    const getText = (...sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    };

    const status = getText(
      '[data-testid="status-heading"]',
      '.twc-milestone-header',
      '[class*="MilestoneTitle"]',
      '[class*="status-title"]',
      'h2[class*="status"]',
    );

    const eta = getText(
      '[data-testid="est-delivery-date"]',
      '[class*="EstimatedDelivery"]',
      '[class*="estimated-delivery"]',
      '[class*="DeliveryDate"]',
    );

    const events = [...document.querySelectorAll(
      '[class*="ScanEvent"], [class*="scan-event"], [class*="ActivityItem"], .twc-scan-detail'
    )].slice(0, 8).map(el => ({
      date:     el.querySelector('[class*="Date"], [class*="date"], time')?.textContent?.trim(),
      status:   el.querySelector('[class*="Status"], [class*="status"], [class*="Description"]')?.textContent?.trim(),
      location: el.querySelector('[class*="Location"], [class*="location"]')?.textContent?.trim(),
    }));

    // Fallback: scan visible text for clues
    const bodyText = document.body.innerText;
    const statusFallback = bodyText.match(/(Delivered|In Transit|Out for Delivery|Picked Up|At FedEx|Arrived|Exception)/i)?.[0];
    const etaFallback = bodyText.match(/(?:Estimated Delivery|Expected Delivery)[:\s]+([A-Z][a-z]+,?\s+[A-Z][a-z]+\s+\d{1,2}[^,\n]*)/i)?.[1]?.trim();

    return {
      status:  status || statusFallback,
      eta:     eta || etaFallback,
      events,
      bodyPreview: bodyText.substring(0, 800),
    };
  });
}

// ── Extract data from UPS ─────────────────────────────────────────────────────
async function extractUPS(page) {
  // Wait for the shipment detail section to appear
  await page.waitForSelector(
    '[class*="shipment"], [class*="Shipment"], [class*="delivery"], h2, h3',
    { timeout: 15000 }
  ).catch(() => {});

  return page.evaluate(() => {
    const bodyText = document.body.innerText;

    // Status: "Delivered On", "Out for Delivery", "In Transit", etc.
    const statusMatch = bodyText.match(/^(Delivered On|Out for Delivery|On the Way|In Transit|We Have Your Package|Label Created|Exception)[^\n]*/m);
    const status = statusMatch?.[0]?.trim() || null;

    // Delivery date line (e.g. "Tuesday, March 24 at 1:23 P.M. at Office")
    const etaMatch = bodyText.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Z][a-z]+ \d{1,2}[^\n]*/);
    const eta = etaMatch?.[0]?.trim() || null;

    // Delivered to / received by
    const deliveredTo = bodyText.match(/Delivered To[\s\S]{0,5}\n([^\n]+)/)?.[1]?.trim();
    const receivedBy  = bodyText.match(/Received By:[\s\S]{0,5}\n([^\n]+)/)?.[1]?.trim()
                     || bodyText.match(/Received By:\s*([^\n]+)/)?.[1]?.trim();

    // Events: lines with dates like 03/24/2026, 4:31 A.M.
    const eventLines = [...bodyText.matchAll(/^([A-Z][^\n]+)\n([^\n]+)\n(\d{2}\/\d{2}\/\d{4},[^\n]*)/gm)];
    const events = eventLines.slice(0, 10).map(m => ({
      status:   m[1]?.trim(),
      location: m[2]?.trim(),
      date:     m[3]?.trim(),
    }));

    return {
      status,
      eta,
      deliveredTo,
      receivedBy,
      events,
      bodyPreview: bodyText.substring(0, 1000),
    };
  });
}

// ── Generic fallback ──────────────────────────────────────────────────────────
async function extractGeneric(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText;
    return {
      status:      bodyText.match(/(Delivered|In Transit|Out for Delivery|Picked Up|Customs|Exception|Arrived|Departed)/i)?.[0] || null,
      eta:         bodyText.match(/(?:estimated|expected|delivery)\s*(?:date)?[:\s]*([A-Z][a-z]+ \d{1,2},? \d{4})/i)?.[1] || null,
      events:      [],
      bodyPreview: bodyText.substring(0, 800),
    };
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const carrier = detectCarrier(NUM, HINT);
  const url     = getUrl(NUM, carrier);

  console.log('\n── Playwright + Stealth Test ────────────────────────────────');
  console.log(`  Tracking #:  ${NUM}`);
  console.log(`  Carrier:     ${carrier.toUpperCase()}`);
  console.log(`  URL:         ${url}`);
  console.log('─────────────────────────────────────────────────────────────\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const ctx  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
    locale:    'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  // Block only heavy binary resources — keep stylesheets so screenshot renders correctly
  await ctx.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media'].includes(type)) route.abort();
    else route.continue();
  });

  const page = await ctx.newPage();

  const start = Date.now();
  try {
    if (carrier === 'ups') {
      // Intercept the UPS internal tracking API call made by their SPA
      let upsApiData = null;
      page.on('response', async (response) => {
        const respUrl = response.url();
        const status  = response.status();
        // Log all XHR/fetch calls to see what UPS SPA is doing
        if (!respUrl.includes('.css') && !respUrl.includes('.js') && !respUrl.includes('.png') && !respUrl.includes('.woff')) {
          console.log(`  [${status}] ${respUrl.substring(0, 120)}`);
        }
        if (respUrl.includes('/track/') && status === 200) {
          try {
            const json = await response.json();
            upsApiData = json;
            console.log('  ✅ UPS tracking API data received!');
          } catch (e) {}
        }
      });

      // Navigate and trigger the tracking lookup
      await page.goto(`https://www.ups.com/track?tracknum=${NUM}&loc=en_US&requester=ST/trackdetails`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(6000); // wait for SPA API calls to complete
      console.log(`Page loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);

      if (upsApiData) {
        console.log('\n── UPS RAW API DATA ─────────────────────────────────────');
        console.log(JSON.stringify(upsApiData, null, 2).substring(0, 2000));
      } else {
        console.log('  No UPS API call intercepted — SPA did not make a tracking request');
      }

    } else {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(4000);
      console.log(`Page loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }

    await dismissCookies(page);

    const shot = `/tmp/playwright-stealth-${carrier}-${NUM}.png`;
    await page.screenshot({ path: shot });
    console.log(`Screenshot: ${shot}`);

    let data;
    switch (carrier) {
      case 'fedex':  data = await extractFedEx(page);   break;
      case 'ups':    data = await extractUPS(page);     break;
      default:       data = await extractGeneric(page); break;
    }

    console.log('\n── Page text preview ────────────────────────────────────────');
    console.log(data.bodyPreview);

    console.log('\n── Extracted tracking data ──────────────────────────────────');
    console.log(JSON.stringify({ status: data.status, eta: data.eta, events: data.events }, null, 2));

    console.log('\n── Result ───────────────────────────────────────────────────');
    const hasData = data.status || data.eta || data.events?.some(e => e.status);
    console.log(hasData
      ? '✅  SUCCESS — tracking data extracted'
      : '⚠️  PARTIAL — page loaded but no structured data found (check screenshot + body preview above)');

  } catch (err) {
    console.error('❌ ERROR:', err.message);
    await page.screenshot({ path: `/tmp/playwright-error-${carrier}.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
})();
