// Server-side proxy for carrier tracking pages
// Bypasses X-Frame-Options/CSP restrictions by fetching the page server-side
// and serving it from our own domain without iframe-blocking headers
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Allowed carrier domains — only proxy known tracking sites
const ALLOWED_DOMAINS = [
  'www.fedex.com', 'fedex.com',
  'www.dhl.com', 'dhl.com',
  'www.ups.com', 'ups.com',
  'www.maersk.com', 'maersk.com',
  'www.hapag-lloyd.com', 'hapag-lloyd.com',
  'www.track-trace.com', 'track-trace.com',
  'parcelsapp.com', 'www.parcelsapp.com',
  'www.qrcargo.com', 'qrcargo.com',
  'www.skycargo.com', 'skycargo.com',
  'www.turkishcargo.com', 'turkishcargo.com',
  'www.lufthansa-cargo.com', 'lufthansa-cargo.com',
  'cargo.airfrance.com',
  'www.iagcargo.com', 'iagcargo.com',
  'www.msc.com', 'msc.com',
  'www.cma-cgm.com', 'cma-cgm.com',
  'www.evergreen-marine.com', 'evergreen-marine.com',
  'www.oocl.com', 'oocl.com',
  'www.yangming.com', 'yangming.com',
  'www.one-line.com', 'one-line.com',
  'www.zim.com', 'zim.com',
  'www.gls-group.eu', 'gls-group.eu',
  'www.dpd.com', 'dpd.com',
  'www.tnt.com', 'tnt.com',
];

function fetchPage(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 10000,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, targetUrl).href;
        return fetchPage(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  const targetUrl = event.queryStringParameters?.url;
  if (!targetUrl) {
    return { statusCode: 400, body: 'Missing url parameter' };
  }

  // Validate the URL
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  // Only allow known carrier domains
  if (!ALLOWED_DOMAINS.includes(parsed.hostname)) {
    return { statusCode: 403, body: 'Domain not allowed: ' + parsed.hostname };
  }

  try {
    const result = await fetchPage(targetUrl);
    let body = result.body.toString('utf-8');
    const contentType = result.headers['content-type'] || 'text/html';

    // Inject a <base> tag so relative URLs resolve correctly
    if (contentType.includes('text/html')) {
      const baseTag = `<base href="${parsed.origin}/" target="_blank">`;
      if (body.includes('<head>')) {
        body = body.replace('<head>', '<head>' + baseTag);
      } else if (body.includes('<HEAD>')) {
        body = body.replace('<HEAD>', '<HEAD>' + baseTag);
      } else {
        body = baseTag + body;
      }
    }

    return {
      statusCode: result.statusCode || 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300',
        // No X-Frame-Options — this is the whole point
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: 'Failed to fetch carrier page: ' + err.message,
    };
  }
};
