(() => {
  'use strict';
  const TG = window.ThermoGuard;
  function parseTelemetry(raw) {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Objek JSON diperlukan.');
    for (const [key, min, max] of [['temperature', -40, 80], ['humidity', 0, 100], ['smoke', 0, 100000], ['setpoint', 0, 80], ['smokeThreshold', 1, 100000]]) {
      if (typeof d[key] !== 'number' || !Number.isFinite(d[key]) || d[key] < min || d[key] > max) throw new Error(`Nilai ${key} tidak valid.`);
    }
    if (!Number.isSafeInteger(d.ts) || d.ts < 1000000000000 || d.ts > Date.now() + 60000) throw new Error('ts harus berupa epoch milidetik; periksa jam ESP32.');
    if (typeof d.id !== 'string' || !d.id.length || d.id.length > 100) throw new Error('id sampel diperlukan.');
    if (!['potentiometer', 'manual'].includes(d.setpointMode)) throw new Error('setpointMode tidak valid.');
    if (d.replay !== undefined && typeof d.replay !== 'boolean') throw new Error('replay harus boolean.');
    if (d.bufferCount !== undefined && (!Number.isSafeInteger(d.bufferCount) || d.bufferCount < 0)) throw new Error('bufferCount tidak valid.');
    if (d.actuators !== undefined) {
      const a = d.actuators;
      if (!a || ![0, 45, 90].includes(a.servo) || typeof a.buzzer !== 'boolean' || !['green', 'yellow', 'red'].includes(a.led)) throw new Error('Data aktuator tidak valid.');
    }
    return { ...d, source: 'device', replay: d.replay === true };
  }
  class MQTTClient extends EventTarget {
    constructor(settings) { super(); this.settings = settings; this.client = null; this.online = false; this.generation = 0; this.lastTimestamp = 0; this.lastErrorAt = 0; }
    emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
    state(online, detail) { this.online = online; this.emit('state', { online, detail }); }
    report(message) {
      if (Date.now() - this.lastErrorAt < 10000) return;
      this.lastErrorAt = Date.now(); this.emit('notice', message);
    }
    connect() {
      this.stop();
      const s = this.settings;
      if (!s.brokerHost) return this.state(false, 'Broker belum diatur');
      if (!window.mqtt) return this.state(false, 'mqtt.js gagal dimuat; periksa internet');
      if (location.protocol === 'https:' && s.brokerProtocol !== 'wss') return this.state(false, 'HTTPS memerlukan broker WSS');
      const generation = this.generation;
      this.state(false, 'Menghubungkan ke broker…');
      let client;
      try {
        client = window.mqtt.connect(`${s.brokerProtocol}://${s.brokerHost}:${s.brokerPort}${s.brokerPath}`, {
          clientId: `tg-web-${Math.random().toString(16).slice(2)}`, clean: true,
          reconnectPeriod: 3000, connectTimeout: 10000, keepalive: 30,
          queueQoSZero: false, resubscribe: false,
          username: s.mqttUsername || undefined, password: s.mqttPassword || undefined
        });
      } catch (_) { this.state(false, 'Koneksi gagal; periksa endpoint broker'); return; }
      this.client = client;
      const current = () => generation === this.generation;
      client.on('connect', () => {
        if (!current()) return;
        client.subscribe(`${s.topic}/telemetry`, { qos: 1 }, (error, granted) => {
          if (!current()) return;
          if (error || !granted?.length || granted.some(g => g.qos >= 128)) {
            this.state(false, 'Akses topik ditolak broker');
            this.report('Subscribe gagal. Periksa topik dan izin broker.'); return;
          }
          this.state(true, `Terhubung · ${s.brokerHost}`);
          this.publishConfig();
          this.requestSync();
        });
      });
      client.on('message', (topic, payload, packet) => {
        if (!current() || topic !== `${s.topic}/telemetry`) return;
        try {
          if (payload.length > 65536) throw new Error('Payload terlalu besar.');
          const data = parseTelemetry(payload.toString());
          data.retained = packet?.retain === true;
          if (!data.replay) this.lastTimestamp = Math.max(this.lastTimestamp, data.ts);
          this.emit('sample', data);
        } catch (error) { this.report(`Telemetri ditolak: ${error.message}`); }
      });
      client.on('reconnect', () => { if (current()) this.state(false, 'Mencoba menghubungkan kembali…'); });
      client.on('offline', () => { if (current()) this.state(false, 'Jaringan MQTT terputus'); });
      client.on('close', () => { if (current()) this.state(false, 'MQTT offline · mencoba kembali'); });
      client.on('error', () => { if (current()) this.report('Koneksi MQTT bermasalah. Periksa endpoint, TLS, dan kredensial.'); });
    }
    publish(topic, data, retain = false) {
      if (!this.online || !this.client?.connected) return Promise.reject(new Error('MQTT offline'));
      return new Promise((resolve, reject) => {
        this.client.publish(`${this.settings.topic}/${topic}`, JSON.stringify(data), { qos: 1, retain }, error => error ? reject(error) : resolve());
      });
    }
    publishConfig() {
      const s = this.settings;
      this.publish('config', { configId: s.configId, setpointMode: s.setpointMode, manualSetpoint: s.manualSetpoint, smokeThreshold: s.smokeThreshold, sampleIntervalMs: s.refreshInterval }, true)
        .then(() => this.emit('notice', 'Konfigurasi diterima broker; menunggu konfirmasi ESP32.'))
        .catch(() => this.report('Konfigurasi belum terkirim; akan dicoba saat tersambung kembali.'));
    }
    requestSync() {
      this.publish('sync', { requestId: `sync-${Date.now()}`, since: this.lastTimestamp, replay: true })
        .then(() => this.emit('notice', 'Sinkronisasi buffer ESP32 diminta.'))
        .catch(() => this.report('Permintaan sinkronisasi belum terkirim.'));
    }
    stop() {
      this.generation++; this.online = false;
      if (this.client) { this.client.removeAllListeners(); this.client.on('error', () => {}); this.client.end(true); this.client = null; }
    }
  }
  TG.parseTelemetry = parseTelemetry;
  TG.MQTTClient = MQTTClient;
})();
