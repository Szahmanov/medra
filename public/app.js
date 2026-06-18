// Medra PWA — all data stored locally in IndexedDB
const STATUS = {
  ALL_NORMAL: { icon: '✅', label: 'Всички показатели в норма' },
  ATTENTION_NEEDED: { icon: '⚠️', label: 'Изисква внимание' },
  CONSULT_URGENTLY: { icon: '🔴', label: 'Консултирайте лекар' }
};

// ── DEVICE ID ─────────────────────────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('medra_device_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('medra_device_id', id); }
  return id;
}

// ── INDEXEDDB ─────────────────────────────────────────────────────────────────
let database;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('medra', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('results')) {
        db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => { database = e.target.result; resolve(database); };
    req.onerror = () => reject(req.error);
  });
}

function saveResult(record) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('results', 'readwrite');
    tx.objectStore('results').add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAllResults() {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('results', 'readonly');
    const req = tx.objectStore('results').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
    req.onerror = () => reject(req.error);
  });
}

// ── FILE HANDLING ─────────────────────────────────────────────────────────────
let selFile = null;
const dz = document.getElementById('dz');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });

function pickFile(f) {
  if (!f) return;
  if (!['image/jpeg','image/jpg','image/png','image/webp'].includes(f.type)) { toast('Моля качете снимка (JPG, PNG, WebP)', 'err'); return; }
  selFile = f;
  document.getElementById('fileName').textContent = f.name;
  document.getElementById('filePill').classList.add('show');
  document.getElementById('uploadBtn').disabled = false;
  dz.style.display = 'none';
}

function clearFile() {
  selFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('filePill').classList.remove('show');
  document.getElementById('uploadBtn').disabled = true;
  dz.style.display = 'block';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ── ANALYZE ───────────────────────────────────────────────────────────────────
async function doAnalyze() {
  if (!selFile) return;
  const btn = document.getElementById('uploadBtn');
  const lbl = document.getElementById('uploadLabel');
  const prog = document.getElementById('prog');
  const fill = document.getElementById('progFill');

  btn.disabled = true;
  lbl.innerHTML = '<span class="spin"></span> Анализ в ход...';
  prog.classList.add('show');
  let pct = 0;
  const ticker = setInterval(() => { pct = Math.min(pct + Math.random() * 7, 88); fill.style.width = pct + '%'; }, 400);

  try {
    const base64 = await fileToBase64(selFile);
    const dataUrl = await fileToDataUrl(selFile); // store image locally
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType: selFile.type })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    clearInterval(ticker);
    fill.style.width = '100%';
    setTimeout(() => { prog.classList.remove('show'); fill.style.width = '0'; }, 500);

    // Save everything locally — image + analysis
    const record = {
      uploadedAt: new Date().toISOString(),
      image: dataUrl,
      analysis: data.analysis
    };
    await saveResult(record);

    showResult(data.analysis);
    clearFile();
    lbl.textContent = 'Анализирай изследванията →';
    btn.disabled = true;
    loadHistory();
    toast('✓ Анализът е готов и запазен на устройството ви.');

    // Schedule reminder based on status
    scheduleReminder(data.analysis.overallStatus);
  } catch (e) {
    clearInterval(ticker);
    prog.classList.remove('show'); fill.style.width = '0';
    lbl.textContent = 'Анализирай изследванията →';
    btn.disabled = false;
    toast(e.message || 'Грешка при анализ.', 'err');
  }
}

// ── REMINDER SCHEDULING ───────────────────────────────────────────────────────
async function scheduleReminder(status) {
  // Days until reminder based on result severity
  const days = status === 'CONSULT_URGENTLY' ? 30 : status === 'ATTENTION_NEEDED' ? 60 : 180;
  const sub = await getPushSubscription();
  if (!sub) return; // notifications not enabled yet
  try {
    await fetch('/api/push/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId(), remindInDays: days })
    });
  } catch {}
}

