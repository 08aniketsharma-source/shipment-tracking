// Parcels App Webhook receiver — stores tracking updates in Firebase
// Setup: When calling POST /shipments/tracking, include webhookUrl pointing to:
// https://shoplcshipmentplanning.netlify.app/.netlify/functions/webhook

const FIREBASE_DB = 'https://warehouse-space-dashboard-default-rtdb.europe-west1.firebasedatabase.app';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: '{"error":"Method Not Allowed"}' };

  try {
    const payload = JSON.parse(event.body);
    console.log('Webhook received, done:', payload.done, 'shipments:', (payload.shipments || []).length);

    if (payload.shipments && payload.shipments.length > 0) {
      for (const ship of payload.shipments) {
        const trackingId = ship.trackingId;
        if (!trackingId) continue;

        console.log('Webhook: processing', trackingId, 'status:', ship.status);

        // Extract ETA and status from Parcels response
        let eta = null;
        let sts = ship.status || null;

        // Try to get ETA from attributes
        if (ship.attributes) {
          for (const attr of ship.attributes) {
            if (attr.l && (attr.l.toLowerCase().includes('delivery') || attr.l.toLowerCase().includes('eta') || attr.l.toLowerCase().includes('estimated'))) {
              // Try to parse date from val
              const dateMatch = (attr.val || '').match(/(\d{4}-\d{2}-\d{2})/);
              if (dateMatch) eta = dateMatch[1];
            }
          }
        }

        // For delivered: use last event date as ETA
        if (!eta && sts && sts.toLowerCase().includes('deliver') && ship.states && ship.states.length > 0) {
          const lastState = ship.states[0]; // most recent
          if (lastState.date) eta = lastState.date.substring(0, 10);
        }

        // For in-transit: look for arrival/ETA hints in events
        if (!eta && ship.states) {
          for (const st of ship.states) {
            const desc = (st.status || '').toLowerCase();
            if ((desc.includes('estimat') || desc.includes('expect') || desc.includes('arrival') || desc.includes('eta')) && st.date) {
              eta = st.date.substring(0, 10);
              break;
            }
          }
        }

        // Store in Firebase
        const fbKey = trackingId.replace(/[.#$/\[\]]/g, '_');
        const fbData = {
          eta: eta,
          sts: sts,
          ts: Date.now(),
          trackData: ship
        };

        console.log('Webhook: saving to Firebase at tracking/' + fbKey, 'status:', sts, 'eta:', eta);

        const fbUrl = FIREBASE_DB + '/tracking/' + encodeURIComponent(fbKey) + '.json';
        const fbRes = await fetch(fbUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fbData)
        });

        if (fbRes.ok) {
          console.log('Webhook: Firebase save successful for', trackingId);
        } else {
          console.error('Webhook: Firebase save failed:', fbRes.status);
        }
      }
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ status: 'ok' }) };

  } catch (error) {
    console.error('Webhook error:', error.message);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ status: 'error', message: error.message }) };
  }
};
