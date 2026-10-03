# ThermoGuard-CPS

Dashboard berbahasa Indonesia untuk ESP32, DHT22, MQ-2, servo ventilasi, buzzer, dan tiga LED. Frontend tetap HTML + Tailwind CDN + JavaScript vanilla, tanpa framework atau build step. Vercel Functions menyediakan backend log bersama melalui Upstash Redis; npm hanya diperlukan untuk dependensi backend, pengembangan, dan pengujian.

## Struktur

```text
thermoguard-cps/
  index.html
  settings.html
  history.html
  assets/
    css/custom.css
    css/history.css
    js/app.js
    js/mqtt-client.js
    js/settings.js
    js/mock-data.js
    js/history.js
    js/logging-control.js
  api/ingest.js
  api/logs.js
  api/logging.js
  api/settings.js
  server/log-config.js
  server/log-validation.js
  server/log-store.js
  server/logging-control.js
  server/redis-rest.js
  examples/telemetry.json
  examples/broker-payload.js
  examples/send-log.mjs
  tests/
  .env.example
  package.json
  vercel.json
  README.md
```

## Menjalankan

1. Ekstrak folder, lalu buka `index.html` di browser modern.
2. Simulasi otomatis aktif. Coba tombol Normal, Warning, dan Critical.
3. Buka ikon gear, isi koneksi MQTT, lalu klik **Simpan pengaturan** dan kembali ke **Monitoring**.
4. MQTT.js, Tailwind, dan Inter diunduh melalui CDN sehingga pemuatan pertama memerlukan internet. CSS lokal mempertahankan layout dasar jika CDN gagal. Ini bukan aplikasi PWA untuk pemuatan offline penuh.
5. Browser dapat membatasi `localStorage` per berkas pada `file://`. Jika pengaturan tidak terbawa antarahalaman, gunakan HTTP lokal: jalankan `python -m http.server 8000` dari folder proyek, lalu buka `http://localhost:8000`. Vercel memakai origin yang sama untuk kedua halaman.
6. **Riwayat terpusat** memerlukan endpoint backend dan Upstash; server statis/file lokal hanya menjalankan monitoring dan pengaturan. Untuk menjalankan seluruh aplikasi, gunakan Node.js 24, `npm install`, isi environment lokal sesuai `.env.example`, lalu jalankan `npx vercel dev`. Jangan memasukkan kunci ingest ke halaman Pengaturan.

## Deploy ke Vercel

1. Masukkan seluruh isi folder ini ke root repositori GitHub/GitLab/Bitbucket.
2. Di Vercel pilih **Add New → Project**, lalu impor repositori.
3. Pilih **Framework Preset: Other**. Root Directory adalah folder yang berisi `index.html`.
4. Kosongkan Build Command; biarkan Install Command otomatis (`npm install`), dan Output Directory gunakan `.` (root proyek). Pilih Node.js **24.x**, sesuai `package.json`. Frontend tidak memerlukan build.
5. Klik **Deploy**. `vercel.json` mengaktifkan `cleanUrls: true`: `settings.html` tersedia sebagai `/settings`; tautan `.html` tetap diarahkan oleh Vercel. Tidak ada rewrite SPA.
6. Hubungkan Upstash dan isi environment log seperti bagian berikut, lalu redeploy. Isi pengaturan MQTT pada domain Vercel. Gunakan **WSS**, karena halaman HTTPS menolak WebSocket WS yang tidak aman. Port harus port WebSocket broker, bukan port MQTT TCP 1883/8883.

Alternatif dengan Vercel CLI yang sudah terpasang: jalankan `vercel` dari folder ini, pilih proyek statis, lalu `vercel --prod` untuk rilis produksi. Folder ini siap deploy; tidak berisi kredensial atau deployment yang sudah dibuat.

## MQTT dan kontrak ESP32

Pengaturan awal: host kosong, WSS, port 8084, path `/mqtt`, topik dasar `thermoguard/server-01`, suhu manual 30 °C, ambang asap 400 ppm, interval 2000 ms. Port/path harus disesuaikan dengan broker. Gunakan topik unik dan ACL pada broker yang dipakai bersama.

| Topik | Arah | QoS | Retain | Fungsi |
|---|---|---|---|---|
| `<topik>/telemetry` | ESP32 → dashboard | 1 | false | Sampel sensor dan laporan aktuator |
| `<topik>/config` | Dashboard → ESP32 | 1 | true | Setpoint, ambang, dan interval |
| `<topik>/sync` | Dashboard → ESP32 | 1 | false | Permintaan replay buffer |

Browser memakai `mqtt.connect()` dari MQTT.js CDN. Reconnect dicoba setiap 3 detik, timeout koneksi 10 detik. Indikator online baru aktif setelah subscribe disetujui broker; koneksi broker tidak membuktikan perangkat tersedia.

### Payload telemetri