// ── SHOW RESULT ───────────────────────────────────────────────────────────────
function showResult(a) {
  const meta = STATUS[a.overallStatus] || { icon: '📋', label: a.overallStatus };
  const head = document.getElementById('rpHead');
  head.className = 'rp-head ' + a.overallStatus;
  document.getElementById('rpIcon').textContent = meta.icon;
  document.getElementById('rpLabel').textContent = meta.label;
  document.getElementById('rpDate').textContent = 'Анализирано · ' + new Date().toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('rpSummary').textContent = a.summary;
  const spec = document.getElementById('rpSpec');
  if (a.specialistRecommendation) { spec.textContent = '👨‍⚕️ Препоръка: ' + a.specialistRecommendation; spec.style.display = 'block'; }
  else spec.style.display = 'none';
  document.getElementById('rpTests').innerHTML = renderTests(a.tests || []);
  const panel = document.getElementById('resultPanel');
  panel.classList.add('show');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTests(tests) {
  return tests.map(t => `<tr>
    <td>${esc(t.name)}</td>
    <td><strong style="color:var(--paper)">${esc(t.value)}</strong></td>
    <td style="color:rgba(248,247,242,.35)">${esc(t.reference)}</td>
    <td><span class="badge badge-${t.status}">${t.status}</span>${t.note ? `<div class="tnote">${esc(t.note)}</div>` : ''}</td>
  </tr>`).join('');
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const list = document.getElementById('histList');
  try {
    const items = await getAllResults();
    document.getElementById('histCount').textContent = items.length ? `${items.length} запис${items.length === 1 ? '' : 'а'}` : '';
    if (!items.length) { list.innerHTML = '<div class="hist-empty">Все още нямате качени изследвания.<br>Качете първите си резултати по-горе.</div>'; return; }
    list.innerHTML = items.map(item => {
      const meta = STATUS[item.analysis.overallStatus] || { icon: '📋' };
      const date = new Date(item.uploadedAt).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' });
      return `<div class="hist-item" id="hi${item.id}">
        <div class="hist-row" onclick="toggleHist('${item.id}')">
          <span class="hist-date">${date}</span>
          <span class="hist-text">${esc(item.analysis.summary.slice(0, 80))}${item.analysis.summary.length > 80 ? '...' : ''}</span>
          <span class="hist-status">${meta.icon}</span>
          <span class="chevron">›</span>
        </div>
        <div class="hist-body">
          ${item.image ? `<img class="hist-thumb" src="${item.image}" alt="Изследване">` : ''}
          <div class="summary-box" style="margin:0 0 14px">${esc(item.analysis.summary)}</div>
          ${item.analysis.specialistRecommendation ? `<div class="spec-box" style="margin-bottom:14px">👨‍⚕️ ${esc(item.analysis.specialistRecommendation)}</div>` : ''}
          <table class="tbl"><thead><tr><th>Показател</th><th>Стойност</th><th>Референция</th><th>Статус</th></tr></thead>
          <tbody>${renderTests(item.analysis.tests || [])}</tbody></table>
        </div>
      </div>`;
    }).join('');
  } catch { list.innerHTML = '<div class="hist-empty">Грешка при зареждане.</div>'; }
}

function toggleHist(id) { document.getElementById('hi' + id).classList.toggle('open'); }

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
async function getPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Вашият браузър не поддържа известия.', 'err');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Известията са отказани.', 'err'); return; }

    const reg = await navigator.serviceWorker.ready;
    const vapidRes = await fetch('/api/vapid');
    const { publicKey } = await vapidRes.json();

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId(), subscription: sub })
    });

    document.getElementById('notifBtn').classList.add('active');
    document.getElementById('notifBtn').innerHTML = '🔔 Включени';
    toast('✓ Известията са включени! Ще ви напомним за нови изследвания.');
  } catch (e) {
    console.error(e);
    toast('Грешка при включване на известия.', 'err');
  }
}

async function checkNotifStatus() {
  const sub = await getPushSubscription();
  if (sub && Notification.permission === 'granted') {
    document.getElementById('notifBtn').classList.add('active');
    document.getElementById('notifBtn').innerHTML = '🔔 Включени';
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch (e) { console.error(e); }
  }
  await openDB();
  await loadHistory();
  await checkNotifStatus();
}
init();
