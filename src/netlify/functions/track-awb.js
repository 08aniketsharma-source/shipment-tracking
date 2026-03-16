// AWB (Air Waybill) tracking serverless function v31
// Tries multiple 17Track internal API endpoints (same ones the website uses)
// Plus the public API as fallback

const API_KEY = '263C77C508FD086359A81F5FADC69A75';
const API_BASE = 'https://api.17track.net/track/v2.4';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest'
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '{"error":"Method Not Allowed"}' };

  try {
    const { number } = JSON.parse(event.body);
    if (!number) return { statusCode: 400, headers: cors, body: '{"error":"Missing number"}' };

    const clean = number.replace(/[-\s]/g, '');
    const hyphenated = clean.length === 11 ? clean.substring(0, 3) + '-' + clean.substring(3) : number;
    const variants = [...new Set([number, hyphenated, clean])];

    console.log('AWB tracking v31:', number, 'variants:', variants);

    // METHOD 1: 17Track air cargo specific API endpoint
    for (const v of variants) {
      try {
        console.log('M1: aircargo API for', v);
        const result = await tryAirCargoAPI(v);
        if (result) {
          console.log('M1 (aircargo) succeeded for:', v);
          return ok(cors, result, 'aircargo');
        }
      } catch (e) { console.warn('M1 fail:', e.message); }
    }

    // METHOD 2: 17Track website handlertrack API (multiple URL patterns)
    for (const v of variants) {
      try {
        console.log('M2: handlertrack for', v);
        const result = await tryHandlerTrack(v);
        if (result) {
          console.log('M2 (handlertrack) succeeded for:', v);
          return ok(cors, result, 'website');
        }
      } catch (e) { console.warn('M2 fail:', e.message); }
    }

    // METHOD 3: t.17track.net REST API endpoints
    for (const v of variants) {
      try {
        console.log('M3: t.17track REST for', v);
        const result = await tryT17TrackRest(v);
        if (result) {
          console.log('M3 (t17track) succeeded for:', v);
          return ok(cors, result, 't17track');
        }
      } catch (e) { console.warn('M3 fail:', e.message); }
    }

    // METHOD 4: Public API register + gettrackinfo (last resort)
    for (const v of variants) {
      try {
        console.log('M4: public API register for', v);
        await fetch17API('register', [{ number: v, auto_detection: true }]);
      } catch (e) { console.warn('Register fail:', e.message); }
    }
    await sleep(3000);
    for (const v of variants) {
      try {
        const result = await fetch17API('gettrackinfo', [{ number: v }]);
        if (result?.data?.accepted?.length) {
          const info = result.data.accepted[0];
          const events = (info.track_info?.tracking?.providers || [])[0]?.events || [];
          const status = info.track_info?.latest_status?.status;
          if (events.length > 0 || (status && status !== 'NotFound')) {
            console.log('M4 (public API) succeeded for:', v);
            return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
              body: JSON.stringify({ method: 'api', data: info }) };
          }
        }
      } catch (e) { console.warn('M4 gettrackinfo fail:', e.message); }
    }

    // All methods failed
    console.log('All methods exhausted for AWB:', number);
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'none', error: 'Air cargo tracking unavailable via API',
        trackUrl: 'https://t.17track.net/en#nums=' + encodeURIComponent(hyphenated) }) };

  } catch (error) {
    console.error('AWB handler error:', error.message);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }) };
  }
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ok(cors, converted, method) {
  return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, data: converted }) };
}

async function fetch17API(endpoint, body) {
  const r = await fetch(API_BASE + '/' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', '17token': API_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('API status ' + r.status);
  return await r.json();
}

// Method 1: Air cargo specific API — 17Track has air cargo specific endpoints
async function tryAirCargoAPI(trackNum) {
  const endpoints = [
    { url: 'https://t.17track.net/restapi/aircargo', ct: 'json' },
    { url: 'https://t.17track.net/restapi/air', ct: 'json' },
    { url: 'https://www.17track.net/restapi/aircargo', ct: 'json' }
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          'Origin': new URL(ep.url).origin,
          'Referer': new URL(ep.url).origin + '/en/aircargo?nums=' + trackNum
        },
        body: JSON.stringify({ data: [{ num: trackNum }], guid: '' })
      });
      console.log('tryAirCargoAPI', ep.url, 'status:', r.status);
      if (r.ok) {
        const text = await r.text();
        try {
          const json = JSON.parse(text);
          if (json?.dat?.length > 0) {
            const td = json.dat[0];
            if (td.z0 || (td.z1 && td.z1.length > 0)) return convertWebsiteFormat(td);
          }
          if (json?.data) return convertAPIFormat(json.data);
        } catch (e) { console.warn('Parse fail for', ep.url); }
      }
    } catch (e) { continue; }
  }
  return null;
}

