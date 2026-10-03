/* Shared settings use classic scripts so file:// works without a server. */
(() => {
  'use strict';
  const TG = window.ThermoGuard = window.ThermoGuard || {};
  const KEY = 'thermoguard.settings.v1';
  const defaults = Object.freeze({
    brokerHost: '', brokerProtocol: 'wss', brokerPort: 8084, brokerPath: '/mqtt',
    topic: 'thermoguard/server-01', mqttUsername: '', mqttPassword: '',
    setpointMode: 'potentiometer', manualSetpoint: 30, smokeThreshold: 400,
    refreshInterval: 2000, telegramEnabled: false, telegramToken: '', telegramChatId: '',
    configId: 'default'
  });
  let storageError = '';
  function validate(raw) {
    const s = Object.fromEntries(Object.keys(defaults).map(k => [k, raw[k] ?? defaults[k]]));
    for (const k of ['brokerHost', 'brokerPath', 'topic', 'mqttUsername', 'telegramToken', 'telegramChatId']) s[k] = String(s[k]).trim();
    s.mqttPassword = String(s.mqttPassword);
    s.topic = s.topic.replace(/^\/+|\/+$/g, '');
    for (const [k, min, max] of [['brokerPort', 1, 65535], ['manualSetpoint', 15, 60], ['smokeThreshold', 1, 10000], ['refreshInterval', 500, 10000]]) {
      s[k] = Number(s[k]);
      if (!Number.isFinite(s[k]) || s[k] < min || s[k] > max) throw new Error('Nilai numerik berada di luar batas yang diizinkan.');
    }
    if (![s.brokerPort, s.smokeThreshold, s.refreshInterval].every(Number.isInteger)) throw new Error('Port, ambang asap, dan interval harus berupa bilangan bulat.');
    if (!['ws', 'wss'].includes(s.brokerProtocol)) throw new Error('Pilih protokol WS atau WSS.');
    if (s.brokerHost && !/^[a-zA-Z0-9.-]+$/.test(s.brokerHost)) throw new Error('Host hanya berisi nama domain atau IPv4, tanpa protokol dan port.');
    if (!/^\/[^\s#]*$/.test(s.brokerPath)) throw new Error('Path WebSocket harus diawali / dan tidak mengandung spasi.');
    if (!s.topic || /[+#\s\u0000-\u001f]/.test(s.topic) || s.topic.length > 200) throw new Error('Topik harus spesifik, tanpa spasi atau wildcard +/#.');
    if (!['manual', 'potentiometer'].includes(s.setpointMode)) throw new Error('Sumber setpoint tidak valid.');
    s.telegramEnabled = s.telegramEnabled === true;
    if (s.telegramEnabled && (!/^\d+:[\w-]{20,}$/.test(s.telegramToken) || !/^(-?\d+|@[\w]+)$/.test(s.telegramChatId))) throw new Error('Lengkapi Bot Token dan Chat ID Telegram yang valid.');
    if (s.brokerHost && location.protocol === 'https:' && s.brokerProtocol !== 'wss') throw new Error('Halaman HTTPS memerlukan broker WSS.');
    s.configId = String(s.configId).slice(0, 100);
    return s;
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const s = raw ? validate(JSON.parse(raw)) : { ...defaults };
      storageError = '';
      return s;
    } catch (_) {
      storageError = 'Pengaturan tidak dapat dibaca. Nilai awal digunakan; periksa izin penyimpanan browser.';
      return { ...defaults };
    }
  }
  function save(raw) {
    const s = validate(raw);
    s.configId = `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (_) { throw new Error('Gagal menyimpan. Izinkan penyimpanan browser, lalu coba lagi.'); }
    storageError = '';
    return s;
  }
  TG.Settings = { KEY, defaults, load, save, validate, get storageError() { return storageError; } };
  const form = document.getElementById('settingsForm');
  if (!form) return;
  const message = document.getElementById('settingsMessage');
  function show(text, error = false) { message.textContent = text; message.classList.toggle('is-error', error); }
  function updateMode() { form.elements.manualSetpoint.disabled = form.elements.setpointMode.value !== 'manual'; }
  function populate(s) {
    for (const [key, value] of Object.entries(s)) {
      const input = form.elements.namedItem(key);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
    }
    updateMode();
  }
  populate(load());
  if (storageError) show(storageError, true);
  form.elements.setpointMode.addEventListener('change', updateMode);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const raw = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const input = form.elements.namedItem(key);
      if (input) raw[key] = input.type === 'checkbox' ? input.checked : input.value;
    }
    try { populate(save(raw)); show('Tersimpan. Buka Monitoring untuk melihat penerapan pada ESP32.'); }
    catch (error) { show(error.message, true); }
  });
  document.getElementById('resetSettings').addEventListener('click', () => {
    try { populate(save({ ...defaults })); show('Pengaturan awal dipulihkan. Mode simulasi aktif saat monitoring dibuka.'); }
    catch (error) { show(error.message, true); }
  });
})();
