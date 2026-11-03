# Docker

Deployment fork `9router-vfh`. Upstream `decolua/9router` tetap jadi acuan, tapi image
di build lokal dari `Dockerfile` di repo ini.

Angka di dokumen ini diukur dari image dan container yang jalan, bukan estimasi.

## Isi image

`9router-vfh:latest` = **1.28 GiB** (1.34 GB desimal).

| Layer | Ukuran |
|---|---|
| Base `node:22.23.4-alpine` (termasuk adduser node) | ~481 MB |
| `apk add su-exec ffmpeg` | 133 MB |
| `chown -R node:node /app` (layer duplikat) | 343 MB |
| `node_modules/next` | 219 MB |
| `.next/standalone` | 91.9 MB |
| `node_modules/sql.js` | 31.2 MB |
| `node_modules/@img` + `sharp` | 18.6 MB |
| lazy-runtime (`wreq-js`, `playwright-core`) | 23.8 MB |
| `.next/static` + `public` + `open-sse` | 9.3 MB + 4.4 MB + 4.4 MB |

Di dalam container: `/app` 330 MB, dan 291 MB di antaranya `node_modules`.

Dua layer masih bisa dipangkas tapi **belum** dilakukan di `Dockerfile`:

- `chown -R` di baris 92 menyalin ulang seluruh `/app` (343 MB). `COPY --chown` akan
  menghapusnya.
- `sharp` dan `@img` (18.6 MB) tidak pernah dimuat karena `images.unoptimized: true`.
- `sql.js` hanya butuh `dist/sql-wasm.{js,wasm}`, sisanya emscripten variant (31.2 MB
  menjadi ~0.7 MB).

## Build & jalankan

```bash
cp .env.example .env.docker      # lalu isi secret, jangan pakai placeholder
docker compose up -d --build
```

`.env` di repo ini berisi placeholder (`JWT_SECRET=change-me-...`). Compose membaca
`.env.docker`. Kalau `.env` yang terpakai, dashboard dan sesi berjalan dengan secret
placeholder, dan `API_KEY_SECRET` jatuh ke default kode.

Port bind ke loopback (`127.0.0.1:2222`) karena container menyimpan kredensial provider.
Untuk akses LAN, pasang reverse proxy di depan.

Cek status:

```bash
docker compose ps
curl -s http://127.0.0.1:2222/api/health     # {"ok":true}
docker logs -f 9router-vfh
```

## Env

`.env.docker` (gitignored) wajib diisi:

| Var | Catatan |
|---|---|
| `JWT_SECRET` | min 32 byte acak, dipakai cookie sesi dashboard |
| `INITIAL_PASSWORD` | password dashboard pertama |
| `API_KEY_SECRET` | HMAC pembentuk CRC key `/v1/*`; default kode dipakai bila kosong |
| `MACHINE_ID_SALT` | salt machine-id; default kode dipakai bila kosong |

Generate cepat:

```bash
node -e 'const c=require("crypto");console.log("JWT_SECRET="+c.randomBytes(32).toString("hex"));
console.log("API_KEY_SECRET="+c.randomBytes(24).toString("hex"));
console.log("MACHINE_ID_SALT="+c.randomBytes(16).toString("hex"));
console.log("INITIAL_PASSWORD="+c.randomBytes(12).toString("base64url"))'
```

`API_KEY_SECRET` mengubah CRC pada key baru. Key lama tetap valid karena
`validateApiKey` mencocokkan string key di tabel `apiKeys`, bukan menghitung ulang CRC.

## Data

Volume named `9router-vfh-data` → `/app/data`.

```bash
docker volume inspect 9router-vfh-data --format '{{.Mountpoint}}'
```

Isi setelah first run: `db/data.sqlite` (+ `-wal`/`-shm`), `db/backups/`, `machine-id`,
`model-catalog.json`, `model-catalog-raw.json`, `logs/mitm/`, `token-saver/`.
`auth/cli-secret` baru dibuat saat CLI token pertama dipakai.

Backup:

```bash
docker exec 9router-vfh sh -c 'tar -czf - -C /app/data db' > 9router-backup-$(date +%F).tar.gz
```

## Runtime

- **Non-root**: PID 1 jalan sebagai `node` (uid 1000). `entrypoint.sh` hanya
  memperbaiki ownership `/app/data` saat volume baru (root-owned) ter-mount.
- **DB driver**: `better-sqlite3`. `node:sqlite` baru dipakai di Node ≥24 karena addon
  native SIGSEGV saat load di sana.
- **Healthcheck**: `GET /api/health` tiap 30 s, `start-period` 40 s. Didefinisikan di
  `docker-compose.yml`; image tidak membawa `HEALTHCHECK`.
- **Limit**: memory 1 GB, reservasi 192 MB. Idle terukur ≈ 114 MB.
- **Log**: json-file rotasi 10 MB × 3.

## Operasi

```bash
docker compose logs -f            # log
docker compose restart            # restart
docker compose down               # stop (volume tetap)
docker compose down -v            # stop + hapus data  ⚠️
docker compose up -d --build      # rebuild setelah update kode
```

Update versi: naikkan `APP_VERSION` build-arg dan tag image di `docker-compose.yml`,
lalu `docker compose up -d --build`.

## Catatan MITM

MITM (`src/mitm/server.js`) di-spawn sebagai child process dan butuh bind port 443 di
dalam container. Tanpa `--cap-add=NET_ADMIN` itu tetap jalan untuk mode proxy biasa,
tapi intercept transparan butuh kapabilitas tambahan. Fitur ini opsional.

## Build context

`.dockerignore` memangkas context ke **132 kB** terukur (dari ~16.8 MB file tracked,
~2 GB termasuk `node_modules` dan `.gitnexus`). Yang dikeluarkan: `.git`, `.gitnexus`,
`tests`, `cli`, `docs`, `gitbook`, `storage`, `.claude`, `.agents`, `.opencode`, `.vmac`,
`node_modules`, `.next`, seluruh `*.md` kecuali `README.md`.

Kalau menambah folder besar baru di root repo, tambahkan ke `.dockerignore` juga.
