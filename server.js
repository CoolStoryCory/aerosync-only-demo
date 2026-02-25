require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUser(user) {
  const users = loadUsers();
  users.unshift(user); // newest first
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AEROPAY_BASE  = 'https://staging-api.aeropay.com';
const AEROSYNC_BASE = 'https://api.sandbox-sync.aero.inc';
const DWOLLA_BASE   = 'https://api-sandbox.dwolla.com';

// ── Aeropay token cache ───────────────────────────────────────────────────────
let aeropayToken = null;
let aeropayTokenExpiry = 0;

async function getAeropayToken(debugLog) {
  if (aeropayToken && Date.now() < aeropayTokenExpiry) {
    debugLog.push({ service: 'Aeropay', label: 'Token (cached)', request: null, response: { token: aeropayToken } });
    return aeropayToken;
  }
  const url        = `${AEROPAY_BASE}/token`;
  const reqHeaders = { 'Content-Type': 'application/json' };
  const reqBody    = { api_key: process.env.AEROPAY_API_KEY, api_secret: process.env.AEROPAY_API_SECRET, scope: 'merchant', id: Number(process.env.AEROPAY_MERCHANT_ID) };
  const res  = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
  const data = await res.json();
  debugLog.push({ service: 'Aeropay', label: 'POST /token', request: { method: 'POST', url, headers: reqHeaders, body: redactCreds(reqBody) }, response: { status: res.status, body: data } });
  if (!data.token) throw new Error('Failed to get Aeropay token: ' + JSON.stringify(data));
  aeropayToken       = data.token;
  aeropayTokenExpiry = Date.now() + ((data.TTL || data.ttl || 1800) - 60) * 1000;
  return aeropayToken;
}

// ── AeroSync token cache ──────────────────────────────────────────────────────
let aerosyncToken = null;
let aerosyncTokenExpiry = 0;

async function getAeroSyncToken(debugLog) {
  if (aerosyncToken && Date.now() < aerosyncTokenExpiry) {
    debugLog.push({ service: 'AeroSync', label: 'Token (cached)', request: null, response: { token: aerosyncToken } });
    return aerosyncToken;
  }
  const url        = `${AEROSYNC_BASE}/v2/token`;
  const reqHeaders = { 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
  const reqBody    = { apiKey: process.env.AEROSYNC_API_KEY, apiSecret: process.env.AEROSYNC_API_SECRET };
  const res  = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
  const data = await res.json();
  debugLog.push({ service: 'AeroSync', label: 'POST /v2/token', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: redactCreds(reqBody) }, response: { status: res.status, body: data } });
  if (!data.token) throw new Error('Failed to get AeroSync token: ' + JSON.stringify(data));
  aerosyncToken       = data.token;
  aerosyncTokenExpiry = Date.now() + (25 * 60 * 1000); // 25 min conservative cache
  return aerosyncToken;
}

// ── AeroSync async job poller ─────────────────────────────────────────────────
async function pollJob(connectionId, jobId, token, debugLog, maxWaitMs = 90000) {
  const deadline = Date.now() + maxWaitMs;
  const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const url  = `${AEROSYNC_BASE}/v2/accounts/${connectionId}/job/${jobId}`;
    const res  = await fetch(url, { headers: reqHeaders });
    const data = await res.json();
    debugLog.push({ service: 'AeroSync', label: `GET /v2/accounts/${connectionId}/job/${jobId}`, request: { method: 'GET', url, headers: reqHeaders }, response: { status: res.status, body: data } });

    const rawStatus = data.jobStatus || data.status || data.data?.status || '';
    const status = rawStatus.toLowerCase();
    if (['done', 'completed', 'success', 'complete'].includes(status)) return { done: true };
    if (['failed', 'error', 'failure'].includes(status)) return { done: false, error: data };
    // anything else (pending, in_progress, running, queued...) → keep polling
  }

  return { done: false, error: { message: 'Job timed out after 90 seconds' } };
}

// ── Dwolla token cache ────────────────────────────────────────────────────────
let dwollaToken = null;
let dwollaTokenExpiry = 0;

