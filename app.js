/* DIALOGIA — App complementaria
   BLE UUIDs propios del proyecto (para que Hardware los use en el firmware ESP32) */
const BLE_SERVICE   = 'ca8b3bf2-5c02-4762-83b3-bd335dc16159';
const CHAR_SENSOR    = 'ed56db78-fd3b-4aa5-99de-433620ea9149'; // notify: 5x uint16 flex + int16 imuX + int16 imuY + uint8 batt
const CHAR_SIGN      = '30f04a6c-7c91-4a49-8766-cb9f8453b9d0'; // notify: utf-8 string, palabra reconocida
const CHAR_CALIB     = 'eedefeda-2080-4a97-8d27-645b399c73b8'; // write: perfil de calibración
const CHAR_CMD       = '959ea506-cc98-4893-9424-48858d4034cf'; // write: comandos genéricos

document.getElementById('bleUuids').textContent =
`Servicio BLE:      ${BLE_SERVICE}
Char. sensores:    ${CHAR_SENSOR}   (notify, 15 bytes)
Char. seña:        ${CHAR_SIGN}     (notify, utf-8)
Char. calibración: ${CHAR_CALIB}    (write)
Char. comando:     ${CHAR_CMD}      (write)

Formato de CHAR_SENSOR (15 bytes, little-endian):
 [0-1]  pulgar  uint16
 [2-3]  índice  uint16
 [4-5]  medio   uint16
 [6-7]  anular  uint16
 [8-9]  meñique uint16
 [10-11] imuX   int16 (÷100 = g)
 [12-13] imuY   int16 (÷100 = g)
 [14]    batería uint8 (0-100)`;

/* ---------- Almacenamiento (window.storage con respaldo en localStorage) ---------- */
async function storeGet(key) {
  if (typeof window !== 'undefined' && window.storage) {
    try {
      const r = await window.storage.get(key, false);
      return r ? JSON.parse(r.value) : null;
    } catch (e) { return null; }
  }
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}
async function storeSet(key, value) {
  const json = JSON.stringify(value);
  if (typeof window !== 'undefined' && window.storage) {
    try { await window.storage.set(key, json, false); return true; } catch (e) { /* fall through */ }
  }
  try { localStorage.setItem(key, json); return true; } catch (e) { return false; }
}

/* ---------- Estado ---------- */
let connectionMode = null; // 'ble' | 'demo'
let bleDevice = null, bleServer = null, charSensor = null, charSign = null, charCalib = null, charCmd = null;
let lastRawFlex = [2048,2048,2048,2048,2048], lastImuX = 0, lastImuY = 0, lastBattery = null;
let calibrationProfile = [0,1,2,3,4].map(() => ({ min: 0, max: 4095 }));
let autoSpeak = true;
let signHistory = [];
let pendingSamples = [];
let demoTimer = null, demoIdx = 0, demoBattery = 100;

const FINGER_NAMES = ['Pulgar','Índice','Medio','Anular','Meñique'];
const DEMO_SIGNS = [
  { word: 'HOLA',    flex: [40,86,80,78,74], imu: [ 0.03,-0.12] },
  { word: 'SÍ',      flex: [15,22,88,86,84], imu: [ 0.24, 0.08] },
  { word: 'NO',      flex: [80,24,28,30,32], imu: [-0.19, 0.03] },
  { word: 'GRACIAS', flex: [34,14,11, 9, 7], imu: [ 0.11,-0.30] },
  { word: 'AYUDA',   flex: [88,82,20,18,84], imu: [-0.08, 0.21] }
];

/* ---------- Utilidades ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function rawToPercent(raw, idx) {
  const cal = calibrationProfile[idx] || { min: 0, max: 4095 };
  const range = Math.max(1, cal.max - cal.min);
  const pct = ((raw - cal.min) / range) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function setConnectionState(state, deviceName) {
  const badge = document.getElementById('connBadge');
  if (state === 'connected') {
    badge.textContent = '● Conectado' + (deviceName ? ' · ' + deviceName : '');
    badge.className = 'conn-badge conn-ok';
  } else if (state === 'demo') {
    badge.textContent = '● Modo demo';
    badge.className = 'conn-badge conn-demo';
  } else {
    badge.textContent = '○ Desconectado';
    badge.className = 'conn-badge conn-off';
  }
}

/* ---------- Texto a voz (real, Web Speech API) ---------- */
function speak(text) {
  if (!('speechSynthesis' in window) || !text || text === '···') return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'es-AR';
  utter.rate = 1;
  window.speechSynthesis.speak(utter);
}

