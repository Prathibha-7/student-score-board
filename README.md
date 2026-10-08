# Student Management Portal

A small student-registration and administration portal. The normal deployment uses one Python standard-library HTTP server (no Flask), one MySQL database, and the HTML/CSS/JavaScript frontend. Browser JavaScript sends requests to the Python API; it never connects to MySQL directly.

## Features

- Student registration captures name, email, password, date of birth, gender, qualification, interests, class, subject, marks, and an Aadhaar PDF.
- Required fields and PDF type, PDF signature, and a 5 MB upload limit are checked. Aadhaar files are stored under random server-generated names.
- Duplicate emails are rejected with the exact message `This email is already registered.`
- One sign-in form routes students and administrators to their separate dashboards. Server-side sessions, role checks, and CSRF tokens protect the API.
- Students can view their submitted details and update their profile (email is immutable), including replacing their Aadhaar PDF.
- Administrators can search names, filter by class and age range, open Aadhaar PDFs, edit student details (name and email are immutable), and delete student records.
- Password recovery uses one-time, 30-minute email links when SMTP is configured.
- If the API cannot be reached, the frontend automatically switches to a localStorage demonstration mode with registration, duplicate detection, login, role-aware pages, profile editing, file handling, and administrator CRUD.
- The registration name field is prefilled with “Prathibha” as a convenient editable example.

## MySQL and server setup

1. Install Python 3.10+ and MySQL 8.0+.
2. From a MySQL client, apply the schema:

   ```sql
   SOURCE C:/path/to/student-management/database.sql;
   ```

3. In PowerShell, set database connection details and a strong unique admin password (12–128 characters). The admin is created at startup if its email does not already exist:

   ```powershell
   $env:DB_HOST = "127.0.0.1"
   $env:DB_PORT = "3306"
   $env:DB_USER = "student_app"
   $env:DB_PASSWORD = "your-database-password"
   $env:DB_NAME = "student_management"
   $env:ADMIN_EMAIL = "admin@example.com"
   $env:ADMIN_PASSWORD = "use-a-unique-password-at-least-12-chars"
   $env:APP_BASE_URL = "http://127.0.0.1:5000"
   ```

4. Install dependencies and launch the application from the project root:

   ```powershell
   C:\Path\To\Python\python.exe -m pip install -r requirements.txt
   C:\Path\To\Python\python.exe backend\server.py
   ```

5. Visit [http://127.0.0.1:5000](http://127.0.0.1:5000). The upload directory is `backend/uploads/`. Set `HOST=0.0.0.0` only when intentionally making the server reachable on the network. For HTTPS deployments, set `COOKIE_SECURE=true` behind a correctly configured TLS proxy.

The database account needs read/write privileges on `student_management`. `database.sql` defines users, sessions, and password reset tokens. Back up the database and `backend/uploads/` together.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for generic production setup, reverse-proxy guidance, health checks, and operations. Production should set `ALLOW_LOCAL_FALLBACK=false`, `COOKIE_SECURE=true`, and use a same-origin HTTPS reverse proxy. The app reads environment variables from its process; `.env.example` is a reference template and is not loaded automatically.

For a Render deployment, use the included [`render.yaml`](./render.yaml) Blueprint. It starts the Python app with a persistent 1 GB Aadhaar upload disk and explicitly disables local-browser fallback. Provide an external MySQL service and the prompted database/admin settings in the Render Blueprint setup; Render does not provision MySQL from this blueprint. The Starter service and persistent disk are paid Render resources.

For a Vercel frontend demo, import this GitHub repository as a Vercel project. [`vercel.json`](./vercel.json) publishes the `frontend/` directory as a static site; it uses browser-local demo storage while no API backend is connected. The live MySQL-backed application still requires the Python service and MySQL deployment described above.

### Password reset email

Set `SMTP_HOST`, `SMTP_FROM`, and `APP_BASE_URL` (the public absolute application URL). Optional settings are `SMTP_PORT` (defaults to 587), `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_TLS` (defaults to `true`). Without SMTP configuration, the API reports that password recovery email is unavailable rather than claiming a reset was sent. Reset links are single-use and expire after 30 minutes.

## Browser-only demonstration mode

To run without MySQL or the Python API, serve the `frontend` directory with any static HTTP server, for example:

```powershell
C:\Path\To\Python\python.exe -m http.server 8000 --directory frontend
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). When the API is unavailable, the app automatically uses localStorage and displays a warning. It creates a browser-local administrator (`admin@local.test`) with a random password shown on the sign-in page. This mode is only for assessment/demo use: localStorage can be inspected or changed by the browser user, the demo admin is not a secure provisioned account, and Aadhaar PDFs must not contain real personal information. Clear the browser's site data to reset the demonstration; remove the `student-management-mode` localStorage key if you want the app to retry its Python API.

## Data and access notes

- Public registration can only create student-role accounts. Admins are provisioned from server environment variables.
- Session identifiers are random and only their SHA-256 hashes are stored in MySQL. Passwords use Python's built-in scrypt password hashing.
- Aadhaar PDFs are not served as static files; the API permits downloads only for the owning student or an authenticated administrator.
- The age filter is calculated from the submitted date of birth and updates in the browser as filters change.