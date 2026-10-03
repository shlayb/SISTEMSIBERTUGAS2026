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
    configId: 'default', updatedAt: 0
  });
  let storageError = '';

  // Manual Telegram tests share only credential validation with saved settings.
  // Sending never calls load/save, cloud sync, MQTT, or the automatic notifier.
  function validateTelegramCredentials(tokenValue, chatIdValue) {
    const token = String(tokenValue ?? '').trim();
    const chatId = String(chatIdValue ?? '').trim();
    if (!token) throw new Error('Isi Bot Token Telegram.');
    if (!/^[1-9]\d*:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Format Bot Token salah. Salin token lengkap dari BotFather (angka:token).');
    if (!chatId) throw new Error('Isi Chat ID Telegram.');
    const numericChatId = /^-?[1-9]\d*$/.test(chatId) && Number.isSafeInteger(Number(chatId));
    if (!numericChatId && !/^@[A-Za-z0-9_]+$/.test(chatId)) throw new Error('Format Chat ID salah. Gunakan ID numerik bukan nol (dapat negatif), atau @username grup/channel publik.');
    return { token, chatId };
  }

  function buildTelegramTestMessage(sentAt = new Date()) {
    const time = sentAt.toLocaleString('id-ID', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    });
    return `[UJI] ThermoGuard-CPS\nPesan ini merupakan pengujian manual notifikasi Telegram, bukan peringatan sensor.\nWaktu pengiriman: ${time}`;
  }

  function telegramTestApiError(response, result) {
    const code = Number.isInteger(result?.error_code) ? result.error_code : response.status;
    if (code === 401 || code === 404) return 'Bot Token salah atau sudah dicabut. Periksa token dari BotFather.';
    if (code === 429) {
      const delay = result?.parameters?.retry_after;
      const wait = Number.isSafeInteger(delay) && delay > 0 ? `Tunggu ${delay} detik` : 'Tunggu beberapa saat';
      return `Terlalu banyak permintaan. ${wait} sebelum mencoba lagi secara manual. Tidak ada pengiriman ulang otomatis.`;
    }
    const description = typeof result?.description === 'string' ? result.description : '';
    if (code === 403 || /forbidden|not enough rights|have no rights|chat_write_forbidden|bot is not a member/i.test(description)) {
      return 'Akses ditolak. Pastikan bot tidak diblokir, sudah bergabung ke grup/channel, dan memiliki izin mengirim pesan.';
    }
    if (code === 400) return 'Chat ID salah atau chat tidak dapat dijangkau. Periksa ID terbaru atau @username, lalu buka chat bot dan kirim /start.';
    if (code >= 500) return 'Layanan Telegram sedang mengalami gangguan. Coba lagi nanti secara manual.';
    return 'Telegram menolak pesan uji. Periksa Bot Token, Chat ID, dan izin bot.';
  }

  class TelegramTestError extends Error {}

  async function sendTelegramTest({ token, chatId }) {
    const controller = new AbortController();
    // The deadline covers both the request and reading the response body.
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        body: new URLSearchParams({ chat_id: chatId, text: buildTelegramTestMessage() }),
        signal: controller.signal
      });
      let result;
      try { result = await response.json(); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (controller.signal.aborted) throw new TelegramTestError('Timeout');
      if (!response.ok || result?.ok === false) throw new TelegramTestError(telegramTestApiError(response, result));
      const messageId = result?.result?.message_id;
      if (result?.ok !== true || !Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new TelegramTestError('Pengiriman belum terkonfirmasi: respons Telegram tidak valid. Periksa chat sebelum mencoba lagi; pesan mungkin sudah diterima.');
      }
      return messageId;
    } catch (error) {
      if (controller.signal.aborted) throw new TelegramTestError('Timeout: Telegram tidak memberi konfirmasi dalam 10 detik. Periksa chat sebelum mencoba lagi; pesan mungkin sudah diterima.');
      if (error instanceof TelegramTestError) throw error;
      // Never display raw fetch errors or API descriptions that could expose a token.
      throw new TelegramTestError('Gangguan jaringan: konfirmasi Telegram tidak dapat dibaca. Periksa internet atau pembatasan browser/jaringan (CORS), lalu periksa chat sebelum mencoba lagi.');
    } finally { clearTimeout(timeout); }
  }

  function setupTelegramTest(formNode) {
    const button = document.getElementById('testTelegram');
    const status = document.getElementById('telegramTestStatus');
    let sending = false;
    function showStatus(text, state) { status.textContent = text; status.dataset.state = state; }
    button.addEventListener('click', async () => {
      if (sending) return;
      let credentials;
      try {
        credentials = validateTelegramCredentials(formNode.elements.telegramToken.value, formNode.elements.telegramChatId.value);
      } catch (error) { showStatus(error.message, 'error'); return; }
      sending = true;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Mengirim…';
      showStatus('Mengirim pesan uji ke Telegram…', 'sending');
      try {
        await sendTelegramTest(credentials);
        showStatus('Berhasil: Telegram mengonfirmasi pesan uji terkirim.', 'success');
      } catch (error) { showStatus(error.message, 'error'); }
      finally {
        sending = false;
        button.disabled = false;
        button.setAttribute('aria-busy', 'false');
        button.textContent = 'Kirim pesan uji';
      }
    });
  }

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
    if (s.telegramEnabled) validateTelegramCredentials(s.telegramToken, s.telegramChatId);
    if (s.brokerHost && location.protocol === 'https:' && s.brokerProtocol !== 'wss') throw new Error('Halaman HTTPS memerlukan broker WSS.');
    s.configId = String(s.configId).slice(0, 100);
    s.updatedAt = Number(s.updatedAt) || 0;
    return s;
  }

  let cloudSyncing = false;
  async function syncFromCloud(currentLocal) {
    if (cloudSyncing) return;
    cloudSyncing = true;
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const cloudData = await res.json();
        const cloudS = validate(cloudData);
        if (cloudS.updatedAt > currentLocal.updatedAt) {
          localStorage.setItem(KEY, JSON.stringify(cloudS));
          window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
          const formNode = document.getElementById('settingsForm');
          if (formNode && typeof populate === 'function') populate(cloudS);
        } else if (currentLocal.updatedAt > cloudS.updatedAt) {
          syncToCloud(currentLocal);
        }
      } else if (res.status === 404 && currentLocal.updatedAt > 0) {
        syncToCloud(currentLocal);
      }
    } catch (e) {
      console.warn('Cloud sync failed:', e);
    } finally {
      cloudSyncing = false;
    }
  }

  async function syncToCloud(s) {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s)
      });
    } catch (e) {
      console.warn('Cloud save failed:', e);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const s = raw ? validate(JSON.parse(raw)) : { ...defaults };
      storageError = '';
      syncFromCloud(s);
      return s;
    } catch (_) {
      storageError = 'Pengaturan tidak dapat dibaca. Nilai awal digunakan; periksa izin penyimpanan browser.';
      return { ...defaults };
    }
  }
  function save(raw) {
    const s = validate(raw);
    s.configId = `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    s.updatedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (_) { throw new Error('Gagal menyimpan. Izinkan penyimpanan browser, lalu coba lagi.'); }
    storageError = '';
    syncToCloud(s);
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
  setupTelegramTest(form);
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
