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
Char. calibración: ${CHAR_CALIB}    (sin usar: el guante se calibra solo)
Char. comando:     ${CHAR_CMD}      (write)

Formato de CHAR_SENSOR (14-15 bytes, little-endian).
Cada dedo = doblez % del guante (el de la OLED) x40.95, o sea 0..4095:
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
  // Con el guante real el % ya viene calculado por el guante (igual a la OLED): no se recalibra acá.
  const cal = connectionMode === 'ble' ? { min: 0, max: 4095 } : (calibrationProfile[idx] || { min: 0, max: 4095 });
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
  // si no suena, el aviso dice por qué (not-allowed, language-unavailable, synthesis-failed…)
  utter.onerror = e => { if (e.error !== 'canceled' && e.error !== 'interrupted') toast('Voz: ' + e.error); };
  window.speechSynthesis.speak(utter);
}

/* ---------- Bluetooth real ---------- */
/* Traduce un error de Web Bluetooth a un mensaje que diga EN QUÉ PASO falló y qué hacer. */
function bleErrorMessage(e, paso) {
  const name = (e && e.name) || '';
  const msg = (e && e.message) || String(e);
  if (paso === 'elegir el dispositivo' && name === 'NotFoundError') {
    return 'No se eligió ningún dispositivo. Tocá "Conectar por Bluetooth" y elegí DIALOGIA.';
  }
  if (name === 'NotSupportedError' && /notificaciones/.test(paso)) {
    return 'El guante no permite notificaciones (' + paso + '). Falta el descriptor 0x2902 (BLE2902) en el firmware: ' +
           'cargá el firmware actualizado, reiniciá el guante y apagá/prendé el Bluetooth del celular. [' + msg + ']';
  }
  if (name === 'NotFoundError') {
    return 'No se pudo ' + paso + ': el guante no tiene ese servicio/característica. ' +
           'Revisá que cargaste el firmware correcto y apagá/prendé el Bluetooth del celular (Android guarda copia de lo viejo). [' + msg + ']';
  }
  return 'No se pudo ' + paso + ': ' + msg;
}
async function connectBLE() {
  if (!navigator.bluetooth) {
    throw new Error('Este navegador no soporta Bluetooth Web. Abrí esta app en Chrome para Android.');
  }
  let paso = 'elegir el dispositivo';
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE] }],
      optionalServices: [BLE_SERVICE]
    });
    bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
    paso = 'conectar con el guante';
    bleServer = await bleDevice.gatt.connect();
    paso = 'encontrar el servicio DIALOGIA';
    const service = await bleServer.getPrimaryService(BLE_SERVICE);
    paso = 'encontrar la característica de sensores';
    charSensor = await service.getCharacteristic(CHAR_SENSOR);
    paso = 'encontrar la característica de señas';
    charSign = await service.getCharacteristic(CHAR_SIGN);
    try { charCalib = await service.getCharacteristic(CHAR_CALIB); } catch (e) { charCalib = null; }
    try { charCmd = await service.getCharacteristic(CHAR_CMD); } catch (e) { charCmd = null; }

    connectionMode = 'ble';   // antes de las notificaciones, para que los primeros datos ya usen el modo real
    paso = 'activar las notificaciones de sensores';
    await charSensor.startNotifications();
    charSensor.addEventListener('characteristicvaluechanged', onSensorNotify);
    paso = 'activar las notificaciones de señas';
    await charSign.startNotifications();
    charSign.addEventListener('characteristicvaluechanged', onSignNotify);
  } catch (e) {
    connectionMode = null;
    // Si falló a mitad de camino, soltamos la conexión: si queda abierta, el guante deja de
    // anunciarse y no vuelve a aparecer en la lista al reintentar.
    try {
      if (bleDevice) {
        bleDevice.removeEventListener('gattserverdisconnected', onBleDisconnected);
        if (bleDevice.gatt && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
      }
    } catch (_) { /* nada que limpiar */ }
    console.error('[BLE] falló al ' + paso, e);
    throw new Error(bleErrorMessage(e, paso));
  }

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
        <span class="finger-val">${pct}%</span>
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
  const dataset = (await storeGet('dialogia_dataset_v2')) || {};
  dataset[label] = (dataset[label] || []).concat(pendingSamples);
  await storeSet('dialogia_dataset_v2', dataset);
  pendingSamples = [];
  document.getElementById('pendingCount').textContent = '0';
  input.value = '';
  renderDataset();
  toast(`Seña "${label}" guardada`);
}
async function renderDataset() {
  const dataset = (await storeGet('dialogia_dataset_v2')) || {};
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
  const dataset = (await storeGet('dialogia_dataset_v2')) || {};
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

  document.getElementById('btnConnectBLE').addEventListener('click', handleConnectClick);
  document.getElementById('btnDemoMode').addEventListener('click', handleDemoClick);
  document.getElementById('btnRepeat').addEventListener('click', () => speak(document.getElementById('oledWord').textContent));
  document.getElementById('autoSpeakToggle').addEventListener('change', (e) => { autoSpeak = e.target.checked; });
  document.getElementById('btnSaveCalib').addEventListener('click', saveCalibration);
  document.getElementById('btnResetCalib').addEventListener('click', resetCalibration);
  document.getElementById('btnCapture').addEventListener('click', captureSample);
  document.getElementById('btnSaveSign').addEventListener('click', saveSign);
  document.getElementById('btnExport').addEventListener('click', exportDataset);
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* opcional, no bloquea la app */ }
  }
});

