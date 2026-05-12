// Webhook: Receives Excel attachment from Power Automate, syncs to Firebase
// POST body: { "fileName": "...", "fileContent": "<base64>", "emailFrom": "...", "emailSubject": "..." }
// Header: x-webhook-secret must match WEBHOOK_SECRET env var

const XLSX = require('xlsx');

const FIREBASE_DB_URL = 'https://warehouse-space-dashboard-default-rtdb.europe-west1.firebasedatabase.app';
const EXCEL_SHEET_NAME = 'Details';

const ORIG_HDRS = [
  'Invoice Date', 'Location', 'Invoice No. (Green Highlited Posted in ERP)',
  'Shipping Mode', 'Tracking no.', 'SKU', 'Total Pcs/Qty.', 'Value',
  'Freight/Insurance value', 'VAT by Vendor', '3rd Party Freight/Commission',
  'Total Value', 'Carrier Duty', 'Carrier Freight/commision/demmurage/detention',
  'VAT', 'ERP Posted Date', 'Status', 'ETA and Delivery Date', 'GRN NO.',
  'GIN NO.', 'PO No.', 'Category', 'BOX/Ctn', 'Remark', 'Final Status',
  'Vendor book in System', 'Financial Year', 'Prod Info Sheet', 'Remarks',
  'POA/German Tranlation provide/Status', 'Actual ETA On PORT Date',
  'ETA Given by Supplier', 'Shipping Company/Container Num', 'Agent Name',
  'Payment Status'
];
const ORIG_KEYS = [
  'dt', 'loc', 'inv', 'mode', 'trk', 'sku', 'qty', 'val', 'frt', 'vat',
  'tpf', 'tval', 'cduty', 'cfrt', 'vat2', 'erpdt', 'sts', 'eta', 'grn',
  'gin', 'po', 'cat', 'box', 'rmk', 'fsts', 'vnd', 'fy', 'pis', 'rmk2',
  'poa', 'aeta', 'seta', 'cont', 'agt', 'psts'
];
const DATE_FIELDS = ['dt', 'eta', 'aeta', 'seta', 'erpdt'];
const NUM_FIELDS = ['val', 'frt', 'vat', 'tpf', 'tval', 'cduty', 'cfrt', 'vat2', 'qty', 'sku'];

const KEY_MAP = {};
ORIG_HDRS.forEach((h, i) => { KEY_MAP[h.toLowerCase().trim()] = ORIG_KEYS[i]; });
const SHORT_MAP = {
  'date': 'dt', 'invoice date': 'dt', 'invoice': 'inv', 'invoice no': 'inv',
  'invoice no.': 'inv', 'mode': 'mode', 'shipping mode': 'mode',
  'tracking': 'trk', 'tracking no': 'trk', 'tracking no.': 'trk',
  'qty': 'qty', 'total pcs/qty': 'qty', 'total pcs/qty.': 'qty',
  'value': 'val', 'freight': 'frt', 'freight/insurance value': 'frt',
  'total value': 'tval', 'status': 'sts', 'final status': 'fsts',
  'eta': 'eta', 'eta and delivery date': 'eta', 'grn': 'grn',
  'grn no': 'grn', 'grn no.': 'grn', 'gin': 'gin', 'gin no': 'gin',
  'gin no.': 'gin', 'po': 'po', 'po no': 'po', 'po no.': 'po',
  'category': 'cat', 'box/ctn': 'box', 'box': 'box', 'boxes': 'box',
  'remark': 'rmk', 'vendor': 'vnd', 'vendor book in system': 'vnd',
  'fy': 'fy', 'financial year': 'fy', 'actual eta': 'aeta',
  'actual eta on port date': 'aeta', 'supplier eta': 'seta',
  'eta given by supplier': 'seta', 'container': 'cont',
  'shipping company/container num': 'cont', 'agent': 'agt',
  'agent name': 'agt', 'payment status': 'psts', 'vat by vendor': 'vat',
  '3rd party freight/commission': 'tpf', 'carrier duty': 'cduty',
  'carrier freight': 'cfrt', 'vat': 'vat2', 'erp posted date': 'erpdt',
  'prod info sheet': 'pis', 'remarks': 'rmk2',
  'poa/german tranlation provide/status': 'poa', 'poa': 'poa'
};
Object.assign(KEY_MAP, SHORT_MAP);

const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