/* ---------- Bluetooth real ---------- */
async function connectBLE() {
  if (!navigator.bluetooth) {
    throw new Error('Este navegador no soporta Bluetooth Web. Abrí esta app en Chrome para Android.');
  }
  bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [BLE_SERVICE] }],
    optionalServices: [BLE_SERVICE]
  });
  bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
  bleServer = await bleDevice.gatt.connect();
  const service = await bleServer.getPrimaryService(BLE_SERVICE);
  charSensor = await service.getCharacteristic(CHAR_SENSOR);
  charSign = await service.getCharacteristic(CHAR_SIGN);
  try { charCalib = await service.getCharacteristic(CHAR_CALIB); } catch (e) { charCalib = null; }
  try { charCmd = await service.getCharacteristic(CHAR_CMD); } catch (e) { charCmd = null; }

  await charSensor.startNotifications();
  charSensor.addEventListener('characteristicvaluechanged', onSensorNotify);
  await charSign.startNotifications();
  charSign.addEventListener('characteristicvaluechanged', onSignNotify);

  return bleDevice.name || 'DIALOGIA';
}
function onSensorNotify(event) {
  const v = event.target.value;
  try {
    const flex = [0,1,2,3,4].map(i => v.getUint16(i * 2, true));
    const imuX = v.getInt16(10, true) / 100;
    const imuY = v.getInt16(12, true) / 100;
    const battery = v.byteLength > 14 ? v.getUint8(14) : null;
    updateSensorUI(flex, imuX, imuY, battery);
  } catch (e) { /* trama inválida, se ignora */ }
}
function onSignNotify(event) {
  const word = new TextDecoder('utf-8').decode(event.target.value);
  handleRecognizedSign(word);
}
function onBleDisconnected() {
  connectionMode = null;
  setConnectionState('disconnected');
  toast('Se desconectó el guante');
}

/* ---------- Modo demo (sin hardware) ---------- */
function startDemoLoop() {
  applyDemoSign();
  demoTimer = setInterval(() => {
    demoIdx = (demoIdx + 1) % DEMO_SIGNS.length;
    applyDemoSign();
  }, 3500);
}
function applyDemoSign() {
  const s = DEMO_SIGNS[demoIdx];
  const raw = s.flex.map(p => Math.round((p / 100) * 4095));
  updateSensorUI(raw, s.imu[0], s.imu[1], demoBattery);
  handleRecognizedSign(s.word);
  if (demoBattery > 92 && Math.random() > 0.6) demoBattery--;
}

/* ---------- Actualización de UI compartida (real o demo) ---------- */
function updateSensorUI(rawFlex, imuX, imuY, battery) {
  lastRawFlex = rawFlex.slice();
  lastImuX = imuX; lastImuY = imuY;
  if (battery != null) lastBattery = battery;

  rawFlex.forEach((raw, i) => {
    const pct = rawToPercent(raw, i);
    const tb = document.getElementById('tbar' + i);
    if (tb) tb.style.height = pct + '%';
  });
  const imuEl = document.getElementById('imuReadout');
  if (imuEl) imuEl.textContent = `X: ${imuX >= 0 ? '+' : ''}${imuX.toFixed(2)}g · Y: ${imuY >= 0 ? '+' : ''}${imuY.toFixed(2)}g`;
  const battEl = document.getElementById('battReadout');
  if (battEl && lastBattery != null) battEl.textContent = '🔋 ' + lastBattery + '%';

  renderFingerRows();
}
function handleRecognizedSign(word) {
  const el = document.getElementById('oledWord');
  if (el) el.textContent = word;
  signHistory.unshift(word);
  signHistory = signHistory.slice(0, 6);
  renderHistory();
  if (autoSpeak) speak(word);
}
function renderHistory() {
  const row = document.getElementById('historyRow');
  if (!row) return;
  row.innerHTML = signHistory.map(w => `<span class="chip">${escapeHtml(w)}</span>`).join('');
}

