# Deployment guide

This guide describes a generic single-origin deployment. A TLS reverse proxy or managed HTTPS ingress serves the public hostname and forwards requests to the Python server. The browser calls only the Python API; MySQL remains private.

## Render Blueprint (included)

The repository's `render.yaml` creates a Render Python web service on the Starter plan, adds a persistent 1 GB upload disk at `/var/data`, sets `UPLOAD_DIR=/var/data/uploads`, configures the platform port binding, enables secure cookies, and disables localStorage fallback.

1. Push this repository to GitHub and select **New → Blueprint** in Render.
2. Connect `Prathibha-7/student-score-board` and select the `main` branch. Render reads `render.yaml`.
3. Create or select an external MySQL 8 database. Render does not create a MySQL database for this Blueprint. Allow the Render service to connect to it, apply `database.sql`, and provide its host, port, user, password, database name, and optional trusted TLS CA path as Blueprint environment values.
4. Provide the admin email/password and the initial `APP_BASE_URL` value shown for the new Render service (for example, `https://student-score-board.onrender.com`). The admin password must be unique and 12–128 characters.
5. Add SMTP credentials if password reset email is required. Confirm the values, then deploy the Blueprint.
6. Once Render assigns the final public URL, make sure `APP_BASE_URL` exactly matches it and trigger a redeploy. Open the public URL and verify `/api/health`.

The Render Starter web service and persistent disk are paid resources; the external MySQL provider may also charge. Do not deploy as a static site: the API and MySQL-backed session handling must run in the Python web service.

## 1. Prepare the database

1. Create the MySQL database by applying `database.sql`.
2. Create a dedicated application user. Do not use MySQL `root`. Grant only the required permissions on `student_management` (`SELECT`, `INSERT`, `UPDATE`, and `DELETE`), and require TLS when the database is remote.
3. Store the database CA certificate on the app host and set `DB_SSL_CA` to its path. The connector verifies the certificate and server identity when this variable is set.
4. Keep MySQL on a private network. Allow inbound database connections only from the application host.

## 2. Configure the application

Use the names in `.env.example` as a checklist for your platform's secret/environment-variable manager. The app does not parse `.env` files automatically. Never commit populated credentials or private keys.

Required production settings:

```text
HOST=127.0.0.1
PORT=5000
DB_HOST=<private MySQL hostname>
DB_PORT=3306
DB_USER=<least-privilege application user>
DB_PASSWORD=<managed secret>
DB_NAME=student_management
DB_SSL_CA=<path to trusted database CA>
ADMIN_EMAIL=<administrator email>
ADMIN_PASSWORD=<unique password, 12-128 characters>
APP_BASE_URL=https://<public hostname>
COOKIE_SECURE=true
ALLOW_LOCAL_FALLBACK=false
UPLOAD_DIR=<persistent private storage path>
```

Set up SMTP (`SMTP_HOST`, `SMTP_FROM`, and, when required, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_PORT`, and `SMTP_TLS`) to enable password recovery. Without SMTP and a public `APP_BASE_URL`, password-reset requests report that the feature is not configured.

Keep `HOST` bound to loopback when a reverse proxy runs on the same machine. Set `UPLOAD_DIR` to persistent storage outside the public/static document root. Restrict its filesystem permissions to the service account. Aadhaar files are sensitive personal information: apply your jurisdiction's privacy, retention, encryption-at-rest, and access-control requirements, and encrypt backups.

## 3. Install and run as a service

Use a dedicated operating-system account and isolated Python environment. From the project root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python backend/server.py
```

Configure the same environment variables in the process manager or secret store, not in the command history. Run the process under a supervisor (for example, systemd or the hosting platform's service manager) with automatic restart, bounded logs, and a startup health check. Do not run the service as root.

The supplied transport uses Python's `ThreadingHTTPServer` and is intended for this assessment-scale application. Do not expose its port directly to the public internet. Put it behind a maintained reverse proxy/managed ingress, enforce HTTPS, and apply request timeouts, connection limits, and rate limits to sign-in and password-recovery endpoints. For higher traffic or stricter production/compliance needs, replace the HTTP transport with a maintained production server/framework other than Flask before public launch.

## 4. Reverse proxy and network

- Route all paths, including `/api/*`, `/config.js`, static frontend files, and protected Aadhaar downloads, through the same public origin. The app intentionally uses same-origin cookies and API requests.
- Terminate TLS at the proxy and redirect HTTP to HTTPS. Preserve the app's `Set-Cookie` headers; `COOKIE_SECURE=true` marks the session cookie `Secure`.
- Allow requests slightly larger than 5 MB to accommodate multipart overhead, and configure a finite body/read timeout.
- Do not cache `/api/*`, `/config.js`, authenticated pages, or Aadhaar PDFs. Send `Cache-Control: no-store` for authenticated and sensitive responses at the proxy.
- Expose only the proxy's HTTPS port. Keep the app and MySQL ports private.
- Consider proxy-side rate limits for `/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`, and `/api/auth/reset-password`.

## 5. Health check and smoke test

`GET /api/health` returns `200 {"status":"ok"}` only when the MySQL schema is reachable and the upload directory exists and is writable. Configure the hosting platform to probe that path. A non-200 response should remove the instance from service and alert the operator.

After deployment, verify:

1. `GET /api/health` returns status 200 through the public HTTPS hostname.
2. The admin can sign in and a non-admin is denied access to admin APIs.
3. A student can register, then sign in and edit their profile; the email remains unchanged.
4. Re-registering an existing email displays `This email is already registered.`
5. An uploaded PDF is stored under a random server filename and is available only to its owner/admin.
6. Admin search, class/age filters, edits, and deletes work.
7. Password recovery delivers a single-use link that expires after 30 minutes.
8. With `ALLOW_LOCAL_FALLBACK=false`, an API outage displays an unavailable message and does not save credentials, profiles, or Aadhaar documents in localStorage.

## 6. Operations

- Back up MySQL and the private upload volume together, encrypt backups, restrict access, and periodically test restoration.
- Monitor application/proxy/database availability, disk capacity, failed authentication volume, and SMTP delivery errors. Request query strings are redacted from the Python access log to keep reset tokens out of logs.
- Rotate the provisioned admin password in MySQL using a reviewed password-hash update procedure; changing `ADMIN_PASSWORD` only provisions a missing admin and does not overwrite an existing account.
- Do not use the localStorage fallback for real student data. Production configuration disables it; browser-only fallback is an assessment/demo feature and is not an authentication boundary.