function mapHeader(h) { return KEY_MAP[h.toLowerCase().trim()] || null; }

function parseNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  if (s.startsWith('=')) return 0;
  s = s.replace(/[€$£¥₹\s\u00A0]/g, '').replace(/EUR|USD|GBP|INR/gi, '').trim();
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (dots > 1 && commas === 0) s = s.replace(/\./g, '');
  else if (commas > 1 && dots === 0) s = s.replace(/,/g, '');
  else if (dots > 0 && commas > 0 && lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (dots > 0 && commas > 0 && lastDot > lastComma) s = s.replace(/,/g, '');
  else if (commas === 1 && dots === 0) { const a = s.substring(lastComma + 1); s = a.length <= 2 ? s.replace(',', '.') : s.replace(/,/g, ''); }
  else if (dots === 1 && commas === 0) { const a = s.substring(lastDot + 1); if (a.length === 3 && s.length > 4) s = s.replace('.', ''); }
  const n = parseFloat(s); return isNaN(n) ? 0 : n;
}

function parseAnyDate(val) {
  if (!val) return null; val = String(val).trim();
  if (!val || ['not available', 'n/a', 'tbc', 'tba', '-'].includes(val.toLowerCase())) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.substring(0, 10);
  if (/^\d{5}$/.test(val)) { const d = new Date((parseInt(val) - 25569) * 86400000); if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10); }
  const m1 = val.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{2,4})$/);
  if (m1) { const day = parseInt(m1[1]), mon = MONTH_MAP[m1[2].toLowerCase()]; let yr = parseInt(m1[3]); if (mon) { if (yr < 100) yr = yr < 50 ? 2000 + yr : 1900 + yr; return yr + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0'); } }
  const m2 = val.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m2) { const a = parseInt(m2[1]), b = parseInt(m2[2]), yr = parseInt(m2[3]); if (a > 12) return yr + '-' + String(b).padStart(2, '0') + '-' + String(a).padStart(2, '0'); if (b > 12) return yr + '-' + String(a).padStart(2, '0') + '-' + String(b).padStart(2, '0'); return yr + '-' + String(b).padStart(2, '0') + '-' + String(a).padStart(2, '0'); }
  const m3 = val.match(/^(\d{4}-\d{2}-\d{2})[T ]/); if (m3) return m3[1];
  const d = new Date(val); if (!isNaN(d.getTime()) && d.getFullYear() > 1900) return d.toISOString().substring(0, 10); return null;
}

function parseExcelToRecords(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true });
  const wsName = wb.SheetNames.includes(EXCEL_SHEET_NAME) ? EXCEL_SHEET_NAME : wb.SheetNames[0];
  const ws = wb.Sheets[wsName];
  const rowsRaw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true, dateNF: 'yyyy-mm-dd' });
  const rowsFmt = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
  const rows = rowsRaw.map((r, i) => { const f = rowsFmt[i] || {}; const m = { ...r }; Object.keys(m).forEach(k => { const kl = k.toLowerCase(); if (kl.includes('date') || kl.includes('eta') || kl === 'erp posted date') { if (f[k] !== undefined && f[k] !== '') m[k] = f[k]; } }); return m; });
  const exHdrs = Object.keys(rows[0] || {}), mapped = exHdrs.map(h => mapHeader(h)), records = [];
  rows.forEach(row => {
    const rec = {};
    exHdrs.forEach((h, i) => { if (!mapped[i]) return; const rv = row[h]; if (rv === null || rv === undefined || rv === '') return; const key = mapped[i];
      if (NUM_FIELDS.includes(key)) { if (typeof rv === 'number') { rec[key] = String(Math.round(rv * 100) / 100); return; } const n = parseNum(rv); if (n > 0) rec[key] = String(Math.round(n * 100) / 100); return; }
      let v = String(rv).trim(); if (!v) return; if (DATE_FIELDS.includes(key)) { const p = parseAnyDate(v); if (p) v = p; } rec[key] = v; });
    if (!rec.tval || parseNum(rec.tval) <= 0) { const c = parseNum(rec.val) + parseNum(rec.frt) + parseNum(rec.vat) + parseNum(rec.tpf); if (c > 0) rec.tval = String(Math.round(c * 100) / 100); else if (rec.val && parseNum(rec.val) > 0) rec.tval = String(parseNum(rec.val)); } else { rec.tval = String(parseNum(rec.tval)); }
    if (rec.inv || rec.trk || rec.vnd) records.push(rec);
  });
  return records;
}