Kirim **satu objek JSON per pesan**, bukan array. Contoh berikut harus menggunakan `ts` waktu aktual dari ESP32 yang disinkronkan NTP, dalam **epoch milidetik**, dan `id` unik per sampel (misalnya ID boot + nomor urut).

```json
{
  "id": "boot-7a21-1042",
  "ts": 1791012000000,
  "temperature": 27.3,
  "humidity": 48.1,
  "smoke": 75,
  "setpoint": 30,
  "setpointMode": "potentiometer",
  "smokeThreshold": 400,
  "configId": "cfg-yang-diterima-dari-dashboard",
  "bufferCount": 0,
  "replay": false,
  "actuators": { "servo": 0, "buzzer": false, "led": "green" },
  "telegramSent": false,
  "alertId": "boot-7a21-incident-001"
}
```

Wajib: `id`, `ts`, `temperature`, `humidity`, `smoke`, `setpoint`, `setpointMode`, `smokeThreshold`. `configId`, `bufferCount`, `replay`, `actuators`, `telegramSent`, dan `alertId` opsional. Jika `actuators` tidak dikirim, panel menunjukkan belum diketahui; sudut atau buzzer nyata tidak ditebak. `telegramSent: true` hanya boleh dikirim setelah ESP32 mendapat konfirmasi Telegram. `alertId` harus tetap sama selama satu insiden dan berganti untuk insiden berikutnya.

MQ-2 harus dikalibrasi di firmware sebelum angka dikirim sebagai ppm. ADC mentah bukan ppm. Angka 400 ppm adalah nilai awal demonstrasi, bukan ambang kebakaran tersertifikasi. Tidak ada firmware ESP32 di paket website ini.

### Logika proteksi lokal

| Mode | Kondisi, menurut prioritas | Servo | LED fisik | Buzzer |
|---|---|---|---|---|
| CRITICAL | `smoke >= smokeThreshold` | 90° | Merah | Aktif |
| WARNING | `smoke < smokeThreshold` dan `temperature > setpoint` | 45° | Kuning | Nonaktif |
| NORMAL | Kondisi selain dua baris di atas | 0° | Hijau | Nonaktif |

ESP32 wajib menjalankan logika ini pada loop/tugas lokal, terpisah dari reconnect MQTT/HTTP. Jangan menunggu dashboard untuk menggerakkan aktuator. Label “100% lokal” menjelaskan arsitektur firmware yang harus diterapkan; website tidak dapat menjamin fungsi perangkat tanpa firmware tersebut. Pada UI, LED Kuning dan Merah memakai aksen oranye dengan label yang berbeda agar palet tetap hijau/oranye sesuai desain.

### Konfigurasi dan konfirmasi

Setelah subscribe, dashboard mengirim payload konfigurasi berikut. Token Telegram tidak dikirim lewat MQTT.

```json
{
  "configId": "cfg-1791012000000-abc123",
  "setpointMode": "manual",
  "manualSetpoint": 30,
  "smokeThreshold": 400,
  "sampleIntervalMs": 2000
}
```

ESP32 harus memvalidasi, menerapkan, dan mempertahankan konfigurasi terakhir. Pada mode `potentiometer`, abaikan `manualSetpoint` dan baca potensiometer. Laporkan setpoint, ambang asap, sumber setpoint, dan `configId` yang benar-benar aktif pada telemetri. Angka batas pada dashboard selalu mengikuti laporan perangkat; pengaturan yang belum dikonfirmasi tidak dianggap sudah aktif. Interval dashboard mengatur pembuatan data demo dan meminta interval telemetri perangkat; pemeriksaan kesehatan UI berjalan setiap 1 detik. Logika keselamatan lokal tidak boleh dibatasi interval telemetri ini.

### Buffer dan sinkronisasi

**Perangkat:** saat jaringan putus, firmware menampung data pada ring buffer RAM ESP32 dan tetap mengendalikan aktuator. Setelah koneksi pulih, firmware dapat langsung mengosongkan antrean, atau menanggapi `<topik>/sync`:

```json
{ "requestId": "sync-1791012000000", "since": 1791011900000, "replay": true }
```

Kirim sampel tertampung ke `/telemetry` dengan `replay: true`, `id` dan `ts` asli, serta `bufferCount` terbaru. `since` adalah petunjuk waktu telemetri terakhir, bukan bukti semua sampel sebelumnya diterima; kirim seluruh sampel yang belum diakui broker. Hapus item dari ring buffer hanya setelah PUBACK QoS 1, kemudian laporkan `bufferCount: 0`. Dashboard mengurutkan dan menghapus duplikat berdasarkan `id`, mempertahankan 120 sampel terbaru, dan tidak mengaktifkan ulang alarm dari replay. Ukuran dan kebijakan overflow buffer ESP32 perlu ditentukan di firmware.