/* =====================================================================
   v2 — reconocimiento con el dataset entrenado, pulgar sin sensor y
   diccionario con imagen + procedimiento
   ===================================================================== */
const SIN_PULGAR = true;                 // el prototipo actual no tiene flex en el pulgar
if (SIN_PULGAR) FINGER_NAMES[0] = 'Pulgar ✕';
let datasetCache = {}, knnWin = [], knnShown = null;
const TOLERANCIA = 0.7;   // margen de error al reconocer: 0.4 estricto · 0.7 normal · 1.0 muy permisivo

/* ---------- Reconocimiento k-NN (usa lo que guardaste en "Entrenar") ---------- */
function knnVec(flex, x, y) {
  const v = [];
  flex.forEach((r, i) => { if (!(SIN_PULGAR && i === 0)) v.push(rawToPercent(r, i) / 100); });
  v.push(x / 4, y / 4);   // la inclinación pesa poco: no debe tapar la forma de los dedos
  return v;
}
// Seña más parecida a lo que se hace ahora, siempre que esté dentro del margen (TOLERANCIA).
function knnClassify(flex, x, y) {
  const q = knnVec(flex, x, y);
  let best = null, bd = TOLERANCIA;
  for (const w in datasetCache) datasetCache[w].forEach(s => {
    const v = knnVec(s.flex, s.imuX, s.imuY), d = Math.hypot(...v.map((a, i) => a - q[i]));
    if (d < bd) { bd = d; best = w; }
  });
  return best;
}
function autoRecognize(flex, x, y) {
  knnWin.push(knnClassify(flex, x, y) || '');   // '' = ninguna seña
  if (knnWin.length > 8) knnWin.shift();
  const w = knnWin.find(a => knnWin.filter(b => b === a).length >= 5);   // 5 de las últimas 8 lecturas coinciden
  if (w === undefined) return;
  if (w && w !== knnShown) handleRecognizedSign(w);
  knnShown = w || null;
}
const _updateSensorUI = updateSensorUI;
updateSensorUI = function (raw, x, y, b) {
  _updateSensorUI(raw, x, y, b);
  if (connectionMode === 'ble') autoRecognize(raw, x, y);
};
const _renderDataset = renderDataset;
renderDataset = async function () {
  datasetCache = (await storeGet('dialogia_dataset_v2')) || {};
  await _renderDataset();
  renderDictList();
};

/* ---------- Diccionario v2 ----------
   Para completar una seña con contenido VALIDADO por la comunidad sorda,
   agregá a su entrada:  img: 'img/hola.jpg',
                         pasos: ['Paso 1…', 'Paso 2…'],
                         fuente: 'Quién la validó / enlace'
   Mientras no estén, la tarjeta dice "pendiente de validar". */
