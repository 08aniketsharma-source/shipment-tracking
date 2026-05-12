// One-time OAuth login for Outlook access
// Step 1: Visit /.netlify/functions/auth-outlook → redirects to Microsoft login
// Step 2: Login with 2FA → Microsoft redirects back with auth code
// Step 3: This function exchanges code for tokens, stores refresh token in Firebase
//
// After this, the sync-email scheduled function uses the refresh token automatically.

const FIREBASE_DB_URL = 'https://warehouse-space-dashboard-default-rtdb.europe-west1.firebasedatabase.app';

exports.handler = async (event) => {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID || 'common';
  const redirectUri = `https://shoplcshipmentplanning.netlify.app/.netlify/functions/auth-outlook`;
  const scopes = 'offline_access Mail.Read Mail.ReadBasic';

  // No client ID configured yet
  if (!clientId) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">
        <h2>Setup Required</h2>
        <p>Set these Netlify environment variables first:</p>
        <ul>
          <li><strong>AZURE_CLIENT_ID</strong> — from Azure AD app registration</li>
          <li><strong>AZURE_CLIENT_SECRET</strong> — from Azure AD app secrets</li>
          <li><strong>AZURE_TENANT_ID</strong> — your organization's tenant ID</li>
        </ul>
        <p>Then visit this page again to login.</p>
      </body></html>`
    };
  }

  const params = event.queryStringParameters || {};

  // Step 3: Handle callback with auth code
  if (params.code) {
    try {
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: params.code,
          redirect_uri: redirectUri,
          scope: scopes
        })
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/html' },
          body: `<html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">
            <h2 style="color:#ef4444">Token Error</h2>
            <pre style="background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto">${errText}</pre>
            <a href="/.netlify/functions/auth-outlook">Try again</a>
          </body></html>`
        };
      }

      const tokens = await tokenRes.json();

      // Store refresh token in Firebase
      await fetch(`${FIREBASE_DB_URL}/outlook_auth.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: tokens.refresh_token,
          updated_at: new Date().toISOString(),
          expires_in: tokens.ext_expires_in || tokens.expires_in
        })
      });

      // Verify by fetching user profile
      let userEmail = 'unknown';
      try {
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        if (meRes.ok) {
          const me = await meRes.json();
          userEmail = me.mail || me.userPrincipalName || 'unknown';
        }
      } catch (e) { /* ignore */ }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: `<html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;text-align:center">
          <div style="font-size:48px;margin-bottom:16px">&#10004;</div>
          <h2 style="color:#10b981">Connected Successfully!</h2>
          <p>Outlook account <strong>${userEmail}</strong> is now linked.</p>
          <p style="color:#64748b;font-size:14px">The scheduled sync will automatically check for "Shipment Details with Status" emails daily at 7:00 AM UTC and update your dashboard.</p>
          <p style="color:#64748b;font-size:13px;margin-top:24px">You can close this page. No further action needed.</p>
        </body></html>`
      };

    } catch (err) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html' },
        body: `<html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">
          <h2 style="color:#ef4444">Error</h2><p>${err.message}</p>
          <a href="/.netlify/functions/auth-outlook">Try again</a>
        </body></html>`
      };
    }
  }

  // Handle error from Microsoft
  if (params.error) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">
        <h2 style="color:#ef4444">Login Error</h2>
        <p><strong>${params.error}</strong>: ${params.error_description || 'Unknown error'}</p>
        <a href="/.netlify/functions/auth-outlook">Try again</a>
      </body></html>`
    };
  }

  // Step 1: Redirect to Microsoft login
  const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      response_mode: 'query',
      prompt: 'consent'
    }).toString();

  return {
    statusCode: 302,
    headers: { Location: authUrl }
  };
};