**Browser:** tidak dapat menerima pengukuran baru dari ESP32 saat koneksi putus. Jumlah buffer ESP32 yang ditampilkan saat offline adalah laporan terakhir, bukan hitungan langsung. Kondisi ruang yang sebenarnya tidak diketahui sampai telemetri segar diterima.

**Demo:** ada ring buffer RAM terpisah maksimal 120 sampel di tab ini. Saat MQTT offline, data dummy masuk ke antrean demo. Ketika broker tersambung, antrean digabung/dideduplikasi ke riwayat demo lokal, lalu dikosongkan. Data dummy **tidak pernah dipublikasikan** ke topik perangkat. Buffer demo hilang ketika tab dimuat ulang/ditutup; sampel tertua ditimpa ketika penuh. Riwayat awal 30 sampel dibangkitkan khusus demonstrasi.

Simulasi otomatis aktif jika MQTT terputus, broker belum diatur, atau telemetri lebih lama dari `max(15 detik, 3 × interval refresh)`. Paket replay tidak menjadi kondisi saat ini. Tombol skenario dinonaktifkan ketika data perangkat aktif. Grafik simulasi dan perangkat disimpan terpisah; pergantian sumber tidak mencampur keduanya.

## Logging terpusat dengan Upstash Redis

Alur pencatatan: **ESP32 → MQTT broker → webhook HTTPS → POST /api/ingest → Upstash Redis**. Alternatifnya, ESP32 mengirim HTTPS langsung ke endpoint yang sama. Browser membaca **GET /api/logs** dan mengendalikan Start/Stop melalui endpoint terpisah; tidak mengirim log perangkat atau menyimpan kunci ingest. Selama status **Start** aktif, menutup semua dashboard tidak menghentikan pencatatan karena pengirim berada di broker/perangkat. Pengiriman HTTP harus benar-benar dikonfigurasi pada pengirim; subscribe MQTT di browser saja tidak cukup.

`history.html` dibuka melalui tombol **Riwayat terpusat** di monitoring atau tautan di Pengaturan. Halaman terpisah ini tidak memblokir pemantauan MQTT, grafik, aktuator, Simpan/Reset, atau uji Telegram ketika database gagal. Log event lokal 20 baris dan grafik 120 sampel tetap tersedia seperti sebelumnya.

### Tombol Start / Stop Logging

Tombol berada di header monitoring, tepat **di kiri indikator MQTT dan tombol Pengaturan**. Logging terpusat awalnya **berhenti** sampai operator menekan **Start Logging** dan memasukkan kunci operator. Saat aktif, tombol berubah menjadi **Stop Logging**. Perubahan baru dianggap berhasil setelah server mengonfirmasi; tombol dikunci selama request, dan timeout tidak memicu pengulangan perubahan otomatis.

Isi `LOG_CONTROL_KEY` pada environment server dengan kunci acak tersendiri minimal 32 karakter tanpa spasi. Gunakan kunci ini di dialog Start/Stop, bukan token ingest atau token Redis. Kunci operator tidak ditanam dalam kode frontend, tidak disimpan ke localStorage/sessionStorage, dan isian dibersihkan setelah dikirim atau dibatalkan. Pengunjung tetap bebas membaca status/riwayat; hanya operator yang memiliki kunci dapat mengubah status logging.

Status berlaku **global untuk seluruh sumber/perangkat**, disimpan di Redis tanpa TTL, dan diperiksa ulang pada dashboard setiap 15 detik saat tab terlihat. Refresh halaman, pergantian perangkat, dan penutupan browser mempertahankan status terakhir. Start tidak memerlukan koneksi MQTT di tab dashboard; pencatatan terjadi ketika telemetri dari sumber tepercaya masuk.

**Stop** menghentikan penyimpanan event baru tanpa menghapus riwayat lama. Pengecekan status berada dalam skrip atomik yang sama dengan penyimpanan, sehingga request ingest yang berlomba dengan Stop tidak dapat menulis setelah Stop selesai diterapkan. Event yang sudah tersimpan tetap mendapat acknowledgment duplikat. Untuk event baru yang masuk selama Stop, ingest mengembalikan **200**, `ok: true`, `recorded: false`, `skipped: true`, `reason: "logging_stopped"`; perlakukan sebagai event sengaja dilewati, jangan antrekan retry otomatis. Start berikutnya menerima event yang masuk sejak status aktif; tidak ada antrean event Stop di backend. Buffer offline yang baru dikirim setelah Start tetap memakai timestamp asli sesuai kontrak replay.

Endpoint kendali: **GET /api/logging** publik untuk membaca status; **POST /api/logging** dengan body `{"action":"start"}` atau `{"action":"stop"}` dan `Authorization: Bearer <LOG_CONTROL_KEY>`. Request browser harus berasal dari origin situs yang sama. Kendali dibatasi 20 perubahan per 60 detik; kredensial sumber ingest tidak memberi akses kendali ini. Endpoint ini tidak mengedit atau menghapus log sensor.