async function getDwollaToken(debugLog) {
  if (dwollaToken && Date.now() < dwollaTokenExpiry) {
    debugLog.push({ service: 'Dwolla', label: 'Token (cached)', request: null, response: { access_token: dwollaToken } });
    return dwollaToken;
  }
  const url         = `${DWOLLA_BASE}/token`;
  const credentials = Buffer.from(`${process.env.DWOLLA_CLIENT_ID}:${process.env.DWOLLA_CLIENT_SECRET}`).toString('base64');
  const reqHeaders  = { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const res  = await fetch(url, { method: 'POST', headers: reqHeaders, body: 'grant_type=client_credentials' });
  const data = await res.json();
  debugLog.push({ service: 'Dwolla', label: 'POST /token', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: 'grant_type=client_credentials' }, response: { status: res.status, body: data } });
  if (!data.access_token) throw new Error('Failed to get Dwolla token: ' + JSON.stringify(data));
  dwollaToken       = data.access_token;
  dwollaTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return dwollaToken;
}

function dwollaHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.dwolla.v1.hal+json', 'Content-Type': 'application/vnd.dwolla.v1.hal+json' };
}

// Strips permanent credentials from objects before they're sent to the debug panel
const CRED_KEYS = new Set(['api_key','api_secret','apiKey','apiSecret','x-api-key','Authorization','authorization','authorizationToken']);
function redactCreds(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, CRED_KEYS.has(k) ? '[redacted]' : v]));
}

// ── List saved users ──────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json({ users: loadUsers() });
});

