import { readFile } from 'node:fs/promises';

// Usage: node examples/send-log.mjs examples/telemetry.json
// Credentials are read only from the trusted sender's process environment.
const { INGEST_URL, INGEST_SOURCE, INGEST_SOURCE_KEY } = process.env;
const file = process.argv[2];
if (!file || !INGEST_URL || !INGEST_SOURCE || !INGEST_SOURCE_KEY) {
  console.error('Isi INGEST_URL, INGEST_SOURCE, INGEST_SOURCE_KEY dan berikan path payload JSON.');
  process.exitCode = 1;
} else {
  try {
    const url = new URL(INGEST_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS required');
    const body = await readFile(file, 'utf8');
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Source': INGEST_SOURCE, Authorization: `Bearer ${INGEST_SOURCE_KEY}` },
      body, signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      console.error(`Ingest ditolak: HTTP ${response.status}. ${result.error || ''}`);
      process.exitCode = 1;
    } else console.log(result.skipped ? 'Logging sedang Stop; event sengaja tidak dicatat.' : result.duplicate ? 'Event sudah diterima; tidak ada log ganda.' : 'Event tersimpan.');
  } catch {
    console.error('Pengiriman belum terkonfirmasi. Periksa koneksi/konfigurasi. Jika mengulang, gunakan eventId dan timestamp asli yang sama.');
    process.exitCode = 1;
  }
}
