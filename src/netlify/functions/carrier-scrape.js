// Server-side carrier tracking scraper
// Calls the same internal APIs that carrier websites use — no API keys needed
// Returns structured JSON: { status, eta, events[], carrier }
const https = require('https');
const { URL } = require('url');

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
      timeout: 12000,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        const rUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return httpRequest(rUrl, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// FedEx — uses their public tracking endpoint
async function scrapeFedEx(trackingNumber) {
  const payload = JSON.stringify({
    TrackPackagesRequest: {
      appType: 'WTRK', uniqueKey: '', processingParameters: {},
      trackingInfoList: [{ trackNumberInfo: { trackingNumber, trackingQualifier: '', trackingCarrier: '' } }]
    }
  });
  const res = await httpRequest('https://www.fedex.com/trackingCal/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: 'data=' + encodeURIComponent(payload) + '&action=trackpackages&locale=en_US&version=1&format=json',
  });
  const data = JSON.parse(res.body);
  const pkg = data?.TrackPackagesResponse?.packageList?.[0];
  if (!pkg || pkg.errorList?.[0]?.code) return null;
  const events = (pkg.scanEventList || []).map(e => ({
    date: e.date + ' ' + e.time,
    status: e.status || e.scanType || '',
    location: [e.scanLocation, e.city, e.countryName].filter(Boolean).join(', '),
  }));
  return {
    carrier: 'FedEx',
    status: pkg.keyStatus || pkg.displayStatus || '',
    eta: pkg.estDeliveryDt || '',
    delivered: (pkg.keyStatus || '').toLowerCase().includes('deliver'),
    from: pkg.shipperAddress ? [pkg.shipperAddress.city, pkg.shipperAddress.countryName].filter(Boolean).join(', ') : '',
    to: pkg.recipientAddress ? [pkg.recipientAddress.city, pkg.recipientAddress.countryName].filter(Boolean).join(', ') : '',
    events,
  };
}

// UPS — uses their public tracking API
async function scrapeUPS(trackingNumber) {
  const res = await httpRequest('https://www.ups.com/track/api/Track/GetStatus?loc=en_US', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ Locale: 'en_US', TrackingNumber: [trackingNumber] }),
  });
  const data = JSON.parse(res.body);
  const pkg = data?.trackDetails?.[0];
  if (!pkg || pkg.errorCode) return null;
  const events = (pkg.shipmentProgressActivities || []).map(e => ({
    date: (e.date || '') + ' ' + (e.time || ''),
    status: e.activityScan || '',
    location: e.location || '',
  }));
  return {
    carrier: 'UPS',
    status: pkg.packageStatus || '',
    eta: pkg.scheduledDeliveryDate || '',
    delivered: (pkg.packageStatus || '').toLowerCase().includes('deliver'),
    from: pkg.originAddress || '',
    to: pkg.destinationAddress || '',
    events,
  };
}

// DHL — uses their public shipment tracking endpoint
async function scrapeDHL(trackingNumber) {
  const res = await httpRequest('https://www.dhl.com/utapi?trackingNumber=' + encodeURIComponent(trackingNumber) + '&language=en&requesterCountryCode=DE', {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  const data = JSON.parse(res.body);
  const shipment = data?.shipments?.[0];
  if (!shipment) return null;
  const events = (shipment.events || []).map(e => ({
    date: e.timestamp || e.date || '',
    status: e.description || e.status?.description || '',
    location: e.location?.address?.addressLocality || '',
  }));
  return {
    carrier: 'DHL',
    status: shipment.status?.description || shipment.status?.statusCode || '',
    eta: shipment.estimatedTimeOfDelivery || '',
    delivered: (shipment.status?.statusCode || '').toLowerCase().includes('deliver'),
    from: shipment.origin?.address?.addressLocality || '',
    to: shipment.destination?.address?.addressLocality || '',
    events,
  };
}

// Maersk container tracking
async function scrapeMaersk(containerNumber) {
  const res = await httpRequest('https://api.maersk.com/track/' + encodeURIComponent(containerNumber) + '?operator=maeu', {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Consumer-Key': 'your-public-key' },
  });
  try {
    const data = JSON.parse(res.body);
    if (!data || data.error) return null;
    const events = (data.containers?.[0]?.events || []).map(e => ({
      date: e.actualTime || e.expectedTime || '',
      status: e.activity || e.description || '',
      location: e.location || '',
    }));
    return {
      carrier: 'Maersk',
      status: data.containers?.[0]?.status || '',
      eta: data.containers?.[0]?.eta || '',
      delivered: false,
      events,
    };
  } catch (e) { return null; }
}

// Generic fallback — try Parcels App page scrape
async function scrapeParcelsApp(trackingNumber) {
  try {
    const res = await httpRequest('https://parcelsapp.com/en/tracking/' + encodeURIComponent(trackingNumber));
    const html = res.body;
    // Extract status from meta tags or structured data
    const statusMatch = html.match(/property="og:description"\s+content="([^"]+)"/);
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (statusMatch) {
      return {
        carrier: 'Parcels App',
        status: statusMatch[1].substring(0, 200),
        eta: '',
        delivered: statusMatch[1].toLowerCase().includes('deliver'),
        events: [],
        raw: titleMatch ? titleMatch[1] : '',
      };
    }
    return null;
  } catch (e) { return null; }
}

// Detect carrier from tracking number
function detectCarrier(num, mode) {
  const n = (num || '').trim().toUpperCase();
  const m = (mode || '').toLowerCase();
  if (/^1Z/.test(n) || m.includes('ups')) return 'ups';
  if (m.includes('fedex') || (/^\d{12,22}$/.test(n) && !m.includes('dhl'))) return 'fedex';
  if (m.includes('dhl') || /^\d{10}$/.test(n)) return 'dhl';
  if (/^[A-Z]{4}\d{7}$/.test(n) || m.includes('sea') || m.includes('container')) return 'container';
  // Default: try FedEx for long numeric, otherwise generic
  if (/^\d{12,}$/.test(n)) return 'fedex';
  return 'generic';
}

exports.handler = async (event) => {
  const num = event.queryStringParameters?.num;
  const mode = event.queryStringParameters?.mode || '';
  if (!num) return { statusCode: 400, body: JSON.stringify({ error: 'Missing num parameter' }) };

  const carrier = detectCarrier(num, mode);
  let result = null;
  const errors = [];

  try {
    if (carrier === 'fedex') {
      result = await scrapeFedEx(num);
    } else if (carrier === 'ups') {
      result = await scrapeUPS(num);
    } else if (carrier === 'dhl') {
      result = await scrapeDHL(num);
    } else if (carrier === 'container') {
      result = await scrapeMaersk(num);
    }
  } catch (e) {
    errors.push(carrier + ': ' + e.message);
  }

  // Fallback to Parcels App if primary scrape failed
  if (!result) {
    try { result = await scrapeParcelsApp(num); } catch (e) { errors.push('parcels: ' + e.message); }
  }

  if (result) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ success: true, data: result, detectedCarrier: carrier }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, detectedCarrier: carrier, errors }),
  };
};
