const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const webpush = require('web-push');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── VAPID (push notifications) ────────────────────────────────────────────────
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BEi-EHL3kKoeaRR9m3zbnQvkDs9n3GhnZXCOvE8P6Cwd3e_Yp6Hcso24sKtGKtdoiJ8DJc1HRNH25TzsRdjtP4A';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'y-5ZUzAiZwlGJ8uE8Gy98UjruNhmXdqx1cj4XJsz-l8';
webpush.setVapidDetails('mailto:medra@stagove.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ── DATABASE (only push subscriptions + reminder schedule — NO health data) ───
const initSqlJs = require('sql.js');
const DB_PATH = process.env.DB_PATH || './medra.db';
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) db = new SQL.Database(fs.readFileSync(DB_PATH));
  else db = new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      subscription TEXT NOT NULL,
      remind_at TEXT,
      last_daily_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  save();
  console.log('Database ready');
}

function save() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function run(sql, p = []) { db.run(sql, p); save(); }
function get(sql, p = []) { const s = db.prepare(sql); s.bind(p); const r = s.step() ? s.getAsObject() : null; s.free(); return r; }
function all(sql, p = []) { const s = db.prepare(sql); s.bind(p); const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows; }

// ── ENV ───────────────────────────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_API_KEY;

// ── GROQ VISION ───────────────────────────────────────────────────────────────
async function analyzeLabImage(base64Image, mediaType) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 2500, temperature: 0.1,
      messages: [
        { role: 'system', content: `You are a medical lab result analyzer. Extract ALL test values from the image (may be Bulgarian or English). Return ONLY valid JSON:\n{"tests":[{"name":"","value":"","reference":"","status":"NORMAL|HIGH|LOW","note":""}],"overallStatus":"ALL_NORMAL|ATTENTION_NEEDED|CONSULT_URGENTLY","specialistRecommendation":"","summary":"2-3 sentences plain language"}` },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64Image}` } }, { type: 'text', text: 'Analyze and return JSON only.' }] }
      ]
    })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content.trim().replace(/```json|```/g, ''));
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Analyze image (image passes through, never stored)
app.post('/api/analyze', async (req, res) => {
  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'Няма изображение.' });
    const analysis = await analyzeLabImage(image, mediaType || 'image/jpeg');
    if (!analysis.tests || !analysis.overallStatus) return res.status(422).json({ error: 'Моделът не успя да разпознае изследванията.' });
    res.json({ ok: true, analysis });
  } catch (e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: 'Грешка при анализ. Опитайте с по-ясна снимка.' });
  }
});

// Save push subscription + reminder schedule
app.post('/api/push/subscribe', (req, res) => {
  try {
    const { deviceId, subscription, remindInDays } = req.body;
    if (!deviceId || !subscription) return res.status(400).json({ error: 'Missing data' });
    const remindAt = remindInDays ? new Date(Date.now() + remindInDays * 86400000).toISOString() : null;
    const existing = get(`SELECT id FROM push_subs WHERE device_id = ?`, [deviceId]);
    if (existing) {
      run(`UPDATE push_subs SET subscription = ?, remind_at = ?, last_daily_at = NULL WHERE device_id = ?`, [JSON.stringify(subscription), remindAt, deviceId]);
    } else {
      run(`INSERT INTO push_subs (device_id, subscription, remind_at) VALUES (?, ?, ?)`, [deviceId, JSON.stringify(subscription), remindAt]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Subscribe error:', e.message);
    res.status(500).json({ error: 'Грешка.' });
  }
});

// Reset reminder (user uploaded new results or confirmed doctor visit)
app.post('/api/push/reset', (req, res) => {
  try {
    const { deviceId, remindInDays } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
    const remindAt = remindInDays ? new Date(Date.now() + remindInDays * 86400000).toISOString() : null;
    run(`UPDATE push_subs SET remind_at = ?, last_daily_at = NULL WHERE device_id = ?`, [remindAt, deviceId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Грешка.' });
  }
});

app.get('/api/vapid', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'Medra by StaGove' }));

// ── CRON: send reminder push notifications ────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const due = all(`SELECT * FROM push_subs WHERE remind_at IS NOT NULL AND remind_at <= ?`, [now]);

  for (const sub of due) {
    // Already sent today?
    if ((sub.last_daily_at || '').slice(0, 10) === today) continue;

    const payload = JSON.stringify({
      title: 'Medra — време за изследвания',
      body: 'Време е за нови изследвания. Отворете Medra и качете новите резултати.',
      url: '/'
    });

    try {
      await webpush.sendNotification(JSON.parse(sub.subscription), payload);
      run(`UPDATE push_subs SET last_daily_at = ? WHERE id = ?`, [now, sub.id]);
    } catch (e) {
      // Subscription expired — remove it
      if (e.statusCode === 410 || e.statusCode === 404) {
        run(`DELETE FROM push_subs WHERE id = ?`, [sub.id]);
      } else {
        console.error('Push error:', e.message);
      }
    }
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`Medra on port ${PORT}`)));