const DICT_URL = 'https://www.diccionariodigitallsa.com/';
function trainedCount(p) {
  const k = Object.keys(datasetCache).find(w => w.toLowerCase() === p.toLowerCase());
  return k ? datasetCache[k].length : 0;
}
function dictBadge(e) {
  const n = trainedCount(e.palabra);
  return n ? `<span class="dict-badge dict-badge-ready">entrenada · ${n}</span>`
           : '<span class="dict-badge dict-badge-pending">sin entrenar</span>';
}
function copyWord(w) {
  if (navigator.clipboard) navigator.clipboard.writeText(w).then(() => toast('Copiado: ' + w), () => toast('No se pudo copiar'));
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]');
  if (b) copyWord(b.dataset.copy);
});

/* =====================================================================
   v3 — Historial con fecha y hora, diccionario sin banner naranja y
   asistente IUY (funciona sin internet, con reglas; no es un LLM)
   ===================================================================== */

/* ---------- Historial ---------- */
let historyList = [];                       // [{w, t, ok}] el más nuevo primero
function saveHistory() { return storeSet('dialogia_history', historyList.slice(0, 500)); }
async function loadHistory() { historyList = (await storeGet('dialogia_history')) || []; renderHistoryView(); }
const _handleRecognizedSign = handleRecognizedSign;
handleRecognizedSign = function (word) {
  _handleRecognizedSign(word);
  if (connectionMode !== 'ble') return;     // el modo demo no ensucia el historial
  const last = historyList[0];
  if (last && last.w === word && Date.now() - last.t < 1200) return;
  historyList.unshift({ w: word, t: Date.now(), ok: null });
  saveHistory(); renderHistoryView();
};
function dayLabel(ts) {
  const ini = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const d = new Date(ts), diff = Math.round((ini(new Date()) - ini(d)) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function renderHistoryView() {
  const el = document.getElementById('histList');
  if (!el) return;
  const rev = historyList.filter(h => h.ok !== null), bien = rev.filter(h => h.ok).length;
  document.getElementById('histStats').textContent = historyList.length
    ? `${historyList.length} señas · ` + (rev.length ? `acierto ${Math.round(bien / rev.length * 100)}% (${bien} de ${rev.length} revisadas)` : 'marcá ✓ o ✗ para medir tus aciertos')
    : '';
  if (!historyList.length) { el.innerHTML = '<p class="muted-note">Todavía no hay señas. Conectá el guante y empezá a señar.</p>'; return; }
  let html = '', cur = '';
  historyList.forEach((h, i) => {
    const day = dayLabel(h.t);
    if (day !== cur) { cur = day; html += `<h3 class="hist-day">${escapeHtml(day)}</h3>`; }
    const hora = new Date(h.t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    html += `<div class="hist-row"><div><span class="hist-word">${escapeHtml(h.w)}</span><span class="hist-time">${hora}</span></div>
      <div class="hist-actions"><button data-hspeak="${i}" aria-label="Repetir">🔊</button>
      <button data-hok="${i}" data-v="1" class="${h.ok === true ? 'on-ok' : ''}" aria-label="Estuvo bien">✓</button>
      <button data-hok="${i}" data-v="0" class="${h.ok === false ? 'on-bad' : ''}" aria-label="Estuvo mal">✗</button></div></div>`;
  });
  el.innerHTML = html;
}
document.addEventListener('click', e => {
  const sp = e.target.closest('[data-hspeak]');
  if (sp) { speak(historyList[+sp.dataset.hspeak].w); return; }
  const ok = e.target.closest('[data-hok]');
  if (ok) {
    const h = historyList[+ok.dataset.hok], v = ok.dataset.v === '1';
    h.ok = (h.ok === v) ? null : v;
    saveHistory(); renderHistoryView();
  }
});
document.getElementById('btnHistClear').addEventListener('click', () => {
  if (historyList.length && confirm('¿Borrar todo el historial?')) { historyList = []; saveHistory(); renderHistoryView(); }
});
document.getElementById('btnHistExport').addEventListener('click', () => {
  if (!historyList.length) { toast('No hay historial para exportar'); return; }
  const rows = historyList.map(h => {
    const d = new Date(h.t);
    return [d.toLocaleDateString('es-AR'), d.toLocaleTimeString('es-AR'), '"' + h.w.replace(/"/g, '""') + '"', h.ok === null ? '' : (h.ok ? 'sí' : 'no')].join(',');
  });
  const blob = new Blob(['\ufefffecha,hora,palabra,correcta\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'dialogia_historial.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
});
loadHistory();

/* ---------- Diccionario: sin banner naranja ---------- */
function postureHtml(word) {
  const k = Object.keys(datasetCache).find(w => w.toLowerCase() === word.toLowerCase());
  if (!k) return '';
  const S = datasetCache[k], names = ['Pu', 'Ín', 'Me', 'An', 'Mñ'];
  const bars = names.map((n, i) => {
    if (SIN_PULGAR && i === 0) return `<div class="pb"><div class="pb-track pb-off"></div><span>${n}</span></div>`;
    const avg = Math.round(S.reduce((a, s) => a + rawToPercent(s.flex[i], i), 0) / S.length);
    return `<div class="pb"><div class="pb-track"><div class="pb-fill" style="height:${avg}%"></div></div><span>${n}</span></div>`;
  }).join('');
  return `<div class="postura"><div class="pb-row">${bars}</div><p class="dict-sources">Postura de dedos capturada con tu guante (${S.length} muestras).</p></div>`;
}
function renderDictList() {
  const searchEl = document.getElementById('dictSearch');
  const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const list = SIGN_DICTIONARY.filter(s =>
    (dictActiveCategory === 'Todas' || s.categoria === dictActiveCategory) &&
    (term === '' || s.palabra.toLowerCase().includes(term) || s.nota.toLowerCase().includes(term)));
  const el = document.getElementById('dictList');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p class="dict-empty">No hay ninguna palabra que coincida todavía.</p>'; return; }
  el.innerHTML = list.map(s => {
    const img = s.img ? `<img class="dict-img" src="${escapeHtml(s.img)}" alt="Seña de ${escapeHtml(s.palabra)} en LSA" loading="lazy">` : '';
    const pasos = (s.pasos && s.pasos.length)
      ? `<ol class="dict-steps">${s.pasos.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ol>`
      : `<div class="dict-howto"><b>Para que el guante la reconozca</b><ol class="dict-steps">
          <li>Mirá cómo se hace con una persona sorda, un intérprete o el diccionario oficial.</li>
          <li>En <b>Entrenar</b> escribí «${escapeHtml(s.palabra)}» y capturá varias muestras.</li>
          <li>Tocá <b>Guardar seña</b>: la vas a ver en Traducir y en el Historial.</li></ol></div>`;
    const fuente = s.fuente ? `<p class="dict-sources">Fuente: ${escapeHtml(s.fuente)}</p>` : '';
    return `<div class="dict-card">
      <div class="dict-card-top"><span class="dict-word">${escapeHtml(s.palabra)}</span>${dictBadge(s)}</div>
      <p class="dict-note">${escapeHtml(s.nota)}</p>${img}${postureHtml(s.palabra)}${pasos}${fuente}
      <div class="dict-actions"><button class="dict-link" data-copy="${escapeHtml(s.palabra)}">Copiar palabra</button></div></div>`;
  }).join('');
}
renderDictList();

/* ---------- IUY, la mascota asistente ---------- */
const IUY_SVG = (() => {
  const wing = '<path d="M40 54 L6 38 Q14 50 9 58 Q19 60 14 72 Q28 66 42 74 Z" fill="#9a9a9a" stroke="#111" stroke-width="2.5" stroke-linejoin="round"/><path d="M38 56 L16 48 M38 62 L18 62 M40 68 L24 70" stroke="#6f6f6f" stroke-width="1.4" fill="none"/>';
  const ear = '<path d="M44 40 L38 12 Q50 18 57 34 Z" fill="#7d7d7d" stroke="#111" stroke-width="2.5" stroke-linejoin="round"/><path d="M46 36 L42 20 Q50 25 53 34 Z" fill="#f08a8a"/>';
  return `<svg viewBox="0 0 120 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="IUY, el murciélago asistente">
  <g class="iuy-wl">${wing}</g><g class="iuy-wr" transform="translate(120 0) scale(-1 1)">${wing}</g>
  ${ear}<g transform="translate(120 0) scale(-1 1)">${ear}</g>
  <circle cx="60" cy="60" r="27" fill="#6b6b6b" stroke="#111" stroke-width="3"/>
  <circle cx="50" cy="56" r="3.4" fill="#111"/><circle cx="70" cy="56" r="3.4" fill="#111"/>
  <path d="M54 65 Q60 70 66 65" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round"/>
  <path d="M55.5 66.5 L57.5 71 L59 67.5 Z M61 67.5 L62.5 71 L64.5 66.5 Z" fill="#fff" stroke="#111" stroke-width=".8"/>
  <path d="M42 72 Q47 80 55 78 M78 72 Q73 80 65 78" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round"/></svg>`;
})();
const logoSpan = document.querySelector('.app-logo span');
if (logoSpan) logoSpan.innerHTML = IUY_SVG;

function iuyReply(q) {
  const t = q.toLowerCase(), has = (...k) => k.some(x => t.includes(x));
  if (has('hola', 'buenas', 'quién sos', 'quien sos', 'iuy')) return '¡Hola! Soy IUY, el asistente de DIALOGIA. Funciono sin internet: te explico la app, reviso tu historial y leo tus últimas palabras en voz alta.';
  if (has('conect', 'bluetooth', 'empar', 'no aparece')) return 'Para conectar: 1) encendé el guante, 2) abrí esta app en Chrome para Android (con HTTPS), 3) tocá "Conectar por Bluetooth" y elegí DIALOGIA. Si no aparece, reiniciá el ESP32 y probá de nuevo.';
  if (has('calibr')) return 'En Calibrar, para cada dedo: estiralo del todo y tocá "mín", después doblalo del todo y tocá "máx". Al final tocá "Guardar calibración".';
  if (has('entren', 'muestra', 'nueva seña', 'enseñ')) return 'En Entrenar escribí la palabra, hacé la seña y tocá "Capturar postura" varias veces, cambiando un poco la mano. Después "Guardar seña". Con 5 o más muestras reconoce mejor.';
  if (has('pulgar')) return 'El prototipo actual no tiene sensor en el pulgar, así que la app lo ignora al reconocer. Cuando lo agreguen, poné SIN_PULGAR = false en app.js.';
  if (has('histor', 'hoy', 'dije', 'acert', 'precis', 'cómo me fue', 'como me fue')) {
    if (!historyList.length) return 'Todavía no hay señas en el historial. Conectá el guante y empezá a señar.';
    const hoy = historyList.filter(h => dayLabel(h.t) === 'Hoy').length;
    const rev = historyList.filter(h => h.ok !== null), bien = rev.filter(h => h.ok).length;
    return `Hoy dijiste ${hoy} seña${hoy === 1 ? '' : 's'}. La última fue "${historyList[0].w}".` +
      (rev.length ? ` De las ${rev.length} que revisaste, ${bien} estaban bien (${Math.round(bien / rev.length * 100)}%).` : ' Marcá ✓ o ✗ en el Historial para medir tus aciertos.');
  }
  if (has('leer', 'leé', 'repet', 'voz', 'decir')) {
    if (!historyList.length) return 'Todavía no hay nada para leer.';
    const frase = historyList.slice(0, 5).reverse().map(h => h.w).join(' ');
    speak(frase);
    return 'Leyendo tus últimas palabras: ' + frase;
  }
  if (has('diccion', 'imagen', 'video', 'link', 'enlace')) return 'El diccionario oficial de la UNCuyo se navega por configuración manual (la forma de la mano), no escribiendo la palabra. Por eso las tarjetas no enlazan a cada seña: para ver el movimiento real conviene que te la muestre una persona sorda o un intérprete. Para tener una animación, grabá el movimiento con el guante en Entrenar.';
  if (has('gracias')) return '¡De nada!';
  return 'Todavía no sé responder eso. Preguntame por: conectar el guante, calibrar, entrenar una seña, tu historial o leer tus últimas palabras.';
}
(function buildIuy() {
  const fab = document.createElement('button');
  fab.id = 'iuyFab'; fab.setAttribute('aria-label', 'Abrir a IUY, el asistente'); fab.innerHTML = IUY_SVG;
  const panel = document.createElement('div');
  panel.id = 'iuyPanel'; panel.hidden = true;
  panel.innerHTML = `<div class="iuy-head"><span class="iuy-av">${IUY_SVG}</span><div><b>IUY</b><small>asistente de DIALOGIA</small></div><button id="iuyClose" aria-label="Cerrar">✕</button></div>
    <div id="iuyLog" aria-live="polite"></div><div id="iuyChips"></div>
    <div class="iuy-input"><input id="iuyInput" type="text" placeholder="Preguntale a IUY…" /><button id="iuySend" class="btn btn-teal btn-sm">Enviar</button></div>`;
  document.body.append(fab, panel);
  const log = panel.querySelector('#iuyLog'), input = panel.querySelector('#iuyInput');
  const say = (txt, who) => { const m = document.createElement('div'); m.className = 'iuy-msg ' + who; m.textContent = txt; log.appendChild(m); log.scrollTop = log.scrollHeight; };
  const ask = q => { if (!q.trim()) return; say(q, 'me'); say(iuyReply(q), 'bot'); input.value = ''; };
  ['¿Cómo conecto el guante?', 'Calibrar', 'Entrenar una seña', '¿Cómo me fue hoy?', 'Leer mis últimas palabras'].forEach(c => {
    const b = document.createElement('button'); b.textContent = c; b.addEventListener('click', () => ask(c)); panel.querySelector('#iuyChips').appendChild(b);
  });
  fab.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !log.children.length) say('¡Hola! Soy IUY. Funciono sin internet: te explico la app, reviso tu historial y leo tus últimas palabras. ¿En qué te ayudo?', 'bot');
  });
  panel.querySelector('#iuyClose').addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('#iuySend').addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ask(input.value); });
})();

/* =====================================================================
   v4 — Mano animada en el diccionario (sin enlaces externos)
   La animación sale de lo que GRABA el guante: se la pide a una persona
   sorda o a un intérprete que haga la seña con el guante puesto.
   ===================================================================== */
let animsCache = {};                         // { PALABRA: [{f:[5 %], x, y}, ...] }
let handTimer = null;
storeGet('dialogia_anims').then(a => { animsCache = a || {}; renderDictList(); });

function handSvg() {
  const fing = [
    { i: 1, bx: 40, L: 46 }, { i: 2, bx: 54, L: 52 }, { i: 3, bx: 68, L: 46 }, { i: 4, bx: 82, L: 36 }
  ].map(d => `<g class="fg" data-i="${d.i}" style="transform-origin:${d.bx}px 70px"><rect x="${d.bx - 6}" y="${70 - d.L}" width="12" height="${d.L}" rx="6" fill="#2EE6D6" fill-opacity=".9" stroke="#0b1524" stroke-width="2"/></g>`).join('');
  const thumb = '<g class="fg" data-i="0" style="transform-origin:34px 104px;transform:rotate(-48deg);opacity:.35"><rect x="28" y="70" width="12" height="34" rx="6" fill="#2EE6D6" fill-opacity=".9" stroke="#0b1524" stroke-width="2"/></g>';
  return `<svg class="hand-svg" viewBox="0 0 120 125" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Esquema de la mano">
    <g class="hand" style="transform-origin:60px 95px">${thumb}${fing}<rect x="28" y="64" width="64" height="54" rx="20" fill="#8B7CFF" fill-opacity=".85" stroke="#0b1524" stroke-width="2"/></g></svg>`;
}
function setHand(svg, fr) {
  svg.querySelectorAll('.fg').forEach(g => {
    const i = +g.dataset.i, c = (fr.f[i] || 0) / 100;
    if (i === 0) { if (!SIN_PULGAR) { g.style.opacity = 1; g.style.transform = `rotate(${-48 + c * 35}deg)`; } return; }
    g.style.transform = `rotate(${(2.5 - i) * c * 6}deg) scaleY(${1 - 0.55 * c})`;
  });
  svg.querySelector('.hand').style.transform = `rotate(${Math.max(-60, Math.min(60, (fr.x || 0) * 35))}deg)`;
}
function framesFor(word) {
  const key = k => k.toLowerCase() === word.toLowerCase();
  const a = Object.keys(animsCache).find(key);
  if (a && animsCache[a].length) return animsCache[a];
  const d = Object.keys(datasetCache).find(key);
  if (!d) return null;
  const S = datasetCache[d];
  return [{ f: [0, 1, 2, 3, 4].map(i => Math.round(S.reduce((s, m) => s + rawToPercent(m.flex[i], i), 0) / S.length)),
            x: S.reduce((s, m) => s + m.imuX, 0) / S.length, y: 0 }];
}
function decorateHands() {
  clearInterval(handTimer);
  document.querySelectorAll('#dictList .dict-card').forEach(card => {
    const word = card.querySelector('.dict-word').textContent, frames = framesFor(word);
    if (!frames) return;
    const old = card.querySelector('.postura'); if (old) old.remove();
    const how = card.querySelector('.dict-howto'); if (how) how.remove();
    const box = document.createElement('div');
    box.className = 'hand-box';
    box.innerHTML = handSvg() + `<p class="dict-sources">${frames.length > 1 ? 'Movimiento grabado con el guante.' : 'Postura grabada con el guante.'} Es un esquema de la mano, no la ilustración oficial de la seña.</p>` +
      (frames.length > 1 ? '<button class="dict-link" data-replay>▶ Repetir</button>' : '');
    card.querySelector('.dict-note').after(box);
    const svg = box.querySelector('svg'); svg._frames = frames; svg._i = 0; setHand(svg, frames[0]);
  });
  const multi = [...document.querySelectorAll('.hand-box svg')].filter(s => s._frames.length > 1);
  if (multi.length) handTimer = setInterval(() => multi.forEach(s => {
    const n = s._frames.length; s._i = (s._i + 1) % (n + 6);
    setHand(s, s._frames[Math.min(s._i, n - 1)]);
  }), 100);
}
const _renderDictList = renderDictList;
renderDictList = function () { _renderDictList(); decorateHands(); };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-replay]');
  if (b) { const s = b.closest('.hand-box').querySelector('svg'); s._i = 0; }
});

/* ---------- Grabar movimiento con el guante (2 s) ---------- */
async function recordMotion() {
  const label = document.getElementById('trainLabel').value.trim();
  if (!label) { toast('Escribí una palabra primero'); return; }
  if (!connectionMode) { toast('Conectá el guante o usá el modo demo'); return; }
  const btn = document.getElementById('btnRecord'), frames = [];
  btn.disabled = true;
  await new Promise(res => {
    const timer = setInterval(() => {
      frames.push({ f: lastRawFlex.map((r, i) => rawToPercent(r, i)), x: lastImuX, y: lastImuY });
      btn.textContent = `⏺ Grabando… ${(2 - frames.length * 0.1).toFixed(1)} s`;
      if (frames.length >= 20) { clearInterval(timer); res(); }
    }, 100);
  });
  animsCache[label.toUpperCase()] = frames;
  await storeSet('dialogia_anims', animsCache);
  btn.disabled = false; btn.textContent = '⏺ Grabar movimiento (2 s)';
  toast(`Movimiento de "${label}" guardado`);
  renderDictList();
}
document.getElementById('btnRecord').addEventListener('click', recordMotion);
renderDictList();