### 1. Hubungkan Upstash melalui Vercel Marketplace

1. Buka proyek Vercel → **Storage / Marketplace**, pilih **Upstash Redis**, buat atau hubungkan database, lalu hubungkan ke proyek dan environment yang sesuai. Gunakan database terpisah untuk Development/Preview dan Production.
2. Pastikan proyek menerima `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN`. Jika integrasi memakai nama `KV_REST_API_URL` dan `KV_REST_API_TOKEN`, backend juga menerima pasangan tersebut. Jangan gunakan token readonly untuk ingest. Jangan menyalin token ke HTML atau JavaScript frontend.
3. Tambahkan `LOG_CURSOR_SECRET`, `LOG_CONTROL_KEY`, dan `INGEST_SOURCES` melalui **Settings → Environment Variables**. Buat setiap rahasia secara terpisah dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Jangan memakai nilai placeholder dari `.env.example`.
4. Atur retensi dan batas ingest, lalu **redeploy** agar environment berlaku. Untuk pengembangan lokal, simpan nilai di `.env.local` yang sudah diabaikan Git; `.env*` juga dikecualikan dari berkas deploy. Jangan commit rahasia.

Gunakan domain Production yang dapat diakses publik untuk dashboard dan webhook. Deployment Preview yang dilindungi autentikasi Vercel tidak dapat dipakai sebagai endpoint publik tanpa konfigurasi akses tambahan.

