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
    debugLog.push({ service: 'Aeropay', label: 'Token (cached)', request: null, response: { token: '[hidden — server-side only]' } });
    return aeropayToken;
  }
  const url        = `${AEROPAY_BASE}/token`;
  const reqHeaders = { 'Content-Type': 'application/json' };
  const reqBody    = { api_key: process.env.AEROPAY_API_KEY, api_secret: process.env.AEROPAY_API_SECRET, scope: 'merchant', id: Number(process.env.AEROPAY_MERCHANT_ID) };
  const res  = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
  const data = await res.json();
  debugLog.push({ service: 'Aeropay', label: 'POST /token', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: redactCreds(reqBody) }, response: { status: res.status, body: redactTokens(data) } });
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
    debugLog.push({ service: 'AeroSync', label: 'Token (cached)', request: null, response: { token: '[hidden — server-side only]' } });
    return aerosyncToken;
  }
  const url        = `${AEROSYNC_BASE}/v2/token`;
  const reqHeaders = { 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
  const reqBody    = { apiKey: process.env.AEROSYNC_API_KEY, apiSecret: process.env.AEROSYNC_API_SECRET };
  const res  = await fetch(url, { method: 'POST', headers: reqHeaders, body: JSON.stringify(reqBody) });
  const data = await res.json();
  debugLog.push({ service: 'AeroSync', label: 'POST Token', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: redactCreds(reqBody) }, response: { status: res.status, body: redactTokens(data) } });
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
    debugLog.push({ service: 'AeroSync', label: 'GET Job Poll', request: { method: 'GET', url, headers: redactCreds(reqHeaders) }, response: { status: res.status, body: data } });

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
    debugLog.push({ service: 'Dwolla', label: 'Token (cached)', request: null, response: { access_token: '[hidden — server-side only]' } });
    return dwollaToken;
  }
  const url         = `${DWOLLA_BASE}/token`;
  const credentials = Buffer.from(`${process.env.DWOLLA_CLIENT_ID}:${process.env.DWOLLA_CLIENT_SECRET}`).toString('base64');
  const reqHeaders  = { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const res  = await fetch(url, { method: 'POST', headers: reqHeaders, body: 'grant_type=client_credentials' });
  const data = await res.json();
  debugLog.push({ service: 'Dwolla', label: 'POST /token', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: 'grant_type=client_credentials' }, response: { status: res.status, body: redactTokens(data) } });
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

// Hides server-side access tokens (Aerosync, Aeropay, Dwolla) from the debug panel,
// so a screen-shared demo never shows a working token. Widget tokens are not touched:
// the browser needs those to launch the widget.
const ACCESS_TOKEN_KEYS = new Set(['token','access_token','refresh_token']);
function redactTokens(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, ACCESS_TOKEN_KEYS.has(k) ? '[hidden — server-side only]' : v]));
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
        debugLog.push({ service: 'Aeropay', label: 'POST /user', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: r.status, body: data } });
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
          debugLog.push({ service: 'Dwolla', label: 'POST /customers', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: 201, body: { location, customerId } } });
          return { customerId, location };
        }
        const data = await r.json();
        debugLog.push({ service: 'Dwolla', label: 'POST /customers', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: r.status, body: data } });
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
    debugLog.push({ service: 'AeroSync', label: 'POST Widget Token', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: redactCreds(reqBody) }, response: { status: response.status, body: data } });
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
    debugLog.push({ service: 'AeroSync', label: 'GET Account', request: { method: 'GET', url, headers: redactCreds(reqHeaders) }, response: { status: r.status, body: data } });
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
    debugLog.push({ service: 'AeroSync', label: 'GET Balance', request: { method: 'GET', url, headers: redactCreds(reqHeaders) }, response: { status: r.status, body: data } });
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
    debugLog.push({ service: 'AeroSync', label: 'POST Identity', request: { method: 'POST', url: startUrl, headers: redactCreds(reqHeaders) }, response: { status: startRes.status, body: startData } });

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
    debugLog.push({ service: 'AeroSync', label: 'GET Identity', request: { method: 'GET', url: getUrl, headers: redactCreds(reqHeaders) }, response: { status: getRes.status, body: data } });
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
    debugLog.push({ service: 'AeroSync', label: 'POST Transactions', request: { method: 'POST', url: startUrl, headers: redactCreds(reqHeaders), body: startBody }, response: { status: startRes.status, body: startData } });

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
    debugLog.push({ service: 'AeroSync', label: 'GET Transactions', request: { method: 'GET', url: getUrl, headers: redactCreds(reqHeaders) }, response: { status: getRes.status, body: data } });

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

