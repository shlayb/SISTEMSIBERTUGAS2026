(() => {
  'use strict';
  const TG = window.ThermoGuard;
  const $ = id => document.getElementById(id);
  const number = (value, digits = 0) => new Intl.NumberFormat('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const clock = ts => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let settings = TG.Settings.load();
  let mock = new TG.MockData(settings);
  const mqtt = new TG.MQTTClient(settings);
  const events = [], demoHistory = [], deviceHistory = [];
  let lastDevice = null, lastDemo = null, demoTimer = null, lastLiveMode = null;
  let source = 'demo', lastDisplayMode = '', lastConnection = false;
  let deviceBuffer = null, bufferSeenAt = 0, invalidConfigLogged = false;

  function log(message, kind = 'info') {
    events.unshift({ message, kind, ts: Date.now() });
    events.length = Math.min(events.length, 20);
    $('eventLog').replaceChildren(...events.map(event => {
      const li = document.createElement('li'); li.className = 'event-item'; li.dataset.kind = event.kind;
      const dot = document.createElement('i'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = event.message;
      const time = document.createElement('time'); time.dateTime = new Date(event.ts).toISOString(); time.textContent = clock(event.ts);
      li.append(dot, text, time); return li;
    }));
  }
  function record(list, data) {
    if (list.some(sample => sample.id === data.id)) return false;
    list.push(data); list.sort((a, b) => a.ts - b.ts);
    if (list.length > 120) list.splice(0, list.length - 120);
    return true;
  }

  // Canvas dimensions follow the container, including devicePixelRatio changes.
  class HistoryChart {
    constructor(canvas, valueKey, limitKey, color) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.valueKey = valueKey; this.limitKey = limitKey; this.color = color; this.samples = [];
      this.resize = () => this.draw();
      if (window.ResizeObserver) { this.observer = new ResizeObserver(this.resize); this.observer.observe(canvas.parentElement); }
      window.addEventListener('resize', this.resize);
    }
    setData(samples) { this.samples = samples; this.draw(); }
    draw() {
      const c = this.canvas, ctx = this.ctx;
      if (!ctx) return;
      const { width, height } = c.parentElement.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      c.width = Math.round(width * ratio); c.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const pad = { l: 2.9 * rem, r: .6 * rem, t: .65 * rem, b: 1.5 * rem };
      const w = Math.max(1, width - pad.l - pad.r), h = Math.max(1, height - pad.t - pad.b);
      ctx.font = `${.72 * rem}px Inter, system-ui, sans-serif`; ctx.fillStyle = '#6B7280';
      if (!this.samples.length) { ctx.fillText('Menunggu data…', pad.l, height / 2); return; }
      const values = this.samples.flatMap(d => [d[this.valueKey], d[this.limitKey]]);
      const min = this.valueKey === 'smoke' ? 0 : Math.floor(Math.min(...values) - 3);
      const max = Math.ceil(Math.max(...values) * (this.valueKey === 'smoke' ? 1.15 : 1) + (this.valueKey === 'smoke' ? 1 : 3));
      const start = this.samples[0].ts, end = this.samples[this.samples.length - 1].ts;
      const x = ts => pad.l + (ts - start) / Math.max(1, end - start) * w;
      const y = v => pad.t + (max - v) / Math.max(1, max - min) * h;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i < 4; i++) {
        const value = min + (max - min) * i / 3, yy = y(value);
        ctx.strokeStyle = '#f0f1f0'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(width - pad.r, yy); ctx.stroke();
        ctx.fillText(number(value), pad.l - .5 * rem, yy);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(pad.l - 2, pad.t - 2, w + 4, h + 4); ctx.clip();
      const path = key => {
        ctx.beginPath(); this.samples.forEach((d, i) => i ? ctx.lineTo(x(d.ts), y(d[key])) : ctx.moveTo(x(d.ts), y(d[key])));
      };
      path(this.valueKey);
      ctx.lineTo(x(end), pad.t + h); ctx.lineTo(x(start), pad.t + h); ctx.closePath();
      ctx.fillStyle = this.valueKey === 'smoke' ? 'rgba(255,138,31,.045)' : 'rgba(34,197,94,.045)'; ctx.fill();
      path(this.limitKey); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1; ctx.stroke();
      ctx.setLineDash([]); path(this.valueKey); ctx.strokeStyle = this.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
      const last = this.samples[this.samples.length - 1];
      ctx.beginPath(); ctx.arc(x(last.ts), y(last[this.valueKey]), 2.5, 0, Math.PI * 2); ctx.fillStyle = this.color; ctx.fill(); ctx.restore();
      ctx.fillStyle = '#6B7280'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left'; ctx.fillText(clock(start), pad.l, height);
      if (end !== start) { ctx.textAlign = 'right'; ctx.fillText(clock(end), width - pad.r, height); }
      c.setAttribute('aria-label', `${this.valueKey === 'smoke' ? 'Asap' : 'Suhu'}: ${number(last[this.valueKey], this.valueKey === 'smoke' ? 0 : 1)}; batas ${number(last[this.limitKey], 1)}. ${this.samples.length} sampel.`);
    }
  }
  const tempChart = new HistoryChart($('temperatureChart'), 'temperature', 'setpoint', '#22C55E');
  const smokeChart = new HistoryChart($('smokeChart'), 'smoke', 'smokeThreshold', '#FF8A1F');

  class TelegramNotifier {
    constructor(config) {
      this.config = config; this.pending = null; this.busy = false; this.lastAttempt = 0; this.active = true;
      this.status = config.telegramEnabled ? 'Siap' : 'Belum diaktifkan';
      this.sent = new Set();
    }
    enqueue(data) {
      if (data.telegramSent === true) { this.status = 'Terkirim oleh ESP32'; return; }
      if (!this.config.telegramEnabled) return;
      const key = typeof data.alertId === 'string' ? data.alertId : data.id;
      if (this.sent.has(key)) return;
      // Keep one pending emergency; newer incidents replace an unsent older one.
      if (this.pending && this.pending.key !== key) log('Antrean Telegram diganti dengan kejadian darurat terbaru.', 'warning');
      this.pending = { key, data, expires: Date.now() + 300000 };
      this.status = 'Menunggu pengiriman'; this.tick();
    }
    tick() {
      if (!this.active || !this.pending || this.busy || Date.now() - this.lastAttempt < 30000) return;
      if (Date.now() > this.pending.expires) { this.pending = null; this.status = 'Pengiriman kedaluwarsa'; log('Pesan Telegram belum terkirim setelah 5 menit.', 'warning'); return; }
      this.send();
    }
    async send() {
      this.busy = true;
      const job = this.pending, s = this.config;
      const storageKey = `thermoguard.alert.v1:${s.topic}`;
      const work = async () => {
        if (!this.active) return;
        let previous = null;
        try { previous = JSON.parse(localStorage.getItem(storageKey)); } catch (_) { /* RAM fallback. */ }
        if (previous?.key === job.key) { this.pending = null; this.status = 'Sudah terkirim'; return; }
        if (previous?.sentAt && Date.now() - previous.sentAt < 60000) { this.status = 'Antrean · jeda 60 detik'; return; }
        this.lastAttempt = Date.now(); this.status = 'Mengirim…';
        this.controller = new AbortController();
        const timeout = setTimeout(() => this.controller.abort(), 10000);
        try {
          const d = job.data;
          const text = `DARURAT ThermoGuard-CPS\nAsap/gas melampaui ambang.\nSuhu: ${d.temperature} °C\nAsap: ${d.smoke} ppm\nAmbang asap: ${d.smokeThreshold} ppm\nTerdeteksi: ${new Date(d.ts).toLocaleString('id-ID')}\nPeriksa ruang server dan telemetri aktuator.`;
          const response = await fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
            method: 'POST', body: new URLSearchParams({ chat_id: s.telegramChatId, text }), signal: this.controller.signal
          });
          const result = await response.json();
          if (!response.ok || result.ok !== true || !result.result?.message_id) throw new Error('Pengiriman ditolak.');
          if (!this.active) return;
          this.sent.add(job.key);
          try { localStorage.setItem(storageKey, JSON.stringify({ key: job.key, sentAt: Date.now() })); } catch (_) { /* Keep in-memory deduplication. */ }
          if (this.pending === job) this.pending = null;
          this.status = 'Pesan darurat terkirim'; log('Telegram mengonfirmasi pesan darurat terkirim.', 'success');
        } catch (_) {
          if (this.active) { this.status = 'Gagal · coba lagi 30 dtk'; log('Telegram gagal dikirim. Periksa internet, token, dan Chat ID.', 'warning'); }
        } finally { clearTimeout(timeout); }
      };
      try {
        if (navigator.locks?.request) await navigator.locks.request(storageKey, work);
        else await work();
      } catch (_) { this.status = 'Pengiriman belum berhasil'; }
      finally { this.busy = false; }
    }
    stop() { this.active = false; this.controller?.abort(); this.pending = null; }
  }
  let telegram = new TelegramNotifier(settings);
  function freshDevice() {
    return mqtt.online && lastDevice && Date.now() - lastDevice.ts <= Math.max(15000, settings.refreshInterval * 3);
  }
  function updateBuffer() {
    if (source === 'device') {
      $('bufferCount').textContent = deviceBuffer === null ? '—' : number(deviceBuffer);
      $('bufferDetail').textContent = deviceBuffer === null ? 'ESP32 belum melaporkan jumlah buffer.' : deviceBuffer ? 'Sampel menunggu sinkronisasi di RAM ESP32.' : 'Tidak ada antrean menurut ESP32.';
    } else {
      $('bufferCount').textContent = number(mock.buffer.length);
      $('bufferDetail').textContent = `Simulasi · RAM tab ini.${mock.dropped ? ` ${mock.dropped} sampel lama ditimpa.` : ''}${bufferSeenAt ? ` ESP32 terakhir: ${number(deviceBuffer)} (${clock(bufferSeenAt)}); nilai kini belum diketahui.` : ''}`;
    }
  }
  function render(data) {
    const mode = TG.classify(data), demo = data.source === 'demo';
    const sourceChanged = source !== data.source;
    source = data.source;
    const modeKey = `${source}:${mode}`;
    if (lastDisplayMode !== modeKey) {
      log(`${demo ? 'Simulasi' : 'Perangkat'}: ${mode === 'NORMAL' ? 'kondisi NORMAL' : mode === 'WARNING' ? 'WARNING · suhu melewati setpoint' : 'CRITICAL · asap melewati ambang'}.`, mode === 'NORMAL' ? 'success' : 'warning');
      lastDisplayMode = modeKey;
    }
    if (sourceChanged && demo) log('Telemetri tidak tersedia. Data contoh ditampilkan; kondisi ESP32 belum diketahui.', 'warning');
    $('statusCard').dataset.mode = mode;
    $('modeName').textContent = mode;
    $('modeDescription').textContent = {
      NORMAL: 'Suhu dan level asap berada di bawah batas proteksi.',
      WARNING: 'Suhu melewati setpoint. Ventilasi perlu dibuka sebagian.',
      CRITICAL: 'Asap/gas melewati ambang. Periksa ruang server segera.'
    }[mode];
    $('sourceBadge').textContent = demo ? 'Simulasi · data contoh' : 'Telemetri ESP32';
    $('statusOrigin').textContent = demo ? 'Bukan kondisi perangkat' : 'Dihitung dari sensor';
    $('statusSummary').textContent = `Respons target: servo ${TG.outputs[mode].servo}° · buzzer ${TG.outputs[mode].buzzer ? 'aktif' : 'nonaktif'}`;
    $('lastUpdate').textContent = clock(data.ts); $('lastUpdate').dateTime = new Date(data.ts).toISOString();
    $('temperature').textContent = number(data.temperature, 1); $('humidity').textContent = number(data.humidity, 1);
    $('smoke').textContent = number(data.smoke); $('setpoint').textContent = number(data.setpoint, 1);
    $('temperatureHint').textContent = `Batas ${number(data.setpoint, 1)} °C`;
    $('smokeHint').textContent = `Ambang ${number(data.smokeThreshold)} ppm`;
    const applied = data.configId === settings.configId;
    $('setpointHint').textContent = `${data.setpointMode === 'manual' ? 'Manual' : 'Potensiometer'}${demo ? ' · simulasi' : applied ? ' · terkonfirmasi' : ' · belum konfirmasi konfigurasi'}`;
    if (!demo && !applied && !invalidConfigLogged) { log('Konfigurasi ESP32 belum cocok dengan pengaturan dashboard.', 'warning'); invalidConfigLogged = true; }
    $('chartTempValue').textContent = `${number(data.temperature, 1)} °C`;
    $('chartSmokeValue').textContent = `${number(data.smoke)} ppm`;
    $('historySource').textContent = `120 sampel terakhir · ${demo ? 'simulasi' : 'ESP32'}`;
    const history = demo ? demoHistory : deviceHistory;
    tempChart.setData(history); smokeChart.setData(history);
    const a = data.actuators;
    const target = TG.outputs[mode];
    const mismatch = a && (a.servo !== target.servo || a.buzzer !== target.buzzer || a.led !== target.led);
    $('actuatorSource').textContent = demo ? 'Respons simulasi' : !a ? 'Belum ada laporan aktuator' : mismatch ? 'Laporan berbeda dari respons target' : 'Dilaporkan oleh ESP32';
    $('servoAngle').textContent = a ? `${a.servo}°` : '—'; $('servoLarge').textContent = a ? `${a.servo}°` : '—';
    $('servoNeedle').style.visibility = a ? 'visible' : 'hidden';
    $('servoNeedle').setAttribute('transform', `rotate(${a?.servo || 0} 100 94)`);
    $('servoGraphic').setAttribute('aria-label', a ? `Sudut servo ${a.servo} derajat` : 'Sudut servo belum diketahui');
    $('servoDescription').textContent = a ? ({ 0: 'Ventilasi tertutup', 45: 'Ventilasi setengah terbuka', 90: 'Ventilasi terbuka penuh' })[a.servo] : 'Menunggu telemetri aktuator';
    $('buzzerStatus').textContent = a ? a.buzzer ? 'Aktif' : 'Nonaktif' : 'Belum diketahui';
    $('buzzerStatus').classList.toggle('active-alert', Boolean(a?.buzzer));
    for (const color of ['Green', 'Yellow', 'Red']) {
      const led = $(`led${color}`), on = a?.led === color.toLowerCase();
      led.classList.toggle('is-on', on); led.setAttribute('aria-label', `${led.querySelector('span').textContent}: ${a ? on ? 'menyala' : 'padam' : 'belum diketahui'}`);
    }
    const telegramText = demo ? mode === 'CRITICAL' ? 'Darurat disimulasikan' : 'Simulasi siap' : data.telegramSent === true ? 'Terkirim oleh ESP32' : telegram.status;
    if ($('telegramStatus').textContent !== telegramText) $('telegramStatus').textContent = telegramText;
    $('simulationNote').textContent = demo ? 'Data contoh aktif. Kondisi perangkat belum diketahui.' : 'Telemetri perangkat aktif. Uji skenario dinonaktifkan.';
    document.querySelectorAll('[data-scenario]').forEach(button => { button.disabled = !demo; button.setAttribute('aria-pressed', String(demo && button.dataset.scenario === mock.mode)); });
    $('footerSource').textContent = demo ? 'Simulasi · tidak mengendalikan perangkat' : 'ESP32 · kendali proteksi lokal';
    updateBuffer();
  }
  function takeDemo() {
    lastDemo = mock.sample(); record(demoHistory, lastDemo);
    if (!mqtt.online) mock.collect(lastDemo);
  }
  function seedDemo() {
    demoHistory.length = 0;
    for (let i = 30; i > 0; i--) record(demoHistory, mock.sample(Date.now() - i * settings.refreshInterval));
    takeDemo();
  }
  function scheduleDemo() {
    clearTimeout(demoTimer);
    demoTimer = setTimeout(() => {
      if (!freshDevice()) { takeDemo(); render(lastDemo); }
      scheduleDemo();
    }, settings.refreshInterval);
  }
  mqtt.addEventListener('state', ({ detail }) => {
    $('connectionBadge').classList.toggle('online', detail.online);
    const connectionText = detail.online ? 'MQTT Online' : 'MQTT Offline';
    if ($('connectionText').textContent !== connectionText) $('connectionText').textContent = connectionText;
    $('networkDetail').textContent = detail.detail;
    if (detail.online !== lastConnection) {
      log(detail.online ? 'MQTT terhubung. Menunggu telemetri ESP32 terbaru.' : 'MQTT terputus. Firmware ESP32 tetap menjalankan proteksi lokal.', detail.online ? 'success' : 'warning');
      if (detail.online) {
        const batch = mock.sync(); batch.forEach(d => record(demoHistory, d));
        if (batch.length) log(`${batch.length} sampel demo disinkronkan ke riwayat lokal; tidak dikirim ke perangkat.`);
      }
      lastConnection = detail.online;
    }
    render(freshDevice() ? lastDevice : lastDemo);
  });
  mqtt.addEventListener('notice', ({ detail }) => log(detail));
  mqtt.addEventListener('sample', ({ detail: data }) => {
    const added = record(deviceHistory, data);
    if (data.bufferCount !== undefined) {
      if (deviceBuffer > 0 && data.bufferCount === 0) log('Buffer ESP32 selesai disinkronkan menurut laporan perangkat.', 'success');
      deviceBuffer = data.bufferCount; bufferSeenAt = Date.now();
    }
    // Replayed/retained history must never trigger a fresh emergency notification.
    if (!data.replay && (!lastDevice || data.ts >= lastDevice.ts)) {
      lastDevice = data;
      if (added && !data.retained && freshDevice()) {
        const mode = TG.classify(data);
        if (mode === 'CRITICAL' && lastLiveMode !== 'CRITICAL') telegram.enqueue(data);
        lastLiveMode = mode;
      }
    }
    render(freshDevice() ? lastDevice : lastDemo);
  });
  document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
    if (freshDevice()) return;
    mock.setScenario(button.dataset.scenario); takeDemo(); render(lastDemo);
  }));
  window.addEventListener('storage', event => {
    if (event.key !== TG.Settings.KEY && event.key !== null) return;
    settings = TG.Settings.load(); mqtt.settings = settings; mqtt.lastTimestamp = 0;
    telegram.stop(); telegram = new TelegramNotifier(settings); mock = new TG.MockData(settings);
    lastDevice = null; lastLiveMode = null; deviceHistory.length = 0; deviceBuffer = null; bufferSeenAt = 0; invalidConfigLogged = false;
    seedDemo(); scheduleDemo(); log('Pengaturan diperbarui dari tab lain.'); mqtt.connect();
  });
  seedDemo(); log('Simulasi aktif. Atur broker untuk menerima telemetri ESP32.');
  if (TG.Settings.storageError) log(TG.Settings.storageError, 'warning');
  render(lastDemo); mqtt.connect(); scheduleDemo();
  const timer = setInterval(() => {
    const live = freshDevice();
    telegram.tick(); render(live ? lastDevice : lastDemo);
  }, 1000);
  window.addEventListener('pagehide', () => { mqtt.stop(); telegram.stop(); clearInterval(timer); clearTimeout(demoTimer); });
  // Back-forward cache restores the document with stopped timers/connections.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