/* ---------- Calibración ---------- */
function renderFingerRows() {
  const list = document.getElementById('fingerList');
  if (!list) return;
  list.innerHTML = FINGER_NAMES.map((name, i) => {
    const pct = rawToPercent(lastRawFlex[i], i);
    const cal = calibrationProfile[i];
    return `
      <div class="finger-row">
        <span class="finger-name">${name}</span>
        <div class="finger-bar-wrap"><div class="finger-bar-fill" style="width:${pct}%"></div></div>
        <span class="finger-val">${lastRawFlex[i]}</span>
        <div class="finger-actions">
          <button class="btn-mark" data-mark="min" data-i="${i}">mín</button>
          <button class="btn-mark" data-mark="max" data-i="${i}">máx</button>
        </div>
        <span class="cal-range">${cal.min}–${cal.max}</span>
      </div>`;
  }).join('');
  list.querySelectorAll('.btn-mark').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.i, 10);
      const type = btn.dataset.mark;
      calibrationProfile[i][type] = lastRawFlex[i];
      renderFingerRows();
      toast(`${FINGER_NAMES[i]}: ${type === 'min' ? 'mínimo' : 'máximo'} registrado`);
    });
  });
}
async function saveCalibration() {
  await storeSet('dialogia_calibration', calibrationProfile);
  if (charCalib) {
    try {
      const buf = new ArrayBuffer(20);
      const dv = new DataView(buf);
      calibrationProfile.forEach((c, i) => { dv.setUint16(i * 4, c.min, true); dv.setUint16(i * 4 + 2, c.max, true); });
      await charCalib.writeValue(buf);
    } catch (e) { /* el guante puede no estar escuchando; la calibración local igual queda guardada */ }
  }
  toast('Calibración guardada');
}
async function resetCalibration() {
  calibrationProfile = [0,1,2,3,4].map(() => ({ min: 0, max: 4095 }));
  await storeSet('dialogia_calibration', calibrationProfile);
  renderFingerRows();
  toast('Calibración restablecida');
}

/* ---------- Entrenamiento IA ---------- */
function captureSample() {
  pendingSamples.push({ flex: lastRawFlex.slice(), imuX: lastImuX, imuY: lastImuY, t: Date.now() });
  document.getElementById('pendingCount').textContent = String(pendingSamples.length);
  toast('Muestra capturada');
}
async function saveSign() {
  const input = document.getElementById('trainLabel');
  const label = input.value.trim();
  if (!label) { toast('Escribí una palabra primero'); return; }
  if (pendingSamples.length === 0) { toast('Capturá al menos una muestra'); return; }
  const dataset = (await storeGet('dialogia_dataset')) || {};
  dataset[label] = (dataset[label] || []).concat(pendingSamples);
  await storeSet('dialogia_dataset', dataset);
  pendingSamples = [];
  document.getElementById('pendingCount').textContent = '0';
  input.value = '';
  renderDataset();
  toast(`Seña "${label}" guardada`);
}
async function renderDataset() {
  const dataset = (await storeGet('dialogia_dataset')) || {};
  const el = document.getElementById('datasetList');
  const words = Object.keys(dataset);
  if (words.length === 0) {
    el.innerHTML = '<p class="muted-note">Todavía no guardaste señas entrenadas.</p>';
    return;
  }
  el.innerHTML = words.map(w =>
    `<div class="ds-row"><span>${escapeHtml(w)}</span><span class="ds-count">${dataset[w].length} muestra${dataset[w].length === 1 ? '' : 's'}</span></div>`
  ).join('');
}
async function exportDataset() {
  const dataset = (await storeGet('dialogia_dataset')) || {};
  if (Object.keys(dataset).length === 0) { toast('No hay datos para exportar todavía'); return; }
  const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'dialogia_dataset.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Dataset exportado');
}

/* ---------- Diccionario LSA ----------
   El vocabulario es intencionalmente chico para arrancar. Cada palabra
   enlaza a un buscador acotado a diccionarios oficiales de LSA (hechos
   junto a la comunidad sorda) en vez de inventar acá cómo es la seña. */