// ── MFA-aware job endpoints: start / status / result ─────────────────────────
// Unlike the endpoints above, these never wait on a job inside the request. The
// browser polls status, so a job sitting in pending_mfa for minutes (sandbox MFA
// times out after 5) never hits a request timeout. Paths follow the public job
// workflow docs: identity → /identity, balance → /refresh, transactions → /transactions.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;   // connectionId / jobId shape check before they go into an Aerosync URL
const JOB_TYPES = {
  identity: {
    label: 'Identity',
    startPath:  cid => `/v2/accounts/${cid}/identity`,
    resultPath: cid => `/v2/accounts/${cid}/identity`,
    unwrap:     d => d.identity || d.data || d,
  },
  balance: {
    label: 'Balance Refresh',
    startPath:  cid => `/v2/accounts/${cid}/refresh`,
    resultPath: cid => `/v2/accounts/${cid}/balance`,
    unwrap:     d => d.account || d.data || d,
  },
  transactions: {
    label: 'Transactions',
    startPath:  cid => `/v2/accounts/${cid}/transactions`,
    startBody:  () => {
      const endDate   = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      return { startDate, endDate };
    },
    resultPath: (cid, jobId) => `/v2/accounts/${cid}/transactions?job_id=${encodeURIComponent(jobId)}`,
    unwrap:     d => d.transactions !== undefined ? d : d.data?.transactions !== undefined ? d.data : (d.data || d),
  },
  // User-scoped (Aeropass) transactions: the app's post-link source for the phone's activity list.
  // Status still polls on the connection-scoped job path (verified working, Jun 2026).
  aeropass_transactions: {
    label: 'Aeropass Transactions',
    needsUuid:  true,
    startPath:  (cid, jobId, uuid) => `/v2/users/${uuid}/connections/${cid}/transactions/jobs`,
    resultPath: (cid, jobId, uuid) => `/v2/users/${uuid}/connections/${cid}/transactions`,
    unwrap:     d => ({ transactions: d.transactions || [], count: d.count, nextPage: d.next_page || null }),
  },
};

function aerosyncErrorCode(d) {
  return d?.error?.code || d?.code || d?.errorCode || null;
}

// Collapses every spelling Aerosync uses ("Pending MFA", "pending_mfa", "Completed",
// "in_progress", "Initiated"...) into four states the browser acts on.
function normalizeJobStatus(d) {
  const raw = String(d?.jobStatus || d?.job_status || d?.data?.jobStatus || d?.data?.status
    || d?.identityStatus || d?.account?.refreshStatus || d?.transactionStatus || '').trim();
  const s   = raw.toLowerCase().replace(/[\s-]+/g, '_');
  let status = 'running';
  if (s.includes('mfa'))                                                   status = 'pending_mfa';
  else if (['done', 'completed', 'complete', 'success'].includes(s))       status = 'completed';
  else if (['failed', 'failure', 'error', 'expired', 'timed_out', 'timeout', 'cancelled', 'canceled'].includes(s)) status = 'failed';
  return { status, rawStatus: raw || null };
}

function validJobParams(req, res) {
  const { connectionId, jobId } = req.params;
  if (!ID_PATTERN.test(connectionId || '')) { res.status(400).json({ error: 'Invalid connectionId' }); return false; }
  if (jobId !== undefined && !ID_PATTERN.test(jobId)) { res.status(400).json({ error: 'Invalid jobId' }); return false; }
  return true;
}

