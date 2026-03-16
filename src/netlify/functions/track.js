// Parcels App API — Universal tracking for parcels, air cargo, containers, vessels
// API: https://parcelsapp.com/api/v3/shipments/tracking
// Flow: POST to create tracking → get UUID → poll GET until done → return results

const PARCELS_API = 'https://parcelsapp.com/api/v3/shipments/tracking';
const PARCELS_API_KEY = process.env.PARCELS_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiIxN2Q4ODIyMC0wOGY5LTExZjEtOTZjNS05MTAxZWQ3MmMxODAiLCJzdWJJZCI6IjY5OGY1MTQ4MTg3ZmYwM2JiODRiNmM0YiIsImlhdCI6MTc3MTAwMDEzNn0.YqK3VSNqwySh-w1or3_nIE_-TvQvaq0HjXUJ2ir2G1Q';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  // ---- POST: Initiate tracking + poll for results ----
  if (event.httpMethod === 'POST') {
    try {
      const req = JSON.parse(event.body);
      // Accept either {shipments:[...]} or {numbers:['...']} or {number:'...'}
      let shipments = req.shipments || [];
      if (req.numbers) {
        shipments = req.numbers.map(n => typeof n === 'string' ? { trackingId: n } : n);
      }
      if (req.number) {
        shipments = [{ trackingId: req.number, country: req.country || 'DE' }];
      }
      if (!shipments.length) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No tracking numbers provided' }) };
      }

      // REQUIRED by Parcels API: every shipment MUST have "country" (destination)
      // The API field name is "country" NOT "destinationCountry"
      shipments = shipments.map(s => {
        if (!s.country) s.country = s.destinationCountry || 'DE';
        delete s.destinationCountry; // API uses "country"
        return s;
      });

      const apiKey = req.apiKey || PARCELS_API_KEY;

      console.log('Parcels API: tracking', shipments.length, 'shipments:', shipments.map(s => s.trackingId).join(', '));

      // Step 1: POST to create tracking request
      const postBody = {
        shipments: shipments,
        language: req.language || 'en',
        apiKey: apiKey
      };

      const postRes = await fetch(PARCELS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody)
      });

      const postData = await postRes.json();
      console.log('Parcels API POST response:', JSON.stringify(postData).substring(0, 500));

      if (postData.error) {
        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: true, error: postData.error, shipments: [] }) };
      }

      // If we already got results from cache
      if (postData.done && postData.shipments && postData.shipments.length > 0) {
        console.log('Parcels API: got cached results immediately');
        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify(postData) };
      }

      const uuid = postData.uuid;
      if (!uuid) {
        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: true, error: 'No UUID returned', shipments: postData.shipments || [] }) };
      }

      // Step 2: Poll GET until done (max 8 attempts, ~20 seconds total)
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise(r => setTimeout(r, attempt < 3 ? 2000 : 3000));

        console.log('Parcels API: polling attempt', attempt + 1, 'for UUID', uuid);
        const getRes = await fetch(`${PARCELS_API}?apiKey=${encodeURIComponent(apiKey)}&uuid=${encodeURIComponent(uuid)}`, {
          headers: { 'Accept': 'application/json' }
        });
        const getData = await getRes.json();
        console.log('Parcels API GET attempt', attempt + 1, ':', JSON.stringify(getData).substring(0, 300));

        if (getData.done) {
          return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify(getData) };
        }

        // If we have partial results with shipments, return them
        if (getData.shipments && getData.shipments.length > 0) {
          const hasEvents = getData.shipments.some(s => s.states && s.states.length > 0);
          if (hasEvents) {
            return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...getData, done: true, partial: true }) };
          }
        }
      }

      // Timeout — return whatever we have
      console.log('Parcels API: polling timeout for UUID', uuid);
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: true, timeout: true, uuid: uuid, shipments: [] }) };

    } catch (error) {
      console.error('Parcels API error:', error.message);
      return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message }) };
    }
  }

  // ---- GET: Check tracking status by UUID ----
  if (event.httpMethod === 'GET') {
    try {
      const uuid = event.queryStringParameters?.uuid;
      const apiKey = event.queryStringParameters?.apiKey || PARCELS_API_KEY;
      if (!uuid) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing uuid parameter' }) };
      }

      const getRes = await fetch(`${PARCELS_API}?apiKey=${encodeURIComponent(apiKey)}&uuid=${encodeURIComponent(uuid)}`, {
        headers: { 'Accept': 'application/json' }
      });
      const getData = await getRes.json();

      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(getData) };

    } catch (error) {
      return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message }) };
    }
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};