const SIGN_DICTIONARY = [
  { palabra: 'HOLA',      categoria: 'Básicas del guante', estadoGuante: 'listo',     nota: 'Saludo para arrancar una conversación.' },
  { palabra: 'AYUDA',     categoria: 'Básicas del guante', estadoGuante: 'listo',     nota: 'Para pedir asistencia o atención urgente.' },
  { palabra: 'SÍ',        categoria: 'Básicas del guante', estadoGuante: 'pendiente', nota: 'Afirmación.' },
  { palabra: 'NO',        categoria: 'Básicas del guante', estadoGuante: 'pendiente', nota: 'Negación.' },
  { palabra: 'GRACIAS',   categoria: 'Básicas del guante', estadoGuante: 'pendiente', nota: 'Agradecimiento.' },
  { palabra: 'POR FAVOR', categoria: 'Saludos y cortesía', estadoGuante: null,        nota: 'Para pedir algo con cortesía.' },
  { palabra: 'DE NADA',   categoria: 'Saludos y cortesía', estadoGuante: null,        nota: 'Respuesta a un agradecimiento.' },
  { palabra: 'CHAU',      categoria: 'Saludos y cortesía', estadoGuante: null,        nota: 'Despedida informal.' },
  { palabra: 'BUEN DÍA',  categoria: 'Saludos y cortesía', estadoGuante: null,        nota: 'Saludo por la mañana.' },
  { palabra: 'DISCULPA',  categoria: 'Saludos y cortesía', estadoGuante: null,        nota: 'Para pedir perdón o llamar la atención de alguien.' },

  { palabra: 'DOLOR',      categoria: 'Emergencias y salud', estadoGuante: null, nota: 'Para indicar que algo duele.' },
  { palabra: 'MÉDICO',     categoria: 'Emergencias y salud', estadoGuante: null, nota: 'Para pedir o mencionar a un médico.' },
  { palabra: 'HOSPITAL',   categoria: 'Emergencias y salud', estadoGuante: null, nota: 'Lugar de atención médica.' },
  { palabra: 'LLAMAR',     categoria: 'Emergencias y salud', estadoGuante: null, nota: 'Para pedir que se comuniquen con alguien.' },
  { palabra: 'EMERGENCIA', categoria: 'Emergencias y salud', estadoGuante: null, nota: 'Situación urgente.' },

  { palabra: 'MAMÁ',     categoria: 'Familia', estadoGuante: null, nota: 'Madre.' },
  { palabra: 'PAPÁ',     categoria: 'Familia', estadoGuante: null, nota: 'Padre.' },
  { palabra: 'HERMANO',  categoria: 'Familia', estadoGuante: null, nota: 'Hermano.' },
  { palabra: 'HERMANA',  categoria: 'Familia', estadoGuante: null, nota: 'Hermana.' },
  { palabra: 'FAMILIA',  categoria: 'Familia', estadoGuante: null, nota: 'Familia, en general.' },

  { palabra: 'UNO',    categoria: 'Números', estadoGuante: null, nota: 'Número 1.' },
  { palabra: 'DOS',    categoria: 'Números', estadoGuante: null, nota: 'Número 2.' },
  { palabra: 'TRES',   categoria: 'Números', estadoGuante: null, nota: 'Número 3.' },
  { palabra: 'CUATRO', categoria: 'Números', estadoGuante: null, nota: 'Número 4.' },
  { palabra: 'CINCO',  categoria: 'Números', estadoGuante: null, nota: 'Número 5.' },
  { palabra: 'SEIS',   categoria: 'Números', estadoGuante: null, nota: 'Número 6.' },
  { palabra: 'SIETE',  categoria: 'Números', estadoGuante: null, nota: 'Número 7.' },
  { palabra: 'OCHO',   categoria: 'Números', estadoGuante: null, nota: 'Número 8.' },
  { palabra: 'NUEVE',  categoria: 'Números', estadoGuante: null, nota: 'Número 9.' },
  { palabra: 'DIEZ',   categoria: 'Números', estadoGuante: null, nota: 'Número 10.' },

  { palabra: 'AGUA',    categoria: 'Necesidades básicas', estadoGuante: null, nota: 'Para pedir agua.' },
  { palabra: 'COMIDA',  categoria: 'Necesidades básicas', estadoGuante: null, nota: 'Para pedir o mencionar comida.' },
  { palabra: 'BAÑO',    categoria: 'Necesidades básicas', estadoGuante: null, nota: 'Para pedir ir al baño.' },
  { palabra: 'DORMIR',  categoria: 'Necesidades básicas', estadoGuante: null, nota: 'Para indicar sueño o cansancio.' },
  { palabra: 'CASA',    categoria: 'Necesidades básicas', estadoGuante: null, nota: 'Hogar, vivienda.' },

  { palabra: 'BIEN',      categoria: 'Sentimientos y estado', estadoGuante: null, nota: 'Para decir que uno está bien.' },
  { palabra: 'MAL',       categoria: 'Sentimientos y estado', estadoGuante: null, nota: 'Para decir que uno está mal.' },
  { palabra: 'CONTENTO',  categoria: 'Sentimientos y estado', estadoGuante: null, nota: 'Alegría, buen ánimo.' },
  { palabra: 'TRISTE',    categoria: 'Sentimientos y estado', estadoGuante: null, nota: 'Tristeza.' },
  { palabra: 'CANSADO',   categoria: 'Sentimientos y estado', estadoGuante: null, nota: 'Cansancio.' },
];
let dictActiveCategory = 'Todas';

