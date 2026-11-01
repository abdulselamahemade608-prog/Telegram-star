/**
 * Telegram Stars shop — Mini App backend (no admin).
 * Express + Postgres. Payment: Crypto Pay (USDT). Delivery: Fragment API.
 * Needs a PERSISTENT host (Render / Railway / VPS) — NOT serverless (Vercel),
 * because the delivery worker runs in the background for up to a few minutes.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

// ------------------------------------------------------------- config ------
function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
const BOT_TOKEN = need('BOT_TOKEN');
const CRYPTO_PAY_TOKEN = need('CRYPTO_PAY_TOKEN');
const CRYPTO_PAY_HOST = process.env.CRYPTO_PAY_HOST || 'https://pay.crypt.bot';
const FRAGMENT_URL = (process.env.FRAGMENT_API_URL || 'https://api.fragment-api.space').replace(/\/+$/, '');
const SEED_B64 = Buffer.from(need('FRAGMENT_SEED_PHRASE').trim()).toString('base64');
const ACCOUNT_INDEX = (process.env.FRAGMENT_ACCOUNT_INDEX || '').trim();
const PAY_METHOD = process.env.FRAGMENT_PAYMENT_METHOD || 'ton'; // ton | usdt_ton
const WEBAPP_URL = need('WEBAPP_URL'); // public https URL of this server
const PRICE = parseFloat(process.env.PRICE_PER_STAR_USD || '0.02');
const MIN_STARS = Math.max(50, parseInt(process.env.MIN_STARS || '50', 10)); // Fragment minimum = 50
const MAX_STARS = parseInt(process.env.MAX_STARS || '5000', 10);
const PACKAGES = (process.env.PACKAGES || '50,100,250,500,1000').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
const INVOICE_TTL = 1800; // seconds
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: need('DATABASE_URL'),
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usdFor = (stars) => Math.round(stars * PRICE * 100) / 100;
const USERNAME_RE = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/;

// ------------------------------------------------------------- helpers -----
async function tg(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`Telegram ${method}: ${d.description}`);
  return d.result;
}
const notify = (chatId, text) => tg('sendMessage', { chat_id: chatId, text }).catch((e) => console.warn('notify failed', e.message));

async function cryptoPay(method, params = {}) {
  const r = await fetch(`${CRYPTO_PAY_HOST}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`CryptoPay ${method}: ${JSON.stringify(d.error)}`);
  return d.result;
}

// Compare-and-set status: prevents double delivery.
async function cas(id, from, to, detail = null) {
  const r = await pool.query(
    `UPDATE orders SET status=$3, detail=COALESCE($4, detail), updated_at=now()
     WHERE id=$1 AND status=$2 RETURNING id`,
    [id, from, to, detail]
  );
  return r.rowCount === 1;
}

// Validate Telegram Mini App initData (HMAC) and return the user object.
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (age > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

function auth(req, res, next) {
  const u = verifyInitData(req.get('x-init-data'));
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.tgUser = u;
  next();
}

// ------------------------------------------------------------- fragment ----
const OK_STATES = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'finished', 'sent', 'delivered']);
const FAIL_STATES = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected']);
const parse = (t) => { try { return JSON.parse(t); } catch { return { raw: t }; } };

/** returns [outcome, detail]; outcome: ok | fail (money NOT spent) | uncertain (never auto-retry) */
async function fragmentBuy(username, stars) {
  const body = { username: '@' + username, amount: stars, seed: SEED_B64, payment_method: PAY_METHOD };
  if (ACCOUNT_INDEX !== '') body.account_index = Number(ACCOUNT_INDEX);

  let status, text;
  try {
    const r = await fetch(`${FRAGMENT_URL}/api/v1/stars/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    return ['uncertain', 'request error: ' + e.message];
  }
  const data = parse(text);
  if (text.toUpperCase().includes('UNCERTAIN')) return ['uncertain', text.slice(0, 400)];
  if (status >= 500) return ['uncertain', `HTTP ${status}: ${text.slice(0, 300)}`];
  if (status >= 400 || data.success === false || data.error) return ['fail', `HTTP ${status}: ${text.slice(0, 300)}`];

  const inner = data.data && typeof data.data === 'object' ? data.data : {};
  const rid = data.request_id || data.id || inner.request_id || inner.id;
  let st = String(data.status || inner.status || '').toLowerCase();
  if (OK_STATES.has(st) || (data.success === true && !rid)) return ['ok', text.slice(0, 300)];
  if (FAIL_STATES.has(st)) return ['fail', text.slice(0, 300)];
  if (!rid) return ['uncertain', 'unrecognized response: ' + text.slice(0, 300)];

  const deadline = Date.now() + 300000;
  let last = text;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const r = await fetch(`${FRAGMENT_URL}/api/v1/queue/${rid}`, { signal: AbortSignal.timeout(30000) });
      last = await r.text();
    } catch (e) { console.warn('queue poll error', e.message); continue; }
    const d = parse(last);
    const inn = d.data && typeof d.data === 'object' ? d.data : {};
    st = String(d.status || inn.status || '').toLowerCase();
    if (last.toUpperCase().includes('UNCERTAIN')) return ['uncertain', last.slice(0, 400)];
    if (OK_STATES.has(st)) return ['ok', last.slice(0, 300)];
    if (FAIL_STATES.has(st)) return ['fail', last.slice(0, 300)];
  }
  return ['uncertain', 'timeout waiting, last: ' + last.slice(0, 300)];
}

// ------------------------------------------------------------- delivery ----
let fragmentChain = Promise.resolve(); // one Fragment purchase at a time
function deliver(orderId) {
  fragmentChain = fragmentChain.then(() => doDeliver(orderId)).catch((e) => console.error('deliver error', e));
  return fragmentChain;
}

async function doDeliver(orderId) {
  if (!(await cas(orderId, 'paid', 'delivering'))) return;
  const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
  const o = rows[0];
  const usd = parseFloat(o.usd);
  await notify(o.user_id, `✅ ክፍያ ደርሷል (ትዕዛዝ #${o.id})። ${o.stars} Stars ወደ @${o.username} በመላክ ላይ ነው… ⏳`);

  const [outcome, detail0] = await fragmentBuy(o.username, o.stars);
  console.log(`order ${o.id}: ${outcome} ${detail0}`);

  if (outcome === 'ok') {
    await cas(o.id, 'delivering', 'delivered', detail0);
    await notify(o.user_id, `🎉 ተሳክቷል! ${o.stars} ⭐ Stars ወደ @${o.username} ተልኳል። እናመሰግናለን!`);
  } else if (outcome === 'fail') {
    let detail = detail0, refunded = false;
    try {
      await cryptoPay('transfer', { user_id: Number(o.user_id), asset: 'USDT', amount: usd.toFixed(2), spend_id: `refund-${o.id}` });
      refunded = true;
    } catch (e) { detail += ' | refund error: ' + e.message; }
    await cas(o.id, 'delivering', 'failed', detail + (refunded ? ' | refunded' : ' | NOT refunded'));
    await notify(
      o.user_id,
      refunded
        ? `❌ ትዕዛዝ #${o.id} አልተሳካም። ክፍያዎ (${usd.toFixed(2)} USDT) ወደ @CryptoBot ዋሌትዎ ተመልሷል።`
        : `❌ ትዕዛዝ #${o.id} አልተሳካም። ክፍያዎ እንዲመለስ የትዕዛዝ ቁጥሩን ይያዙ።`
    );
  } else {
    await cas(o.id, 'delivering', 'check_needed', detail0);
    await notify(o.user_id, `⚠️ ትዕዛዝ #${o.id} ሁኔታው አልተረጋገጠም። Stars በቅርቡ ሊደርስ ይችላል። ድጋሚ አይክፈሉ፤ የትዕዛዝ ቁጥሩን ይያዙ።`);
  }
}

// Check Crypto Pay for pending invoices (all, or only given order ids)
async function refreshPending(onlyIds = null) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE status='pending' AND invoice_id IS NOT NULL ${onlyIds ? 'AND id = ANY($1)' : ''}`,
    onlyIds ? [onlyIds] : []
  );
  if (!rows.length) return;
  const result = await cryptoPay('getInvoices', { invoice_ids: rows.map((r) => r.invoice_id).join(','), count: 1000 });
  const items = Array.isArray(result) ? result : result.items || [];
  const byId = new Map(items.map((i) => [String(i.invoice_id), i]));
  for (const o of rows) {
    const inv = byId.get(String(o.invoice_id));
    if (!inv) continue;
    if (inv.status === 'paid') {
      if (await cas(o.id, 'pending', 'paid')) deliver(o.id);
    } else if (inv.status === 'expired') {
      if (await cas(o.id, 'pending', 'expired')) {
        await notify(o.user_id, `⌛ ትዕዛዝ #${o.id} ጊዜው አልፏል። አዲስ ትዕዛዝ ይፍጠሩ።`);
      }
    }
  }
}

