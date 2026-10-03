# ThermoGuard-CPS

Dashboard statis berbahasa Indonesia untuk ESP32, DHT22, MQ-2, servo ventilasi, buzzer, dan tiga LED. HTML + Tailwind CDN + JavaScript vanilla; tanpa framework, npm, atau build step.

## Struktur

```text
thermoguard-cps/
  index.html
  settings.html
  assets/
    css/custom.css
    js/app.js
    js/mqtt-client.js
    js/settings.js
    js/mock-data.js
  vercel.json
  README.md
```

## Menjalankan

1. Ekstrak folder, lalu buka `index.html` di browser modern.
2. Simulasi otomatis aktif. Coba tombol Normal, Warning, dan Critical.
3. Buka ikon gear, isi koneksi MQTT, lalu klik **Simpan pengaturan** dan kembali ke **Monitoring**.
4. MQTT.js, Tailwind, dan Inter diunduh melalui CDN sehingga pemuatan pertama memerlukan internet. CSS lokal mempertahankan layout dasar jika CDN gagal. Ini bukan aplikasi PWA untuk pemuatan offline penuh.
5. Browser dapat membatasi `localStorage` per berkas pada `file://`. Jika pengaturan tidak terbawa antarahalaman, gunakan HTTP lokal: jalankan `python -m http.server 8000` dari folder proyek, lalu buka `http://localhost:8000`. Vercel memakai origin yang sama untuk kedua halaman.

## Deploy ke Vercel

1. Masukkan seluruh isi folder ini ke root repositori GitHub/GitLab/Bitbucket.
2. Di Vercel pilih **Add New → Project**, lalu impor repositori.
3. Pilih **Framework Preset: Other**. Root Directory adalah folder yang berisi `index.html`.
4. Kosongkan Build Command dan Install Command; Output Directory gunakan `.` (root proyek).
5. Klik **Deploy**. `vercel.json` mengaktifkan `cleanUrls: true`: `settings.html` tersedia sebagai `/settings`; tautan `.html` tetap diarahkan oleh Vercel. Tidak ada rewrite SPA.
6. Isi pengaturan pada domain Vercel. Gunakan **WSS**, karena halaman HTTPS menolak WebSocket WS yang tidak aman. Port harus port WebSocket broker, bukan port MQTT TCP 1883/8883.

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
#   S I S T E M S I B E R T U G A S 2 0 2 6  
 
