# EIB Apps

One site hosting the download pages for EIB's Android apps — **CGAS**, **Privacy Guardian**, and **Vanguard** — plus a secure upload endpoint that replaces the live APK in place.

```
index.html            hub linking the three apps
cgas/  lock/  vanguard/   landing pages (download buttons -> /apks/*.apk)
admin/                password-gated upload UI (noindex)
apks/                 served APK files (git-ignored; written by the server)
server/               zero-dependency Node upload API
deploy/               nginx config, PM2 config, seed script
```

## How the upload path works

The site is static. APK files live in `apks/` on the server, served by nginx at
`/apks/`. A tiny Node process (`server/server.js`, **no dependencies**) handles
`/api/*` only:

| Method | Path                | Auth              | Purpose                          |
|--------|---------------------|-------------------|----------------------------------|
| GET    | `/api/health`       | none              | liveness check                   |
| GET    | `/api/list`         | `Bearer <secret>` | current file sizes / timestamps  |
| POST   | `/api/upload/:app`  | `Bearer <secret>` | replace an app's APK (raw body)  |

`:app` is one of `cgas`, `lock`, `lock-legacy`, `vanguard`.

On upload the server:
1. checks the shared secret (constant-time),
2. verifies the body starts with the ZIP/APK magic `50 4B 03 04`,
3. streams it to a temp file (300 MB cap),
4. **backs up** the current file to `apks/backups/<name>.<timestamp>`,
5. atomically renames the new file into place — so download links never change.

The **/admin** page is a drag-and-drop uploader that calls these endpoints with
an XHR progress bar. It sends the file as a raw `application/octet-stream` body,
so there is no multipart library to install.

## Deploy

On the host (layout assumed by `deploy/nginx-eibapks.conf`):

```bash
sudo mkdir -p /var/www/eibapks
sudo git clone <this-repo-url> /var/www/eibapks/site
sudo mkdir -p /var/www/eibapks/apks/backups

# 1. Seed the initial APKs (from the original per-app folders)
cd /var/www/eibapks/site
bash deploy/seed-apks.sh /path/to/original/eibapks
# ...or just drop cgas.apk / lock.apk / lock-legacy.apk / vanguard.apk into /var/www/eibapks/apks

# 2. Configure the upload server
cd server
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # make a secret
#   -> paste into UPLOAD_SECRET, set APK_DIR=/var/www/eibapks/apks

# 3. Run it (PM2)
cd /var/www/eibapks/site
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup

# 4. nginx
sudo cp deploy/nginx-eibapks.conf /etc/nginx/sites-available/eibapks
sudo ln -s /etc/nginx/sites-available/eibapks /etc/nginx/sites-enabled/eibapks
# edit server_name, then:
sudo nginx -t && sudo systemctl reload nginx

# 5. HTTPS (strongly recommended — the secret crosses the wire)
sudo certbot --nginx -d apps.example.com
```

Then open `https://apps.example.com/admin/`, paste the secret, and upload.

## Security notes

- **Always serve over HTTPS.** The upload secret is a bearer token; on plain HTTP
  it is exposed on every request.
- The secret lives only in `server/.env` (git-ignored) and, if you tick
  "remember", in the uploader's `localStorage`.
- `apks/backups/` is blocked at the nginx layer and never served.
- Rotate the secret by editing `server/.env` and `pm2 restart eibapks-upload`.

## Local test

```bash
cd server
UPLOAD_SECRET=test APK_DIR=../apks node server.js
# in another shell:
curl -s localhost:8090/api/health
curl -s -H "Authorization: Bearer test" localhost:8090/api/list
curl -s -X POST --data-binary @some.apk \
     -H "Authorization: Bearer test" localhost:8090/api/upload/cgas
```
