(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const button = $('toggleLogging');
  if (!button) return;
  const label = $('loggingControlLabel'), status = $('loggingControlStatus');
  const dialog = $('loggingControlDialog'), form = $('loggingControlForm'), keyInput = $('loggingControlKey');
  let current = null, busy = false, generation = 0, activeController = null, pendingAction = null;

  function message(text, error = false) { status.textContent = text; status.dataset.state = error ? 'error' : 'ready'; }
  function render() {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    label.textContent = busy ? 'Memproses…' : current === null ? 'Coba lagi' : current.enabled ? 'Stop Logging' : 'Start Logging';
    if (current === null) { delete button.dataset.enabled; button.removeAttribute('aria-pressed'); }
    else { button.dataset.enabled = String(current.enabled); button.setAttribute('aria-pressed', String(current.enabled)); }
  }
  async function request(action, key, signal) {
    const options = { cache: 'no-store', signal };
    if (action) {
      options.method = 'POST'; options.headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }; options.body = JSON.stringify({ action });
    }
    const response = await fetch('/api/logging', options);
    if (!response.ok) {
      if (response.status === 401) throw new Error('Kunci operator salah. Coba lagi dengan kunci yang sesuai.');
      if (response.status === 429) throw new Error('Terlalu banyak perubahan. Tunggu sebentar lalu coba lagi.');
      if (response.status === 404) throw new Error('Kendali logging memerlukan backend Vercel yang sudah dikonfigurasi.');
      if (response.status === 403) throw new Error('Akses kendali logging ditolak.');
      throw new Error('Layanan logging belum tersedia. Periksa konfigurasi database dan kunci operator.');
    }
    const result = await response.json();
    if (result?.ok !== true || typeof result.enabled !== 'boolean') throw new Error('Status logging belum dapat dikonfirmasi.');
    return result;
  }
  async function sync(action = null, key = '') {
    if (busy) return;
    const version = ++generation;
    const controller = activeController = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    busy = true; render();
    if (action) message(action === 'start' ? 'Mengaktifkan logging bersama…' : 'Menghentikan logging bersama…');
    try {
      const result = await request(action, key, controller.signal);
      if (generation !== version) return;
      current = result;
      message(result.enabled ? 'Logging aktif untuk semua perangkat.' : 'Logging berhenti. Riwayat lama tetap tersedia.');
    } catch (error) {
      if (generation !== version) return;
      // A lost POST response may still have applied. Require a fresh GET before another change.
      current = null;
      const text = controller.signal.aborted ? 'Waktu konfirmasi logging habis.' : error instanceof TypeError ? 'Koneksi layanan logging gagal.' : error instanceof SyntaxError ? 'Respons layanan logging tidak valid.' : error.message;
      message(`${text} Tekan Coba lagi untuk memeriksa status.`, true);
    } finally {
      clearTimeout(timer);
      if (generation === version) { busy = false; activeController = null; render(); }
    }
  }
  button.addEventListener('click', () => {
    if (busy) return;
    if (current === null) { sync(); return; }
    pendingAction = current.enabled ? 'stop' : 'start';
    $('confirmLoggingControl').textContent = pendingAction === 'start' ? 'Start Logging' : 'Stop Logging';
    $('loggingDialogTitle').textContent = pendingAction === 'start' ? 'Mulai logging bersama' : 'Hentikan logging bersama';
    keyInput.value = ''; dialog.showModal(); keyInput.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !pendingAction || !form.reportValidity()) return;
    const action = pendingAction, key = keyInput.value;
    pendingAction = null; keyInput.value = ''; dialog.close(); sync(action, key);
  });
  function cancel() { pendingAction = null; keyInput.value = ''; }
  $('cancelLoggingControl').addEventListener('click', () => { cancel(); dialog.close(); });
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', () => { keyInput.value = ''; });
  const timer = setInterval(() => { if (!document.hidden && !busy && !dialog.open) sync(); }, 15000);
  window.addEventListener('pagehide', () => { ++generation; activeController?.abort(); clearInterval(timer); cancel(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  sync();
})();