// ── Create user: AeroPass + Dwolla in parallel ────────────────────────────────
app.post('/api/user', async (req, res) => {
  try {
    const { firstName, lastName, email, phone } = req.body;
    const debugLog = [];
    const [aeropayResult, dwollaResult] = await Promise.all([
      (async () => {
        const token      = await getAeropayToken(debugLog);
        const url        = `${AEROPAY_BASE}/user`;
        const reqHeaders = { 'Content-Type': 'application/json', 'X-AP-Version': '1.1', accept: 'application/json', authorizationToken: `Bearer ${token}` };
        const reqBody    = { first_name: firstName, last_name: lastName, email, phone_number: phone, merchantId: Number(process.env.AEROPAY_MERCHANT_ID) };
        const r    = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
        const data = await r.json();
        debugLog.push({ service: 'Aeropay', label: 'POST /user', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: r.status, body: data } });
        return data;
      })(),
      (async () => {
        const token      = await getDwollaToken(debugLog);
        const url        = `${DWOLLA_BASE}/customers`;
        const reqHeaders = dwollaHeaders(token);
        const reqBody    = { firstName, lastName, email };
        const r = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
        if (r.status === 201) {
          const location   = r.headers.get('location');
          const customerId = location.split('/').pop();
          debugLog.push({ service: 'Dwolla', label: 'POST /customers', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: 201, body: { location, customerId } } });
          return { customerId, location };
        }
        const data = await r.json();
        debugLog.push({ service: 'Dwolla', label: 'POST /customers', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: r.status, body: data } });
        throw new Error(data._embedded?.errors?.[0]?.message || JSON.stringify(data));
      })(),
    ]);
    if (aeropayResult.existingUser) return res.status(409).json({ error: 'This phone or email is already registered in the Aero network. Try different credentials.', _debug: debugLog });
    if (!aeropayResult.user?.aeroPassUserUuid) return res.status(500).json({ error: 'Aeropay user creation failed: ' + JSON.stringify(aeropayResult), _debug: debugLog });

    const newUser = {
      name: `${firstName} ${lastName}`,
      email,
      aeroPassUserUuid: aeropayResult.user.aeroPassUserUuid,
      aeropayUserId:    aeropayResult.user.userId,
      customerId:       dwollaResult.customerId,
      dwollaLocation:   dwollaResult.location,
      createdAt:        new Date().toISOString(),
    };
    saveUser(newUser);

    res.json({ ...newUser, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync: get widget token ────────────────────────────────────────────────
app.post('/api/aerosync/token', async (req, res) => {
  try {
    const { aeroPassUserUuid } = req.body;
    const debugLog   = [];
    const url        = `${AEROSYNC_BASE}/v2/token_widget`;
    const reqHeaders = { 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const reqBody    = { apiKey: process.env.AEROSYNC_API_KEY, apiSecret: process.env.AEROSYNC_API_SECRET, aeroPassUserUuid };
    const response   = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
    const data       = await response.json();
    debugLog.push({ service: 'AeroSync', label: 'POST /v2/token_widget', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: redactCreds(reqBody) }, response: { status: response.status, body: data } });
    res.json({ ...data, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync: get account details ─────────────────────────────────────────────
app.get('/api/aerosync/account/:connectionId', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const url        = `${AEROSYNC_BASE}/v2/accounts/${req.params.connectionId}`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const r    = await fetch(url, { headers: reqHeaders });
    const data = await r.json();
    debugLog.push({ service: 'AeroSync', label: `GET /v2/accounts/${req.params.connectionId}`, request: { method: 'GET', url, headers: reqHeaders }, response: { status: r.status, body: data } });
    // AeroSync wraps account fields under an 'account' key
    const account = data.account || data.data || data;
    res.json({ ...account, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync: get cached balance ──────────────────────────────────────────────
app.get('/api/aerosync/balance/:connectionId', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const cid        = req.params.connectionId;
    const url        = `${AEROSYNC_BASE}/v2/accounts/${cid}/balance`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const r    = await fetch(url, { headers: reqHeaders });
    const data = await r.json();
    debugLog.push({ service: 'AeroSync', label: `GET /v2/accounts/${cid}/balance`, request: { method: 'GET', url, headers: reqHeaders }, response: { status: r.status, body: data } });
    // AeroSync wraps balance fields under an 'account' key
    const balance = data.account || data.data || data;
    res.json({ data: balance, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync: get identity (async job) ───────────────────────────────────────
app.get('/api/aerosync/identity/:connectionId', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const cid        = req.params.connectionId;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };

    // Start job
    const startUrl  = `${AEROSYNC_BASE}/v2/accounts/${cid}/identity`;
    const startRes  = await fetch(startUrl, { method: 'POST', headers: reqHeaders });
    const startData = await startRes.json();
    debugLog.push({ service: 'AeroSync', label: `POST /v2/accounts/${cid}/identity`, request: { method: 'POST', url: startUrl, headers: reqHeaders }, response: { status: startRes.status, body: startData } });

    // Handle AC-111 — identity unavailable for manually-linked accounts
    if (startRes.status === 405 || startData?.error?.code === 'AC-111') {
      return res.status(405).json({ error: 'Identity data is not available for this account (manually linked or unsupported)', _debug: debugLog });
    }

    const jobId = startData.jobId || startData.job_id || startData.data?.jobId || startData.data?.job_id;
    if (!jobId) return res.status(500).json({ error: startData?.error?.message || 'Identity job did not return a job ID', _debug: debugLog });

    // Poll until done
    const poll = await pollJob(cid, jobId, token, debugLog);
    if (!poll.done) return res.status(500).json({ error: poll.error?.message || 'Identity job failed or timed out', _debug: debugLog });

    // Retrieve results
    const getUrl = `${AEROSYNC_BASE}/v2/accounts/${cid}/identity`;
    const getRes = await fetch(getUrl, { headers: reqHeaders });
    const data   = await getRes.json();
    debugLog.push({ service: 'AeroSync', label: `GET /v2/accounts/${cid}/identity`, request: { method: 'GET', url: getUrl, headers: reqHeaders }, response: { status: getRes.status, body: data } });
    // AeroSync wraps identity fields under an 'identity' key
    const identity = data.identity || data.data || data;
    res.json({ data: identity, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync: get transactions (async job) ────────────────────────────────────
app.get('/api/aerosync/transactions/:connectionId', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const cid        = req.params.connectionId;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };

    // Start job — last 30 days
    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const startUrl  = `${AEROSYNC_BASE}/v2/accounts/${cid}/transactions`;
    const startBody = { startDate, endDate };
    const startRes  = await fetch(startUrl, { method: 'POST', headers: reqHeaders, body: JSON.stringify(startBody) });
    const startData = await startRes.json();
    debugLog.push({ service: 'AeroSync', label: `POST /v2/accounts/${cid}/transactions`, request: { method: 'POST', url: startUrl, headers: reqHeaders, body: startBody }, response: { status: startRes.status, body: startData } });

    // Handle AC-114/AC-115 — transactions unavailable for manually-linked accounts (check error code regardless of HTTP status)
    if (['AC-114', 'AC-115'].includes(startData?.error?.code) || startRes.status === 405) {
      return res.status(405).json({ error: 'Transaction history is not available for this account (manually linked or unsupported)', _debug: debugLog });
    }

    // Check for any other error from AeroSync
    if (startData?.error || (startRes.status >= 400 && !startData.jobId && !startData.job_id)) {
      return res.status(500).json({ error: startData?.error?.message || `AeroSync error ${startRes.status}`, aerosyncResponse: startData, _debug: debugLog });
    }

    const jobId = startData.jobId || startData.job_id || startData.data?.jobId || startData.data?.job_id;
    if (!jobId) return res.status(500).json({ error: 'No jobId in AeroSync start response', aerosyncResponse: startData, _debug: debugLog });

    // Poll until done
    const poll = await pollJob(cid, jobId, token, debugLog);
    if (!poll.done) return res.status(500).json({ error: poll.error?.message || 'Transactions job failed or timed out', _debug: debugLog });

    // Retrieve results
    const getUrl = `${AEROSYNC_BASE}/v2/accounts/${cid}/transactions?job_id=${jobId}`;
    const getRes = await fetch(getUrl, { headers: reqHeaders });
    const data   = await getRes.json();
    debugLog.push({ service: 'AeroSync', label: `GET /v2/accounts/${cid}/transactions`, request: { method: 'GET', url: getUrl, headers: reqHeaders }, response: { status: getRes.status, body: data } });

    if (data.error) {
      return res.status(502).json({ error: `AeroSync error fetching transactions: ${data.error.message} (${data.error.code})`, _debug: debugLog });
    }

    // AeroSync wraps transactions under a 'transactions' key (same pattern as account/identity)
    const txData = data.transactions !== undefined ? data
      : data.data?.transactions !== undefined ? data.data
      : (data.data || data);
    res.json({ data: txData, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dwolla: get master account funding source ─────────────────────────────────
app.get('/api/dwolla/master', async (req, res) => {
  const href     = process.env.DWOLLA_MASTER_FUNDING_SOURCE;
  const debugLog = [{ service: 'Dwolla', label: 'Master funding source (from env)', request: null, response: { href } }];
  res.json({ href, _debug: debugLog });
});

// ── Dwolla: create funding source for customer ────────────────────────────────
app.post('/api/dwolla/funding-source', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getDwollaToken(debugLog);
    const { customerId, routingNumber, accountNumber, bankAccountType, name } = req.body;
    const url        = `${DWOLLA_BASE}/customers/${customerId}/funding-sources`;
    const reqHeaders = dwollaHeaders(token);
    const reqBody    = { routingNumber, accountNumber, bankAccountType, name };
    const response   = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
    if (response.status === 201) {
      const location        = response.headers.get('location');
      const fundingSourceId = location.split('/').pop();
      debugLog.push({ service: 'Dwolla', label: 'POST /customers/:id/funding-sources', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: 201, body: { location, fundingSourceId } } });
      res.json({ fundingSourceId, location, _debug: debugLog });
    } else {
      const data = await response.json();
      debugLog.push({ service: 'Dwolla', label: 'POST /customers/:id/funding-sources', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: response.status, body: data } });
      res.status(response.status).json({ ...data, _debug: debugLog });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dwolla: create transfer ───────────────────────────────────────────────────
app.post('/api/dwolla/transfer', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getDwollaToken(debugLog);
    const { sourceHref, destinationHref, amount } = req.body;
    const url        = `${DWOLLA_BASE}/transfers`;
    const reqHeaders = dwollaHeaders(token);
    const reqBody    = { _links: { source: { href: sourceHref }, destination: { href: destinationHref } }, amount: { value: amount, currency: 'USD' } };
    const response   = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
    if (response.status === 201) {
      const location   = response.headers.get('location');
      const transferId = location.split('/').pop();
      debugLog.push({ service: 'Dwolla', label: 'POST /transfers', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: 201, body: { location, transferId } } });
      res.json({ transferId, location, _debug: debugLog });
    } else {
      const data = await response.json();
      debugLog.push({ service: 'Dwolla', label: 'POST /transfers', request: { method: 'POST', url, headers: reqHeaders, body: reqBody }, response: { status: response.status, body: data } });
      res.status(response.status).json({ ...data, _debug: debugLog });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AeroSync test app running at http://localhost:${PORT}`));