async function firebaseGet(p) { const r = await fetch(`${FIREBASE_DB_URL}/${p}.json`); if (!r.ok) throw new Error(`Firebase GET error: ${r.status}`); return r.json(); }
async function firebasePut(p, d) { const r = await fetch(`${FIREBASE_DB_URL}/${p}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }); if (!r.ok) throw new Error(`Firebase PUT error: ${r.status}`); return r.json(); }

function mergeRecords(existingData, newRecords) {
  const data = Array.isArray(existingData) ? [...existingData] : [];
  const invIdx = {}, trkIdx = {};
  data.forEach((r, i) => { if (r.inv) invIdx[r.inv.trim().toLowerCase()] = i; if (r.trk) { const ct = r.trk.replace(/[\s\-]/g, '').toLowerCase(); if (ct) trkIdx[ct] = i; } });
  let added = 0, updated = 0, skipped = 0, maxId = data.length ? Math.max(...data.map(x => x.id || 0)) : 0;
  newRecords.forEach(rec => {
    let mi = -1;
    if (rec.inv) { const k = rec.inv.trim().toLowerCase(); if (invIdx[k] !== undefined) mi = invIdx[k]; }
    if (mi < 0 && rec.trk) { const ct = rec.trk.replace(/[\s\-]/g, '').toLowerCase(); if (ct && trkIdx[ct] !== undefined) mi = trkIdx[ct]; }
    if (mi < 0) { rec.id = ++maxId; data.push(rec); if (rec.inv) invIdx[rec.inv.trim().toLowerCase()] = data.length - 1; if (rec.trk) { const ct = rec.trk.replace(/[\s\-]/g, '').toLowerCase(); if (ct) trkIdx[ct] = data.length - 1; } added++; }
    else { const ex = data[mi]; let ch = false;
      ['eta', 'aeta', 'seta'].forEach(f => { if (rec[f] && rec[f] !== ex[f]) { ex[f] = rec[f]; ch = true; } });
      if (rec.trk && rec.trk !== ex.trk) { ex.trk = rec.trk; ch = true; }
      if (rec.cont && rec.cont !== ex.cont) { ex.cont = rec.cont; ch = true; }
      if (rec.fsts && rec.fsts !== ex.fsts) { ex.fsts = rec.fsts; ch = true; }
      if (rec.sts && rec.sts !== ex.sts) { ex.sts = rec.sts; ch = true; }
      if (rec.psts && rec.psts !== ex.psts) { ex.psts = rec.psts; ch = true; }
      if (ch) updated++; else skipped++; }
  });
  return { data, added, updated, skipped };
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && event.headers['x-webhook-secret'] !== secret) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid webhook secret' }) };

  const log = [];
  try {
    log.push(`[${new Date().toISOString()}] Sync started`);
    const body = JSON.parse(event.body);
    if (!body.fileContent) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing fileContent' }) };
    log.push(`File: ${body.fileName || 'attachment.xlsx'}`);
    const buffer = Buffer.from(body.fileContent, 'base64');
    const newRecords = parseExcelToRecords(buffer);
    log.push(`Parsed ${newRecords.length} records`);
    if (!newRecords.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ status: 'empty', log }) };
    const existingData = await firebaseGet('shipments');
    log.push(`Firebase: ${Array.isArray(existingData) ? existingData.length : 0} existing`);
    const result = mergeRecords(existingData, newRecords);
    log.push(`${result.added} new, ${result.updated} updated, ${result.skipped} unchanged`);
    if (result.added > 0 || result.updated > 0) {
      await firebasePut('shipments', result.data);
      await firebasePut('meta/lastUpdated', new Date().toISOString());
      await firebasePut('meta/lastEmailSync', { timestamp: new Date().toISOString(), source: 'power-automate', emailSubject: body.emailSubject || '', emailFrom: body.emailFrom || '', fileName: body.fileName || '', recordsInFile: newRecords.length, added: result.added, updated: result.updated, skipped: result.skipped, totalAfterSync: result.data.length });
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ status: 'success', added: result.added, updated: result.updated, skipped: result.skipped, total: result.data.length, log }) };
  } catch (err) {
    log.push(`ERROR: ${err.message}`);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ status: 'error', error: err.message, log }) };
  }
};