Konfigurasi ini mengikuti [Redis di Vercel Marketplace](https://vercel.com/docs/redis), [integrasi Upstash–Vercel](https://upstash.com/docs/redis/howto/vercelintegration), dan [Vercel Functions Node.js](https://vercel.com/docs/functions/runtimes/node-js). Kredensial REST dipakai lewat header server sesuai [Upstash REST API](https://upstash.com/docs/redis/features/restapi).

| Environment server | Fungsi |
|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Koneksi HTTPS database log; alias `KV_REST_API_URL`, `KV_REST_API_TOKEN` didukung. |
| `LOG_CURSOR_SECRET` | Rahasia acak minimal 32 karakter untuk menandatangani cursor; rotasi membatalkan cursor lama. |
| `LOG_CONTROL_KEY` | Kunci operator terpisah untuk Start/Stop logging bersama, 32–256 karakter ASCII tanpa spasi. |
| `INGEST_SOURCES` | Objek JSON sumber: token, daftar perangkat yang diizinkan, dan sumber `device`/`simulation`. |
| `LOG_RETENTION_DAYS` | Masa retensi 1–90 hari, default **7**. Berdasarkan waktu kejadian asli, bukan waktu replay. |
| `INGEST_RATE_LIMIT_PER_MINUTE` | Maksimal request per sumber dalam jendela 60 detik, default **120**; termasuk retry dan payload tidak valid setelah autentikasi. Rentang 1–10.000. |
| `REDIS_URL` | Opsional, untuk fitur sinkronisasi pengaturan lama di `/api/settings`; terpisah dari backend log. Konfigurasi lama tetap dipertahankan. |

Contoh struktur `INGEST_SOURCES` (ganti token dengan rahasia acak berbeda):

```json
{
  "broker-main": {
    "token": "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARS",
    "devices": ["server-01", "server-02"],
    "source": "device"
  },
  "demo-source": {
    "token": "REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET",
    "devices": ["demo-01"],
    "source": "simulation"
  }
}
```

### 2. Kontrak POST /api/ingest

Gunakan `Content-Type: application/json`, `X-Ingest-Source: broker-main`, dan `Authorization: Bearer <token-sumber>`. Kunci pembanding di Vercel hanya berasal dari environment server. Pengirim tepercaya harus diberi kredensial melalui secret store broker/proses atau provisioning aman perangkat; kunci tersebut **tidak pernah** diberikan kepada dashboard atau dimasukkan ke repository. Untuk menjaga kunci HTTP hanya di lingkungan server, gunakan jalur webhook broker; ESP32 cukup memakai MQTT yang sudah ada.

Satu request menerima **satu event**, maksimal **16 KiB** termasuk whitespace, tanpa kompresi. Body array/batch, field tambahan, token Telegram, password, dan metadata bebas ditolak. Semua angka harus JSON number, bukan string. `actuators` wajib berisi laporan aktuator yang benar-benar aktif; jangan menebaknya di backend.

```json
{
  "eventId": "boot-7a21-1042",
  "deviceId": "server-01",
  "occurredAt": "2026-10-03T08:15:00.000Z",
  "temperature": 32.4,
  "humidity": 48.1,
  "smoke": 620,
  "setpoint": 30,
  "status": "CRITICAL",
  "actuators": { "servo": 90, "buzzer": true, "led": "red" },
  "eventType": "TELEMETRY",
  "source": "device",
  "replay": false
}
```

Contoh berkas lengkap: `examples/telemetry.json`. Ganti waktu contoh dengan waktu kejadian yang masih berada dalam retensi sebelum mengujinya. Alternatif `occurredAt`: kirim **`ts` epoch milidetik** dari telemetri lama; jangan kirim keduanya. `receivedAt` dibuat server dalam UTC dan tidak boleh dikirim klien.

- `eventId` dan `deviceId`: 1–96 karakter; diawali huruf/angka, berikutnya huruf/angka/titik/garis bawah/tanda hubung. Event ID harus stabil, misalnya ID boot acak + nomor urut; jangan membuat ID baru saat retry atau replay.
- Suhu −40…80 °C, kelembapan 0…100 %, asap 0…100.000 ppm, setpoint 0…80 °C. Servo 0…180°, buzzer boolean, LED `green`, `yellow`, `red`, atau `off`.
- `status`: `NORMAL`, `WARNING`, `CRITICAL`. `eventType`: `TELEMETRY`, `STATE_CHANGE`, `DEVICE_BOOT`, `BUFFER_SYNC`.
- `source` opsional; jika dikirim harus cocok dengan sumber yang diautentikasi. `replay` opsional boolean. Waktu tidak boleh lebih dari 60 detik di masa depan; gunakan NTP.
- Response **201** dengan `recorded: true` berarti tersimpan. Response **200** dengan `duplicate: true` berarti pasangan `deviceId + eventId` sudah diterima dalam ruang sumber yang sama. Keduanya aman dianggap sebagai acknowledgment; retry tidak mengubah isi atau `receivedAt` pertama. Saat logging Stop, event baru mendapat **200** `recorded: false, skipped: true`; ini acknowledgment untuk melewati event, bukan bukti penyimpanan.
- **400** payload tidak valid; **401** autentikasi gagal; **403** perangkat/sumber tidak diizinkan; **408** body timeout; **410** kejadian di luar retensi; **413** terlalu besar; **415** tipe body salah; **429** melebihi batas dengan `Retry-After`; **503** konfigurasi/database belum tersedia. Metode selain POST mendapat **405**.

### 3. Webhook broker dan HTTPS ESP32

**Broker MQTT:** buat aturan pada topik perangkat yang sudah dilindungi ACL, misalnya `thermoguard/server-01/telemetry`. Petakan payload ke kontrak ingest, kirim HTTPS POST ke `https://DOMAIN-VERCEL/api/ingest`, dan tambahkan dua header autentikasi di pengaturan rahasia broker. Ikat `deviceId` ke topik/client yang dipercaya. `examples/broker-payload.js` berisi pemetaan lengkap dari payload MQTT yang digunakan proyek ini, termasuk perhitungan status dan pemeliharaan `id`, `ts`, serta `replay`. Sesuaikan pemetaan ke template HTTP broker; jangan mengirim wrapper MQTT, seluruh konfigurasi, atau kredensial.

Broker harus menyediakan antrean pengiriman HTTP dan retry ketika menerima 429/503 atau timeout; hormati `Retry-After` dan gunakan backoff. MQTT PUBACK hanya membuktikan broker menerima pesan, bukan bukti Redis menyimpannya. Untuk mencegah kehilangan data, aktifkan antrean persisten pada jalur webhook atau acknowledgment aplikasi sebelum firmware menghapus buffer yang diperlukan untuk log pusat. Aturan retry ini untuk ingest, bukan tombol uji Telegram.

**ESP32 HTTPS langsung:** lakukan POST dengan body/header yang sama dari task pengiriman terpisah, gunakan validasi sertifikat TLS (jangan `setInsecure()`), dan jangan menghambat loop proteksi lokal. Simpan sampel beserta ID dan waktu asli di buffer saat offline. Setelah kembali online, kirim ulang satu per request dengan `replay: true`; jangan mengganti timestamp dengan waktu sinkronisasi. Hapus dari antrean setelah menerima 200/201 `ok: true`. Kejadian yang mendapat 410 telah melewati retensi; tangani sebagai data kedaluwarsa, jangan terus mengulangnya. Provisioning rahasia di perangkat diperlukan hanya untuk jalur langsung ini.

Untuk menguji pengiriman dari proses tepercaya, aktifkan **Start Logging** terlebih dahulu. Set environment `INGEST_URL`, `INGEST_SOURCE`, dan `INGEST_SOURCE_KEY` pada terminal, lalu:

```sh
node examples/send-log.mjs examples/telemetry.json
```

Script membaca kunci dari environment, melakukan satu POST dengan timeout 10 detik, dan tidak mengganti ID/timestamp. Jalankan dua kali dengan file yang sama untuk membuktikan deduplikasi. Contoh HTTP ekuivalen dari shell yang sudah memiliki environment tersebut:

```sh
curl --request POST "$INGEST_URL" \
  --header "Content-Type: application/json" \
  --header "X-Ingest-Source: $INGEST_SOURCE" \
  --header "Authorization: Bearer $INGEST_SOURCE_KEY" \
  --data-binary @examples/telemetry.json
```

### 4. Riwayat publik, filter, pagination, dan CSV

`GET /api/logs` dapat dibaca tanpa login dan tidak menerima perintah Redis. POST/PUT/PATCH/DELETE pada endpoint baca ditolak. Endpoint tidak mengubah atau menghapus log; fungsi pembaca menjalankan `EVAL_RO` dan `MGET`. Redis URL, token Redis, kunci ingest, dan rahasia cursor tidak pernah dikirim ke frontend. Jangan memublikasikan hostname/lokasi sensitif dalam `deviceId` jika riwayat ditujukan untuk umum.

Parameter yang didukung:

| Parameter | Arti |
|---|---|
| `source` | `device` (default) atau `simulation`; tidak dicampur dalam satu hasil. |
| `deviceId` | ID persis, kosong berarti semua perangkat pada sumber terpilih. |
| `status` | NORMAL/WARNING/CRITICAL, kosong berarti semua. |
| `from`, `to` | Batas waktu **kejadian**, inklusif, ISO 8601 UTC. Default dari batas retensi hingga saat request pertama. |
| `limit` | 1–100, default 25. |
| `cursor` | Nilai `nextCursor` dari response sebelumnya; pertahankan filter yang sama. |

```text
GET /api/logs?source=device&deviceId=server-01&status=CRITICAL&limit=25
```

Response berisi `items`, `nextCursor` (null bila selesai), `snapshotAt`, dan `retentionDays`. Setiap item berisi seluruh nilai sensor/aktuator, kedua waktu UTC, `eventId`, `deviceId`, `source`, `status`, `eventType`, dan `replay`. Urutan terbaru memakai waktu kejadian lalu ID internal deterministik untuk tie. Cursor bertanda tangan berlaku **15 menit**; 410 berarti mulai ulang dari halaman pertama. Watermark urutan penerimaan mengecualikan event yang baru masuk di tengah pagination, termasuk event offline yang waktu kejadiannya lebih lama. Ini bukan backup/snapshot permanen: retensi tetap berlaku selama penelusuran.

UI memperbarui halaman pertama setiap **30 detik**, melewati tab tersembunyi dan request yang masih berjalan. Pembaruan otomatis dijeda di halaman lama agar posisi baca tidak berpindah. **Muat terbaru** kembali ke halaman pertama. UTC ditulis pada label filter; waktu yang dimasukkan tidak dikonversi dari zona lokal.

**Ekspor CSV** menelusuri semua cursor untuk filter yang sudah diterapkan, bukan hanya halaman yang terlihat. Nilai UTC asli disertakan, teks di-escape untuk CSV/spreadsheet, dan encoding UTF-8 memakai BOM. Maksimal **10.000 baris** per ekspor; jika lebih besar, persempit filter. Kesalahan, pembatalan, atau batas terlampaui tidak menghasilkan file parsial. Pagination kosong dengan `nextCursor` tetap dilanjutkan karena hasil bisa melewati record yang kedaluwarsa/lebih baru dari watermark.

Skenario **Normal/Warning/Critical** tetap simulasi lokal dan tidak melakukan ingest atau Telegram otomatis. Ruang `simulation` pada backend hanya dapat diisi sumber uji tepercaya yang memiliki scope simulation; gunakan ID perangkat demo tersendiri.

### 5. Indeks, retensi, dan ketahanan

`server/log-store.js` menjalankan satu skrip Lua atomik untuk pengecekan duplikat, nomor urut penerimaan, penyimpanan data, dan empat indeks: per sumber/hari, perangkat, status, serta perangkat+status. Hash deduplikasi menggunakan `deviceId + eventId` dalam namespace sumber. Jika respons HTTP hilang setelah penyimpanan, retry mengembalikan event yang sudah ada. Tidak ada antrean atau kredensial ingest pada browser.

Indeks waktu menggunakan Redis sorted set per hari UTC dengan score 0 dan member `epoch-milidetik:hash`, sehingga batas lexicographic memberikan urutan waktu dan cursor stabil saat timestamp sama. Pembacaan memakai indeks yang sesuai filter, maksimal **100 hasil**, maksimal **500 kandidat**, dan maksimal horizon retensi 90 hari per request. Tidak ada `KEYS`/scan seluruh database pada endpoint produksi. Semua akses Redis memakai REST HTTPS dengan timeout 5 detik tanpa retry tersembunyi.

Data/deduplikasi memiliki TTL hingga `waktu kejadian + retensi`; record tidak diperpanjang oleh retry. Indeks harian memiliki TTL hingga akhir hari + retensi; referensi kosong dapat bertahan kurang dari satu hari setelah datanya hilang, lalu ikut habis otomatis. Pembaca tidak menampilkan data di luar batas retensi. Kejadian yang sudah kedaluwarsa ditolak agar replay tidak menghidupkan log lama. Menaikkan retensi tidak mengembalikan data yang telah habis. Menurunkan retensi langsung mempersempit hasil baca dan event baru; TTL fisik data/indeks lama tetap mengikuti retensi saat penulisan hingga habis.

Pilih masa retensi dan frekuensi pengiriman sesuai kuota database. Konfigurasi default 120 request/menit dihitung **per sumber**, jadi satu broker yang melayani banyak ESP32 perlu batas yang sesuai atau sumber terpisah. Kegagalan database menghasilkan 503 tanpa membocorkan detail koneksi. Rate limiting dan deduplikasi bekerja lintas instance Vercel karena dilakukan di Redis.

### 6. Pemeriksaan sebelum produksi

Jalankan `npm test` untuk validasi, autentikasi, batas body, perilaku UI, cursor, dan kegagalan layanan. Uji integrasi Redis memakai database lokal disposable, bukan production:

```powershell
$env:LOG_TEST_REDIS_URL = 'redis://127.0.0.1:6379'
npm test
```

Test integrasi otomatis dilewati jika `LOG_TEST_REDIS_URL` tidak diisi. Test membuat namespace acak sendiri dan hanya membersihkan namespace itu; tidak menjalankan FLUSHDB/FLUSHALL. Untuk memeriksa proyek di Vercel:

1. Tekan **Start Logging** di header dan masukkan kunci operator, lalu kirim event valid dua kali; hanya satu log muncul, termasuk dari browser/perangkat lain. Tekan **Stop Logging** lalu kirim event baru; response harus `skipped: true` dan riwayat lama tetap utuh.
2. Coba tanpa token, perangkat di luar izin, payload terlalu besar, dan batas request rendah; pastikan 401/403/413/429.
3. Tutup dashboard, kirim melalui sumber broker/ESP32, lalu buka kembali riwayat; event tetap tercatat.
4. Replay data dengan ID/waktu asli; cek `occurredAt` tetap lama dan `receivedAt` adalah waktu pertama diterima server.
5. Periksa filter perangkat/status/waktu, cursor dengan timestamp sama, CSV beberapa halaman, ruang simulasi terpisah, dan tampilan layar kecil.
6. Nonaktifkan koneksi database pengujian; riwayat menampilkan gagal dan monitoring tetap berjalan. Pastikan metode tulis/hapus `/api/logs` mendapat 405.
7. Jalankan uji Telegram manual dan Simpan/Reset seperti sebelumnya. Jangan menaruh token produksi di payload, screenshot, atau log pengujian.

## Telegram

### Kirim pesan uji secara manual

1. Buat bot melalui BotFather, salin token, lalu buka percakapan bot dan kirim `/start`. Untuk grup/channel, tambahkan bot dan berikan izin mengirim pesan.
2. Buka **Pengaturan → Notifikasi Telegram**, lalu isi **Bot Token** dan **Chat ID**. Chat ID dapat berupa angka positif untuk chat pribadi, angka negatif untuk grup, atau `@username` grup/channel publik. Token dan Chat ID divalidasi sebelum ada permintaan ke Telegram.
3. Klik **Kirim pesan uji**. Tombol memakai isian form saat itu, termasuk perubahan yang belum disimpan. Tidak perlu ESP32, koneksi MQTT, **Simpan pengaturan**, atau mencentang **Aktifkan notifikasi dari dashboard**. Isian MQTT/proteksi tidak perlu valid untuk uji ini.
4. Browser mengirim tepat satu `fetch` **POST** ke Telegram Bot API `sendMessage`. Pesan diawali **[UJI] ThermoGuard-CPS**, menjelaskan bahwa ini pengujian manual dan bukan peringatan sensor, serta menyertakan waktu pengiriman menurut jam dan zona waktu browser.
5. Selama pengiriman, tombol dinonaktifkan dan status **Mengirim** ditampilkan. **Berhasil** hanya muncul setelah HTTP berhasil, respons `ok: true`, dan `message_id` berupa bilangan bulat positif yang valid. Tombol aktif kembali setelah selesai atau gagal.

Batas waktu permintaan, termasuk pembacaan respons, adalah **10 detik**. Uji manual **tidak melakukan retry otomatis**, tidak menyimpan kredensial ke localStorage/cloud, dan tidak mengubah pengaturan notifikasi otomatis. Kredensial dikirim langsung ke Telegram untuk permintaan ini. Tombol **Simpan pengaturan** tetap menjalankan penyimpanan dan sinkronisasi cloud yang sudah ada jika tersedia.

| Kesalahan | Tindakan |
|---|---|
| Bot Token kosong, format salah, atau ditolak (401/404) | Salin token lengkap dan terbaru dari BotFather. |
| Chat ID kosong, format salah, atau chat tidak ditemukan (400) | Periksa ID tujuan atau `@username`, gunakan ID grup terbaru, dan kirim `/start` ke bot. |
| Akses ditolak (403 atau izin mengirim tidak tersedia) | Buka blokir bot, tambahkan ke grup/channel, dan periksa izin mengirim. |
| Terlalu banyak permintaan (429) | Tunggu sesuai durasi dari Telegram jika ditampilkan, lalu coba secara manual. |
| Gangguan jaringan/CORS | Periksa koneksi atau pembatasan browser/jaringan. Periksa chat sebelum mencoba lagi. |
| Timeout 10 detik atau respons tidak valid | Pengiriman belum terkonfirmasi; pesan mungkin sudah diterima. Periksa chat sebelum mencoba lagi agar tidak mengirim pesan ganda. |
| Gangguan layanan Telegram (5xx) | Coba kembali nanti secara manual. |

Tombol skenario **Normal/Warning/Critical** tetap hanya mengubah simulasi dan **tidak otomatis mengirim Telegram**, termasuk ketika notifikasi otomatis aktif. Uji manual dijalankan hanya melalui tombol **Kirim pesan uji**.

### Notifikasi otomatis dari telemetri perangkat

1. Buat bot melalui BotFather, salin token, dan buka percakapan bot dengan `/start`.
2. Isi Bot Token dan Chat ID di Pengaturan, centang **Aktifkan notifikasi dari dashboard**, lalu klik **Simpan pengaturan**.
3. Dashboard memanggil HTTPS `sendMessage` ketika telemetri **segar** memasuki CRITICAL. Simulasi, replay, dan paket retained tidak mengirim pesan.
4. “Terkirim” hanya muncul setelah respons Telegram `ok: true` dengan `message_id`, atau ketika ESP32 secara eksplisit melaporkan `telegramSent: true`.
5. Khusus notifikasi otomatis, pengiriman gagal dicoba ulang paling cepat 30 detik, dengan batas umur antrean 5 menit. Hanya insiden terbaru yang ditahan dalam RAM. Pesan antarinsiden dibatasi 60 detik; deduplikasi memakai `alertId` (fallback `id`) dan catatan pengiriman di localStorage. Web Locks mengurangi pengiriman ganda antartab jika tersedia; untuk jaminan lintasbrowser/perangkat, gunakan pengirim tunggal ESP32/backend.
6. Token yang disimpan di localStorage tidak tersembunyi dari pengguna atau skrip halaman. Implementasi statis ini cocok untuk demo/lingkungan terkendali. Notifikasi mandiri saat tab tertutup harus ditangani ESP32 atau backend; jangan aktifkan dua pengirim untuk insiden yang sama. Jika kebijakan CORS/jaringan menghalangi Telegram, UI menunjukkan gagal, bukan terkirim.

## Desain dan pemeriksaan

- Mobile-first mulai 320px, dua kolom metrik, satu kolom panel; tablet dua kolom metrik; desktop empat kolom dan layout 8/4 dengan `max-w-7xl`.
- Canvas fluid dengan ResizeObserver, fallback resize listener, dan devicePixelRatio. Garis putus-putus mengikuti batas yang aktif pada setiap sampel.
- Target sentuh minimal 44×44 CSS px, font input 16px, safe-area notch, fokus keyboard, reduced-motion, hover hanya untuk perangkat yang mendukungnya.
- Palet putih/netral dengan aksen `#22C55E` dan `#FF8A1F`; tanpa ikon emoji, library chart, atau framework JavaScript.
- Uji alur: Normal → Warning → Critical; Simpan/Reset; broker offline/online; telemetri kedaluwarsa; replay tidak memicu pesan; resize dashboard dan pengaturan.
- Uji Telegram manual: matikan notifikasi otomatis dan kosongkan broker, ubah token/Chat ID tanpa menyimpan, lalu klik **Kirim pesan uji**. Periksa label/waktu pesan, cegah klik ganda saat mengirim, uji input tidak valid serta jaringan offline/timeout, dan pastikan pengaturan tersimpan tidak berubah. Verifikasi respons gagal dengan mock API tanpa mengirim pesan sungguhan atau membanjiri Telegram untuk memicu 429.

Referensi: [MQTT.js](https://github.com/mqttjs/MQTT.js), [Tailwind Play CDN](https://tailwindcss.com/docs/installation/play-cdn), [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage), [konfigurasi Vercel](https://vercel.com/docs/project-configuration). Tailwind Play CDN ditujukan untuk pengembangan/demonstrasi; CDN dipertahankan sesuai spesifikasi tanpa build step.
# SISTEMSIBERTUGAS2026