async function watcher() {
  // recovery after restart
  await pool.query(`UPDATE orders SET status='check_needed', detail='server restarted during delivery - verify wallet manually', updated_at=now() WHERE status='delivering'`);
  const paid = await pool.query(`SELECT id FROM orders WHERE status='paid'`);
  paid.rows.forEach((r) => deliver(r.id));
  for (;;) {
    try { await refreshPending(); } catch (e) { console.warn('watcher error', e.message); }
    await sleep(8000);
  }
}

// ------------------------------------------------------------- api ---------
const app = express();
app.use(express.json({ limit: '10kb' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_req, res) => res.send('ok'));

app.get('/api/config', auth, (_req, res) => {
  res.json({ price: PRICE, min: MIN_STARS, max: MAX_STARS, packages: PACKAGES.map((s) => ({ stars: s, usd: usdFor(s) })) });
});

const publicOrder = (o) => ({
  id: o.id, stars: o.stars, username: o.username, usd: parseFloat(o.usd),
  status: o.status, pay_url: o.status === 'pending' ? o.pay_url : null,
  created_at: o.created_at,
});

app.post('/api/order', auth, async (req, res) => {
  try {
    const stars = parseInt(req.body.stars, 10);
    const m = USERNAME_RE.exec(String(req.body.username || '').trim());
    if (!Number.isInteger(stars) || stars < MIN_STARS || stars > MAX_STARS) return res.status(400).json({ error: 'bad_amount' });
    if (!m) return res.status(400).json({ error: 'bad_username' });

    const open = await pool.query(`SELECT count(*) FROM orders WHERE user_id=$1 AND status='pending' AND created_at > now() - interval '30 minutes'`, [req.tgUser.id]);
    if (parseInt(open.rows[0].count, 10) >= 5) return res.status(429).json({ error: 'too_many_pending' });

    const usd = usdFor(stars);
    const ins = await pool.query(
      `INSERT INTO orders (user_id, username, stars, usd) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.tgUser.id, m[1], stars, usd]
    );
    const o = ins.rows[0];
    try {
      const inv = await cryptoPay('createInvoice', {
        asset: 'USDT', amount: usd.toFixed(2),
        description: `${stars} Telegram Stars for @${m[1]}`,
        payload: String(o.id), allow_comments: false, allow_anonymous: false, expires_in: INVOICE_TTL,
      });
      const url = inv.bot_invoice_url || inv.pay_url || inv.mini_app_invoice_url;
      const up = await pool.query(`UPDATE orders SET invoice_id=$2, pay_url=$3 WHERE id=$1 RETURNING *`, [o.id, inv.invoice_id, url]);
      res.json(publicOrder(up.rows[0]));
    } catch (e) {
      console.error('createInvoice failed', e.message);
      await pool.query(`UPDATE orders SET status='failed', detail=$2 WHERE id=$1`, [o.id, e.message]);
      res.status(502).json({ error: 'invoice_failed' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/orders', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 15', [req.tgUser.id]);
  res.json(rows.map(publicOrder));
});

app.get('/api/orders/:id', auth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let { rows } = await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [id, req.tgUser.id]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  if (rows[0].status === 'pending') {
    try {
      await refreshPending([id]);
      ({ rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [id]));
    } catch (e) { console.warn('manual refresh failed', e.message); }
  }
  res.json(publicOrder(rows[0]));
});

// ------------------------------------------------------------- bot ---------
async function botLoop() {
  await tg('deleteWebhook').catch(() => {});
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '⭐ Stars ግዛ', web_app: { url: WEBAPP_URL } } }).catch((e) => console.warn(e.message));
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (m && m.text && m.text.startsWith('/start')) {
          await tg('sendMessage', {
            chat_id: m.chat.id,
            text: '👋 እንኳን ደህና መጡ!\n\nTelegram Stars በUSDT ይግዙ — ክፍያው እንደደረሰ ራሱ ይላካል። ከታች ያለውን ቁልፍ ይጫኑ 👇',
            reply_markup: { inline_keyboard: [[{ text: '⭐ Stars ግዛ', web_app: { url: WEBAPP_URL } }]] },
          });
        }
      }
    } catch (e) {
      console.warn('botLoop error', e.message);
      await sleep(3000);
    }
  }
}

// ------------------------------------------------------------- start -------
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      stars INTEGER NOT NULL,
      usd NUMERIC(10,2) NOT NULL,
      invoice_id BIGINT,
      pay_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  app.listen(PORT, () => console.log('Server on :' + PORT));
  watcher();
  botLoop();
})().catch((e) => { console.error(e); process.exit(1); });
  
