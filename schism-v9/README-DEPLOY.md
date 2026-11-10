# SCHISM v9 — Deploy (backend Kalshi live + leaderboard global)

Isi folder ini:
- `index.html` — web v9 (export dari artifact `schism`)
- `netlify/functions/kalshi.js` — proxy live Kalshi (bid/ask/mid)
- `netlify/functions/leaderboard.js` — leaderboard global Call the Close (Netlify Blobs)
- `netlify/functions/package.json` — dependensi Functions (@netlify/blobs)
- `netlify.toml` — publish "." + functions dir

PENTING: JANGAN deploy folder ini dengan drag-and-drop — Netlify tidak
menjalankan Functions dari drag-drop. Pakai salah satu cara di bawah.
Domain schism.pro tidak berubah; tetap nempel di site yang sama.

## Cara A — Git (disarankan)

1. GitHub: buat repo baru (mis. `schism`), upload SEMUA isi folder ini
   (index.html, folder netlify, netlify.toml). Bisa lewat tombol
   "uploading an existing file" di web GitHub, tanpa git di PC.
2. Netlify: buka site `tiny-gaufre-776f6e` → Site configuration →
   Build & deploy → Continuous deployment → Link repository → pilih repo.
3. Build settings saat linking:
   - Base directory: (kosong)
   - Build command: (kosong)
   - Publish directory: `.` (titik)
   - Functions directory: `netlify/functions`
4. Deploy. Setiap push ke repo nanti auto-deploy (termasuk Functions).

## Cara B — Netlify CLI (PC Windows)

1. Install Node.js LTS dari nodejs.org (kalau belum ada).
2. Di PowerShell, masuk ke folder ini, lalu:
   ```
   npm install -g netlify-cli
   npm install --prefix netlify/functions
   netlify login
   netlify link
   ```
   (pilih site `tiny-gaufre-776f6e` saat `netlify link` bertanya)
3. Deploy:
   ```
   netlify deploy --prod --dir=. --functions=netlify/functions
   ```

## Cek setelah deploy

1. Buka https://schism.pro/.netlify/functions/leaderboard
   Harusnya muncul JSON seperti: {"board":[],"totals":{"players":0,"calls":0}}
2. Buka https://schism.pro, refresh halaman.
   - Status pill harus jadi "Live · HH:MM WIB" (bukan "Snapshot").
   - Kolom Kalshi (bid/ask/mid) berubah dari angka snapshot.
   - Bagian Call the Close menampilkan board Global di bawah board lokal.
3. Kalau pill tetap "Snapshot" atau leaderboard 404: backend belum
   ikut ter-deploy — kabari qyu, jangan ubah DNS/domain apa pun.

## Kalau mau update web lagi

Minta qyu buatkan export baru (index.html), ganti file itu saja di repo
(Cara A: push lagi) atau deploy ulang (Cara B). Functions tidak perlu
disentuh kecuali qyu bilang begitu.