// Start a job. Returns the jobId immediately — no waiting.
app.post('/api/jobs/:connectionId', async (req, res) => {
  if (!validJobParams(req, res)) return;
  const type = req.body?.type;
  const def  = Object.prototype.hasOwnProperty.call(JOB_TYPES, type) ? JOB_TYPES[type] : null;
  if (!def) return res.status(400).json({ error: `Unknown job type. Use one of: ${Object.keys(JOB_TYPES).join(', ')}` });
  const uuid = req.body?.uuid;
  if (def.needsUuid && !ID_PATTERN.test(uuid || '')) return res.status(400).json({ error: 'Invalid or missing uuid' });
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const cid        = req.params.connectionId;
    const url        = `${AEROSYNC_BASE}${def.startPath(cid, null, uuid)}`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const body       = def.startBody ? def.startBody() : undefined;
    const r    = await fetch(url, { method: 'POST', headers: reqHeaders, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    debugLog.push({ service: 'AeroSync', label: `POST ${def.label} Job`, request: { method: 'POST', url, headers: redactCreds(reqHeaders), body }, response: { status: r.status, body: data } });

    const code = aerosyncErrorCode(data);
    // A job is already running on this connection. Passed back as-is so the caller decides what to do.
    if (r.status === 409 || code === 'AC-112') {
      return res.status(409).json({ code: 'AC-112', error: 'A job is already running on this connection', aerosyncResponse: data, _debug: debugLog });
    }
    // Data type not available for this account (manually linked or unsupported)
    if (r.status === 405 || ['AC-111', 'AC-114', 'AC-115'].includes(code)) {
      return res.status(405).json({ code, error: `${def.label} is not available for this account (manually linked or unsupported)`, _debug: debugLog });
    }
    // Balance refresh nests its job under 'account' (observed in sandbox, Nov 2026); identity and transactions don't
    const jobId = data.jobId || data.job_id || data.data?.jobId || data.data?.job_id || data.account?.jobId || data.account?.job_id;
    if (!r.ok || !jobId) {
      return res.status(r.ok ? 502 : r.status).json({ code, error: data?.error?.message || `Aerosync did not start the ${def.label.toLowerCase()} job (HTTP ${r.status})`, aerosyncResponse: data, _debug: debugLog });
    }
    res.json({ type, jobId, ...normalizeJobStatus(data), _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check a job's status once. The browser calls this on an interval.
app.get('/api/jobs/:connectionId/:jobId', async (req, res) => {
  if (!validJobParams(req, res)) return;
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const { connectionId: cid, jobId } = req.params;
    const url        = `${AEROSYNC_BASE}/v2/accounts/${cid}/job/${jobId}`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const r    = await fetch(url, { headers: reqHeaders });
    const data = await r.json().catch(() => ({}));
    debugLog.push({ service: 'AeroSync', label: 'GET Job Status', request: { method: 'GET', url, headers: redactCreds(reqHeaders) }, response: { status: r.status, body: data } });
    if (!r.ok) {
      return res.status(502).json({ code: aerosyncErrorCode(data), error: data?.error?.message || `Job status check failed (HTTP ${r.status})`, _debug: debugLog });
    }
    res.json({ jobId, ...normalizeJobStatus(data), mfaTriggered: data.mfaTriggered ?? null, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch a finished job's data.
app.get('/api/jobs/:connectionId/:jobId/result', async (req, res) => {
  if (!validJobParams(req, res)) return;
  const type = req.query.type;
  const def  = Object.prototype.hasOwnProperty.call(JOB_TYPES, type) ? JOB_TYPES[type] : null;
  if (!def) return res.status(400).json({ error: `Unknown job type. Use one of: ${Object.keys(JOB_TYPES).join(', ')}` });
  const uuid = req.query.uuid;
  if (def.needsUuid && !ID_PATTERN.test(uuid || '')) return res.status(400).json({ error: 'Invalid or missing uuid' });
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const { connectionId: cid, jobId } = req.params;
    const url        = `${AEROSYNC_BASE}${def.resultPath(cid, jobId, uuid)}`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const r    = await fetch(url, { headers: reqHeaders });
    const data = await r.json().catch(() => ({}));
    debugLog.push({ service: 'AeroSync', label: `GET ${def.label}`, request: { method: 'GET', url, headers: redactCreds(reqHeaders) }, response: { status: r.status, body: data } });
    // A 200 can still carry an error object — check before treating it as data
    if (!r.ok || data.error) {
      return res.status(502).json({ code: aerosyncErrorCode(data), error: data?.error?.message || `Could not fetch ${def.label.toLowerCase()} (HTTP ${r.status})`, _debug: debugLog });
    }
    res.json({ type, data: def.unwrap(data), _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync Aeropass: list all connections for a user ────────────────────────
// User-scoped (keyed by aeroPassUserUuid) — shows every bank a user has linked.
app.get('/api/aerosync/users/:uuid/connections', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const { uuid }   = req.params;
    const url        = `${AEROSYNC_BASE}/v2/users/${uuid}/connections`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const r    = await fetch(url, { headers: reqHeaders });
    const data = await r.json();
    debugLog.push({ service: 'AeroSync', label: 'GET Aeropass Connections', request: { method: 'GET', url, headers: redactCreds(reqHeaders) }, response: { status: r.status, body: data } });
    if (!r.ok || data.error) {
      return res.status(r.status >= 400 ? r.status : 502).json({ error: data?.error?.message || 'Failed to list connections', _debug: debugLog });
    }
    res.json({ connections: data.connections || [], _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync Aeropass: get transactions for one of a user's connections ────────
// First page: starts a refresh job (user-scoped) → polls via pollJob (connection-scoped
// status path, verified working) → fetches results. Subsequent pages: pass ?next_page
// to skip the job and fetch the next page directly. Optional ?start_date & ?end_date.
app.get('/api/aerosync/users/:uuid/connections/:connectionId/transactions', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const { uuid, connectionId: cid } = req.params;
    const { start_date, end_date, next_page } = req.query;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };

    // First page only: kick off + poll a refresh job. Pagination requests skip this.
    if (!next_page) {
      const startUrl = `${AEROSYNC_BASE}/v2/users/${uuid}/connections/${cid}/transactions/jobs`;
      let jobId = null;
      const startDeadline = Date.now() + 90000;

      // Linking a bank kicks off AeroSync's own data-pull job, so a fresh start can return
      // AC-112 ("a job is already in progress"). Wait for the running job to clear, then start ours.
      while (true) {
        const startRes  = await fetch(startUrl, { method: 'POST', headers: reqHeaders });
        const startData = await startRes.json();
        debugLog.push({ service: 'AeroSync', label: 'POST Aeropass Tx Job', request: { method: 'POST', url: startUrl, headers: redactCreds(reqHeaders) }, response: { status: startRes.status, body: startData } });

        // Manually-linked / unsupported accounts (same codes the connection-scoped route handles)
        if (['AC-114', 'AC-115'].includes(startData?.error?.code) || startRes.status === 405) {
          return res.status(405).json({ error: 'Transaction history is not available for this account (manually linked or unsupported)', _debug: debugLog });
        }
        // A job is already running for this connection (e.g. the post-link data pull) — wait and retry
        if (startRes.status === 409 || startData?.error?.code === 'AC-112') {
          if (Date.now() >= startDeadline) {
            return res.status(504).json({ error: 'A transactions job is already running for this connection; timed out waiting for it to finish', _debug: debugLog });
          }
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (startData?.error || startRes.status >= 400) {
          return res.status(startRes.status >= 400 ? startRes.status : 502).json({ error: startData?.error?.message || `AeroSync error ${startRes.status}`, aerosyncResponse: startData, _debug: debugLog });
        }
        jobId = startData.job_id || startData.jobId || startData.data?.job_id || startData.data?.jobId;
        if (!jobId) return res.status(500).json({ error: 'No job_id in AeroSync start response', aerosyncResponse: startData, _debug: debugLog });
        break;
      }

      const poll = await pollJob(cid, jobId, token, debugLog);
      if (!poll.done) return res.status(500).json({ error: poll.error?.message || 'Transactions job failed or timed out', _debug: debugLog });
    }

    // Fetch the page (first or subsequent)
    const qs = new URLSearchParams();
    if (start_date) qs.set('start_date', start_date);
    if (end_date)   qs.set('end_date', end_date);
    if (next_page)  qs.set('next_page', next_page);
    const getUrl = `${AEROSYNC_BASE}/v2/users/${uuid}/connections/${cid}/transactions${qs.toString() ? '?' + qs.toString() : ''}`;
    const getRes = await fetch(getUrl, { headers: reqHeaders });
    const data   = await getRes.json();
    debugLog.push({ service: 'AeroSync', label: 'GET Aeropass Transactions', request: { method: 'GET', url: getUrl, headers: redactCreds(reqHeaders) }, response: { status: getRes.status, body: data } });

    // A 200 can still carry an error object (e.g. AC-500) — check before treating as data
    if (data.error) {
      return res.status(502).json({ error: `AeroSync error fetching transactions: ${data.error.message} (${data.error.code})`, _debug: debugLog });
    }

    res.json({ data: data.transactions || [], count: data.count, nextPage: data.next_page || null, _debug: debugLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AeroSync Aeropass: delete stored transactions for a connection ─────────────
// Destructive. Clears stored transaction history; the bank connection stays linked.
app.delete('/api/aerosync/users/:uuid/connections/:connectionId/transactions', async (req, res) => {
  try {
    const debugLog   = [];
    const token      = await getAeroSyncToken(debugLog);
    const { uuid, connectionId: cid } = req.params;
    const url        = `${AEROSYNC_BASE}/v2/users/${uuid}/connections/${cid}/transactions`;
    const reqHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': process.env.AEROSYNC_API_KEY };
    const r    = await fetch(url, { method: 'DELETE', headers: reqHeaders });
    const data = await r.json();
    debugLog.push({ service: 'AeroSync', label: 'DELETE Aeropass Transactions', request: { method: 'DELETE', url, headers: redactCreds(reqHeaders) }, response: { status: r.status, body: data } });
    if (!r.ok || data.error) {
      return res.status(r.status >= 400 ? r.status : 502).json({ error: data?.error?.message || 'Delete failed', _debug: debugLog });
    }
    // deleted may legitimately be 0 (success, not failure). Normalize across possible field names.
    const deleted = data.deleted ?? data.deleted_count ?? data.count ?? null;
    res.json({ deleted, _debug: debugLog });
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
      debugLog.push({ service: 'Dwolla', label: 'POST /customers/:id/funding-sources', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: 201, body: { location, fundingSourceId } } });
      res.json({ fundingSourceId, location, _debug: debugLog });
    } else {
      const data = await response.json();
      debugLog.push({ service: 'Dwolla', label: 'POST /customers/:id/funding-sources', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: response.status, body: data } });
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
      debugLog.push({ service: 'Dwolla', label: 'POST /transfers', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: 201, body: { location, transferId } } });
      res.json({ transferId, location, _debug: debugLog });
    } else {
      const data = await response.json();
      debugLog.push({ service: 'Dwolla', label: 'POST /transfers', request: { method: 'POST', url, headers: redactCreds(reqHeaders), body: reqBody }, response: { status: response.status, body: data } });
      res.status(response.status).json({ ...data, _debug: debugLog });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
// Bound to this machine only. The app has no login, so nobody else on the same wifi
// should be able to reach it (for example, /api/dwolla/transfer).
app.listen(PORT, '127.0.0.1', () => console.log(`AeroSync test app running at http://localhost:${PORT}`));