function signSearchUrl(palabra) {
  const q = `"${palabra}" seña lengua de señas argentina video`;
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}
function dictBadge(entry) {
  if (entry.estadoGuante === 'listo') return '<span class="dict-badge dict-badge-ready">guante ✓</span>';
  if (entry.estadoGuante === 'pendiente') return '<span class="dict-badge dict-badge-pending">guante: próximamente</span>';
  return '';
}
function renderDictCats() {
  const cats = ['Todas', ...new Set(SIGN_DICTIONARY.map(s => s.categoria))];
  const el = document.getElementById('dictCats');
  if (!el) return;
  el.innerHTML = cats.map(c =>
    `<button class="cat-chip${c === dictActiveCategory ? ' active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join('');
  el.querySelectorAll('.cat-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      dictActiveCategory = btn.dataset.cat;
      renderDictCats();
      renderDictList();
    });
  });
}
function renderDictList() {
  const searchEl = document.getElementById('dictSearch');
  const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const list = SIGN_DICTIONARY.filter(s =>
    (dictActiveCategory === 'Todas' || s.categoria === dictActiveCategory) &&
    (term === '' || s.palabra.toLowerCase().includes(term) || s.nota.toLowerCase().includes(term))
  );
  const el = document.getElementById('dictList');
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = '<p class="dict-empty">No hay ninguna palabra que coincida todavía.</p>';
    return;
  }
  el.innerHTML = list.map(s => `
    <div class="dict-card">
      <div class="dict-card-top">
        <span class="dict-word">${escapeHtml(s.palabra)}</span>
        ${dictBadge(s)}
      </div>
      <p class="dict-note">${escapeHtml(s.nota)}</p>
      <a class="dict-link" href="${signSearchUrl(s.palabra)}" target="_blank" rel="noopener">🔎 Ver la seña real</a>
    </div>
  `).join('');
}

/* ---------- Navegación entre vistas ---------- */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
}

/* ---------- Conexión inicial ---------- */
async function handleConnectClick() {
  const statusEl = document.getElementById('onboardStatus');
  statusEl.textContent = 'Buscando guante DIALOGIA por Bluetooth…';
  try {
    const name = await connectBLE();
    connectionMode = 'ble';
    setConnectionState('connected', name);
    document.getElementById('bottomNav').style.display = 'flex';
    showView('traducir');
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = (e && e.message) ? e.message : 'No se pudo conectar. Probá el modo demo.';
  }
}
function handleDemoClick() {
  connectionMode = 'demo';
  setConnectionState('demo');
  startDemoLoop();
  document.getElementById('bottomNav').style.display = 'flex';
  showView('traducir');
}

/* ---------- Inicialización ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  const savedCal = await storeGet('dialogia_calibration');
  if (Array.isArray(savedCal) && savedCal.length === 5) calibrationProfile = savedCal;
  renderFingerRows();
  renderDataset();
  renderDictCats();
  renderDictList();
  document.getElementById('dictSearch').addEventListener('input', renderDictList);

  if (!navigator.bluetooth) {
    document.getElementById('bleHint').textContent = 'Tu navegador no soporta Bluetooth Web. Para conectar el guante real, abrí esta app en Chrome para Android.';
  }

  document.getElementById('btnConnectBLE').addEven
