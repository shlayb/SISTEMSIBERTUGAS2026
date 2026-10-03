(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('historyFilters');
  if (!form) return;
  const CSV_LIMIT = 10000;
  const state = { filters: null, cursors: [null], page: 0, next: null, loading: false, controller: null, exportController: null, generation: 0 };
  const number = value => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(value);

  function show(text, kind = 'ready') { $('historyMessage').textContent = text; $('historyMessage').dataset.state = kind; }
  function readFilters() {
    const filters = Object.fromEntries(new FormData(form));
    filters.deviceId = filters.deviceId.trim();
    if (filters.deviceId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(filters.deviceId)) throw new Error('ID perangkat tidak valid. Gunakan ID persis dari perangkat.');
    for (const key of ['from', 'to']) if (filters[key]) filters[key] = new Date(`${filters[key]}Z`).toISOString();
    if (filters.from && filters.to && filters.from > filters.to) throw new Error('Waktu awal harus sebelum atau sama dengan waktu akhir.');
    return filters;
  }

  async function fetchPage(filters, cursor, signal) {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
    if (cursor) params.set('cursor', cursor);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 10000);
    try {
      const response = await fetch(`/api/logs?${params}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 410) throw new Error('Sesi riwayat kedaluwarsa. Pilih Muat terbaru untuk mulai kembali.');
        if (response.status === 400) throw new Error('Filter atau cursor tidak valid. Terapkan ulang filter.');
        if (response.status === 404) throw new Error('Riwayat memerlukan backend Vercel. Buka situs yang sudah dikonfigurasi atau jalankan vercel dev.');
        throw new Error('Database riwayat belum tersedia. Monitoring langsung tetap dapat digunakan.');
      }
      const data = await response.json();
      if (!data || !Array.isArray(data.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('Respons riwayat tidak valid.');
      return data;
    } catch (error) {
      if (signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
      if (controller.signal.aborted) throw new Error('Waktu memuat riwayat habis. Coba Muat terbaru.');
      if (error instanceof SyntaxError) throw new Error('Respons riwayat tidak valid.');
      if (error instanceof TypeError) throw new Error('Riwayat tidak dapat dijangkau. Periksa koneksi internet.');
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  function line(parent, text, tag = 'div') {
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  }
  function cell(row, label) {
    const td = document.createElement('td'); td.dataset.label = label;
    const content = document.createElement('div'); td.append(content); row.append(td); return content;
  }
  function time(parent, iso, prefix = '') {
    const node = line(parent, `${prefix}${iso.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')}`, 'time'); node.dateTime = iso;
  }
  function render(items) {
    const rows = items.map(event => {
      const row = document.createElement('tr');
      const date = cell(row, 'Waktu UTC'); time(date, event.occurredAt); line(date, 'Diterima server', 'small'); time(date, event.receivedAt);
      const device = cell(row, 'Perangkat'); line(device, event.deviceId); line(device, event.eventId, 'small'); line(device, event.source === 'simulation' ? 'Simulasi' : 'Perangkat nyata', 'small');
      const status = line(cell(row, 'Status'), event.status, 'span'); status.className = 'history-state'; status.dataset.status = event.status;
      const sensors = cell(row, 'Sensor'); line(sensors, `${number(event.temperature)} °C`); line(sensors, `${number(event.humidity)} % RH`); line(sensors, `${number(event.smoke)} ppm`);
      line(cell(row, 'Setpoint'), `${number(event.setpoint)} °C`);
      const actuators = cell(row, 'Aktuator'); line(actuators, `Servo ${number(event.servo)}°`); line(actuators, `Buzzer ${event.buzzer ? 'aktif' : 'nonaktif'}`); line(actuators, `LED ${({ green: 'hijau', yellow: 'kuning', red: 'merah', off: 'padam' })[event.led] || event.led}`);
      const type = cell(row, 'Jenis event'); line(type, event.eventType); if (event.replay) line(type, 'Sinkronisasi buffer', 'small');
      return row;
    });
    $('historyRows').replaceChildren(...rows);
  }

  function controls() {
    $('historyResults').setAttribute('aria-busy', String(state.loading));
    $('previousLogs').disabled = state.loading || state.page === 0;
    $('nextLogs').disabled = state.loading || !state.next;
    $('refreshLogs').disabled = state.loading;
    $('historyPage').textContent = `Halaman ${state.page + 1}`;
  }
  async function loadPage(page = 0, reset = false) {
    state.controller?.abort();
    const generation = ++state.generation;
    const controller = state.controller = new AbortController();
    const cursor = reset ? null : state.cursors[page];
    if (reset) { state.cursors = [null]; state.page = 0; state.next = null; }
    state.loading = true; controls(); show('Memuat riwayat…', 'loading');
    try {
      const data = await fetchPage(state.filters, cursor, controller.signal);
      if (generation !== state.generation) return;
      if (reset) state.cursors = [null];
      state.page = page; state.next = data.nextCursor;
      state.cursors[page + 1] = data.nextCursor;
      render(data.items);
      $('historySummary').textContent = `${state.filters.source === 'device' ? 'Perangkat nyata' : 'Simulasi terpusat'} · ${data.items.length} baris · Retensi ${data.retentionDays} hari · Diperbarui ${new Date().toLocaleTimeString('id-ID')}`;
      if (!data.items.length) show(data.nextCursor ? 'Belum ada baris yang cocok di bagian ini. Pilih Berikutnya untuk melanjutkan.' : 'Belum ada log yang cocok dengan filter ini.');
      else show(page > 0 ? 'Pembaruan otomatis dijeda saat melihat halaman lama. Muat terbaru untuk kembali.' : 'Riwayat terbaru berhasil dimuat.');
    } catch (error) { if (error.name !== 'AbortError' && generation === state.generation) show(`${error.message} Data yang sudah tampil tetap dipertahankan.`, 'error'); }
    finally { if (generation === state.generation) { state.loading = false; controls(); } }
  }

  // Quote every string and neutralize spreadsheet formulas. Numeric measurements stay numeric.
  function csvCell(value) {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  async function exportCsv() {
    if (state.exportController) return;
    const controller = state.exportController = new AbortController();
    const filters = { ...state.filters, limit: '100' };
    const fields = ['eventId', 'deviceId', 'source', 'occurredAt', 'receivedAt', 'temperature', 'humidity', 'smoke', 'setpoint', 'status', 'servo', 'buzzer', 'led', 'eventType', 'replay'];
    const lines = [fields.join(',')];
    const seen = new Set();
    let cursor = null, count = 0, pages = 0;
    $('exportLogs').disabled = true; $('cancelExport').hidden = false;
    $('exportMessage').textContent = 'Menyiapkan CSV sesuai filter yang diterapkan…';
    try {
      do {
        const data = await fetchPage(filters, cursor, controller.signal);
        for (const event of data.items) {
          if (++count > CSV_LIMIT) throw new Error('Hasil melebihi 10.000 baris. Persempit filter waktu atau perangkat, lalu ekspor kembali.');
          lines.push(fields.map(field => csvCell(event[field])).join(','));
        }
        cursor = data.nextCursor;
        if (cursor && (seen.has(cursor) || ++pages > 1000)) throw new Error('Ekspor tidak dapat diselesaikan. Persempit filter dan coba lagi.');
        if (cursor) seen.add(cursor);
        $('exportMessage').textContent = `Menyiapkan CSV: ${count} baris…`;
      } while (cursor);
      const blob = new Blob(['\uFEFF', lines.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `thermoguard-${filters.source}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('exportMessage').textContent = `CSV siap: ${count} baris sesuai filter yang diterapkan.`;
    } catch (error) { $('exportMessage').textContent = error.name === 'AbortError' ? 'Ekspor dibatalkan.' : `${error.message} File parsial tidak diunduh.`; }
    finally { state.exportController = null; $('exportLogs').disabled = false; $('cancelExport').hidden = true; }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    try { const filters = readFilters(); state.exportController?.abort(); state.filters = filters; loadPage(0, true); }
    catch (error) { show(error.message, 'error'); }
  });
  $('refreshLogs').addEventListener('click', () => loadPage(0, true));
  $('previousLogs').addEventListener('click', () => { if (!state.loading && state.page > 0) loadPage(state.page - 1); });
  $('nextLogs').addEventListener('click', () => { if (!state.loading && state.next) loadPage(state.page + 1); });
  $('exportLogs').addEventListener('click', exportCsv);
  $('cancelExport').addEventListener('click', () => state.exportController?.abort());
  const timer = setInterval(() => {
    if ($('autoRefresh').checked && !document.hidden && !state.loading && state.page === 0) loadPage(0, true);
  }, 30000);
  window.addEventListener('pagehide', () => { clearInterval(timer); state.controller?.abort(); state.exportController?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  state.filters = readFilters(); loadPage(0, true);
})();