// Method 2: handlertrack.ashx — the classic 17Track internal API
async function tryHandlerTrack(trackNum) {
  const urls = [
    'https://t.17track.net/restapi/handlertrack.ashx',
    'https://www.17track.net/restapi/handlertrack.ashx',
    'https://t.17track.net/restapi/handlertrack.ashx?type=0',
    'https://www.17track.net/restapi/handlertrack.ashx?type=0'
  ];

  for (const url of urls) {
    try {
      const origin = new URL(url).origin;
      // Try JSON format first
      let r = await fetch(url, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          'Origin': origin,
          'Referer': origin + '/en#nums=' + trackNum
        },
        body: JSON.stringify({ guid: '', data: [{ num: trackNum, fc: 0, sc: 0 }] })
      });
      console.log('tryHandlerTrack JSON', url, 'status:', r.status);
      if (r.ok) {
        const json = await r.json();
        if (json?.dat?.length > 0) {
          const td = json.dat[0];
          if (td.z0 || (td.z1 && td.z1.length > 0)) return convertWebsiteFormat(td);
        }
      }

      // Try form-encoded format
      r = await fetch(url, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Origin': origin,
          'Referer': origin + '/en#nums=' + trackNum
        },
        body: 'data=' + encodeURIComponent(JSON.stringify({ guid: '', data: [{ num: trackNum, fc: 0 }] }))
      });
      console.log('tryHandlerTrack FORM', url, 'status:', r.status);
      if (r.ok) {
        const json = await r.json();
        if (json?.dat?.length > 0) {
          const td = json.dat[0];
          if (td.z0 || (td.z1 && td.z1.length > 0)) return convertWebsiteFormat(td);
        }
      }
    } catch (e) { continue; }
  }
  return null;
}

// Method 3: t.17track.net REST API endpoints
async function tryT17TrackRest(trackNum) {
  const endpoints = [
    'https://t.17track.net/restapi/track',
    'https://t.17track.net/restapi/track/single',
    'https://t.17track.net/restapi/result'
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          'Origin': 'https://t.17track.net',
          'Referer': 'https://t.17track.net/en#nums=' + trackNum
        },
        body: JSON.stringify({ data: [{ num: trackNum, fc: 0 }], guid: '', timeZoneOffset: -60 })
      });
      console.log('tryT17TrackRest', url, 'status:', r.status);
      if (r.ok) {
        const json = await r.json();
        if (json?.dat?.length > 0) {
          const td = json.dat[0];
          if (td.z0 || (td.z1 && td.z1.length > 0)) return convertWebsiteFormat(td);
        }
      }
    } catch (e) { continue; }
  }
  return null;
}

function convertWebsiteFormat(trackData) {
  const events = [];
  if (trackData.z1 && Array.isArray(trackData.z1)) {
    trackData.z1.forEach(e => {
      events.push({
        time_iso: e.a || '',
        description: e.z || '',
        location: e.c || ''
      });
    });
  }
  const latest = trackData.z0 || {};
  const statusMap = { '0': 'NotFound', '10': 'InTransit', '20': 'Expired', '30': 'PickedUp',
    '35': 'Undelivered', '40': 'Delivered', '50': 'Exception' };
  const status = statusMap[String(trackData.e)] || 'InTransit';

  // Extract delivery/arrival date from events
  let deliveryDate = null;
  if (status === 'Delivered' && events.length > 0) {
    deliveryDate = events[0].time_iso ? events[0].time_iso.substring(0, 10) : null;
  }
  // Look for arrival/ETA in event descriptions
  if (!deliveryDate) {
    for (const ev of events) {
      const desc = (ev.description || '').toLowerCase();
      if ((desc.includes('arriv') || desc.includes('deliver') || desc.includes('eta')) && ev.time_iso) {
        deliveryDate = ev.time_iso.substring(0, 10);
        break;
      }
    }
  }

  return {
    track_info: {
      latest_status: { status },
      latest_event: {
        time_iso: latest.a || '',
        description: latest.z || '',
        location: latest.c || ''
      },
      time_metrics: deliveryDate ? { estimated_delivery_date: deliveryDate } : undefined,
      tracking: { providers: [{ events }] }
    }
  };
}

function convertAPIFormat(data) {
  // Handle if data comes in a different structure
  if (Array.isArray(data) && data.length > 0) {
    const item = data[0];
    if (item.track_info) return item;
  }
  if (data.track_info) return data;
  return null;
}
