import hashlib
import json
import math
import mimetypes
import os
import re
import secrets
import smtplib
import ssl
import traceback
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

import mysql.connector
from mysql.connector import Error, IntegrityError

from auth import hash_password, verify_password
from database import connect

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
UPLOADS = Path(os.getenv("UPLOAD_DIR", str(Path(__file__).resolve().parent / "uploads"))).resolve()
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 128 * 1024
SESSION_AGE = 8 * 60 * 60
QUALIFICATIONS = {"High School", "Diploma", "Bachelor's", "Master's", "Doctorate", "Other"}
GENDERS = {"Female", "Male", "Non-binary", "Prefer not to say"}
INTERESTS = {"Arts", "Coding", "Music", "Science", "Sports", "Volunteering"}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_json_object(body: bytes) -> dict[str, Any]:
    data = json.loads(body or b"{}")
    if not isinstance(data, dict):
        raise ValueError("Expected a JSON object.")
    return data


def parse_multipart(content_type: str, body: bytes) -> dict[str, Any]:
    message = BytesParser(policy=default).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii") + body
    )
    if not message.is_multipart():
        raise ValueError("Expected multipart form data.")
    result: dict[str, Any] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        value = {"filename": filename or "", "data": payload} if filename is not None else payload.decode("utf-8", "replace")
        if name == "interests":
            result.setdefault(name, []).append(value)
        else:
            result[name] = value
    return result


def as_text(form: dict[str, Any], key: str) -> str:
    value = form.get(key, "")
    return value.strip() if isinstance(value, str) else ""


def validate_student(form: dict[str, Any], *, require_aadhaar: bool) -> dict[str, Any]:
    name = as_text(form, "name")
    email = as_text(form, "email").lower()
    dob = as_text(form, "dob")
    gender = as_text(form, "gender")
    qualification = as_text(form, "qualification")
    class_name = as_text(form, "class_name")
    subject = as_text(form, "subject")
    password = as_text(form, "password")
    try:
        marks = float(as_text(form, "marks"))
        birth_date = date.fromisoformat(dob)
    except (ValueError, TypeError):
        raise ValueError("Enter a valid date of birth and numeric marks.") from None

    interests_value = form.get("interests", "[]")
    try:
        interests = json.loads(interests_value) if isinstance(interests_value, str) else interests_value
    except json.JSONDecodeError:
        raise ValueError("Select valid interests.") from None

    required_values = (name, email, dob, gender, qualification, class_name, subject)
    if not all(required_values) or not isinstance(interests, list) or not interests:
        raise ValueError("Please complete all required fields and choose at least one interest.")
    if len(name) > 120 or len(email) > 254 or len(class_name) > 80 or len(subject) > 120:
        raise ValueError("One or more fields exceed the allowed length.")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("Enter a valid email address.")
    if birth_date >= date.today():
        raise ValueError("Date of birth must be in the past.")
    if gender not in GENDERS or qualification not in QUALIFICATIONS:
        raise ValueError("Choose a valid gender and qualification.")
    if any(not isinstance(item, str) or item not in INTERESTS for item in interests):
        raise ValueError("Select valid interests.")
    if not math.isfinite(marks) or marks < 0 or marks > 100:
        raise ValueError("Marks must be between 0 and 100.")
    if password and (len(password) < 8 or len(password) > 128):
        raise ValueError("Password must be at least 8 characters.")
    if require_aadhaar and not password:
        raise ValueError("Password is required.")
    aadhaar = form.get("aadhaar")
    if require_aadhaar and (not isinstance(aadhaar, dict) or not aadhaar.get("data")):
        raise ValueError("Aadhaar PDF is required.")
    return {
        "name": name,
        "email": email,
        "dob": dob,
        "gender": gender,
        "qualification": qualification,
        "interests": json.dumps(interests),
        "class_name": class_name,
        "subject": subject,
        "marks": marks,
        "password": password,
    }


def validate_pdf(file_info: Any) -> tuple[bytes, str]:
    if not isinstance(file_info, dict) or not file_info.get("data"):
        raise ValueError("Select an Aadhaar PDF file.")
    original_name = Path(str(file_info.get("filename", ""))).name
    if Path(original_name).suffix.lower() != ".pdf":
        raise ValueError("Aadhaar document must be a PDF.")
    contents = file_info["data"]
    if len(contents) > MAX_UPLOAD_BYTES:
        raise ValueError("Aadhaar PDF must be 5 MB or smaller.")
    if not contents.startswith(b"%PDF-"):
        raise ValueError("The uploaded file is not a valid PDF.")
    return contents, f"{secrets.token_hex(24)}.pdf"


def user_record(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    result.pop("password_hash", None)
    result.pop("aadhaar_filename", None)
    interests = result.get("interests", "[]")
    if isinstance(interests, str):
        result["interests"] = json.loads(interests)
    if isinstance(result.get("dob"), (date, datetime)):
        result["dob"] = result["dob"].isoformat()
    if isinstance(result.get("created_at"), datetime):
        result["created_at"] = result["created_at"].isoformat()
    return result


class StudentManagementHandler(BaseHTTPRequestHandler):
    server_version = "StudentManagement/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        message = format_string % args
        match = re.search(r'"[A-Z]+\s+(\S+)', message)
        if match:
            request_target = match.group(1)
            parsed_target = urlparse(request_target)
            if parsed_target.query:
                message = message.replace(request_target, f"{parsed_target.path}?[redacted]", 1)
        print(f"{self.address_string()} - {message}")

    def _headers(self, status: int, content_type: str = "application/json; charset=utf-8", *, cookie: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)

    def _send(self, payload: Any, status: int = 200, *, cookie: str | None = None) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self._headers(status, cookie=cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, payload: bytes, content_type: str, *, filename: str | None = None) -> None:
        self._headers(200, content_type)
        if filename:
            self.send_header("Content-Disposition", f'inline; filename="{quote(filename)}"')
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self) -> bytes:
        size = int(self.headers.get("Content-Length", "0"))
        if size > MAX_REQUEST_BYTES:
            raise OverflowError("Request body exceeds the upload size limit.")
        return self.rfile.read(size)

    def _session_token(self) -> str | None:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get("sid")
        return morsel.value if morsel else None

    def _session(self) -> dict[str, Any] | None:
        token = self._session_token()
        if not token:
            return None
        connection = connect()
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute(
                """SELECT s.user_id, s.csrf_token, s.expires_at, u.role
                   FROM sessions s LEFT JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = %s AND s.expires_at > UTC_TIMESTAMP()""",
                (digest(token),),
            )
            return cursor.fetchone()
        finally:
            cursor.close()
            connection.close()

    def _new_session(self, user_id: int | None, role: str | None) -> tuple[str, str]:
        token, csrf_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        connection = connect()
        cursor = connection.cursor()
        try:
            cursor.execute("DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()")
            cursor.execute(
                "INSERT INTO sessions (token_hash, csrf_token, user_id, role, expires_at) VALUES (%s, %s, %s, %s, %s)",
                (digest(token), csrf_token, user_id, role, datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=SESSION_AGE)),
            )
            connection.commit()
        except Error:
            connection.rollback()
            raise
        finally:
            cursor.close()
            connection.close()
        return token, csrf_token

    def _cookie(self, token: str, *, clear: bool = False) -> str:
        secure = "; Secure" if os.getenv("COOKIE_SECURE", "false").lower() == "true" else ""
        age = 0 if clear else SESSION_AGE
        value = "" if clear else token
        return f"sid={value}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax{secure}"

    def _require(self, role: str | None = None) -> dict[str, Any] | None:
        current = self._session()
        if not current or not current.get("user_id"):
            self._send({"error": "Authentication required."}, 401)
            return None
        if role and current.get("role") != role:
            self._send({"error": "You do not have permission to access this resource."}, 403)
            return None
        return current

    def _csrf(self, current: dict[str, Any] | None) -> bool:
        token = self.headers.get("X-CSRF-Token", "")
        if not current or not secrets.compare_digest(token, current["csrf_token"]):
            self._send({"error": "Invalid or missing CSRF token."}, 400)
            return False
        return True

    def _db_user(self, user_id: int) -> dict[str, Any] | None:
        connection = connect()
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute(
                """SELECT id, name, email, role, dob, gender, qualification, interests,
                          class_name, subject, marks, aadhaar_filename, created_at
                   FROM users WHERE id = %s""",
                (user_id,),
            )
            return cursor.fetchone()
        finally:
            cursor.close()
            connection.close()

    def _write_registration(self, form: dict[str, Any]) -> None:
        email = as_text(form, "email").lower()
        if email:
            connection = connect()
            cursor = connection.cursor()
            try:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                if cursor.fetchone():
                    raise DuplicateEmail()
            finally:
                cursor.close()
                connection.close()
        student = validate_student(form, require_aadhaar=True)
        pdf_data, filename = validate_pdf(form.get("aadhaar"))
        UPLOADS.mkdir(parents=True, exist_ok=True)
        connection = connect()
        cursor = connection.cursor()
        try:
            (UPLOADS / filename).write_bytes(pdf_data)
            cursor.execute(
                """INSERT INTO users
                   (name, email, password_hash, role, dob, gender, qualification, interests,
                    class_name, subject, marks, aadhaar_filename)
                   VALUES (%s, %s, %s, 'student', %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    student["name"], student["email"], hash_password(student["password"]),
                    student["dob"], student["gender"], student["qualification"], student["interests"],
                    student["class_name"], student["subject"], student["marks"], filename,
                ),
            )
            connection.commit()
        except IntegrityError as error:
            connection.rollback()
            (UPLOADS / filename).unlink(missing_ok=True)
            if error.errno == 1062:
                raise DuplicateEmail() from None
            raise
        except Exception:
            connection.rollback()
            (UPLOADS / filename).unlink(missing_ok=True)
            raise
        finally:
            cursor.close()
            connection.close()

    def _update_student(self, user_id: int, form: dict[str, Any], *, allow_name: bool) -> None:
        old_user = self._db_user(user_id)
        if not old_user or old_user["role"] != "student":
            raise LookupError("Student not found.")
        if not allow_name:
            form["name"] = old_user["name"]
        form["email"] = old_user["email"]
        student = validate_student(form, require_aadhaar=False)
        new_filename: str | None = None
        new_pdf_data: bytes | None = None
        aadhaar = form.get("aadhaar")
        if isinstance(aadhaar, dict) and aadhaar.get("data"):
            new_pdf_data, new_filename = validate_pdf(aadhaar)
            UPLOADS.mkdir(parents=True, exist_ok=True)
        connection = connect()
        cursor = connection.cursor()
        try:
            if new_filename and new_pdf_data:
                (UPLOADS / new_filename).write_bytes(new_pdf_data)
            fields = (
                student["dob"], student["gender"], student["qualification"], student["interests"],
                student["class_name"], student["subject"], student["marks"],
            )
            if allow_name and new_filename:
                cursor.execute(
                    """UPDATE users SET name=%s, dob=%s, gender=%s, qualification=%s, interests=%s,
                       class_name=%s, subject=%s, marks=%s, aadhaar_filename=%s WHERE id=%s""",
                    (student["name"], *fields, new_filename, user_id),
                )
            elif allow_name:
                cursor.execute(
                    """UPDATE users SET name=%s, dob=%s, gender=%s, qualification=%s, interests=%s,
                       class_name=%s, subject=%s, marks=%s WHERE id=%s""",
                    (student["name"], *fields, user_id),
                )
            elif new_filename:
                cursor.execute(
                    """UPDATE users SET dob=%s, gender=%s, qualification=%s, interests=%s,
                       class_name=%s, subject=%s, marks=%s, aadhaar_filename=%s WHERE id=%s""",
                    (*fields, new_filename, user_id),
                )
            else:
                cursor.execute(
                    """UPDATE users SET dob=%s, gender=%s, qualification=%s, interests=%s,
                       class_name=%s, subject=%s, marks=%s WHERE id=%s""",
                    (*fields, user_id),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            if new_filename:
                (UPLOADS / new_filename).unlink(missing_ok=True)
            raise
        finally:
            cursor.close()
            connection.close()
        if new_filename and old_user["aadhaar_filename"]:
            (UPLOADS / Path(old_user["aadhaar_filename"]).name).unlink(missing_ok=True)

    def _forgot_password(self, data: dict[str, Any]) -> None:
        smtp_host = os.getenv("SMTP_HOST")
        smtp_from = os.getenv("SMTP_FROM")
        base_url = os.getenv("APP_BASE_URL", "").rstrip("/")
        if not smtp_host or not smtp_from or not base_url:
            raise RuntimeError("Password reset email requires SMTP_HOST, SMTP_FROM, and APP_BASE_URL configuration.")
        parsed_base_url = urlparse(base_url)
        if (parsed_base_url.scheme not in {"http", "https"} or not parsed_base_url.netloc or
                parsed_base_url.username or parsed_base_url.password or parsed_base_url.query or parsed_base_url.fragment):
            raise RuntimeError("APP_BASE_URL must be an absolute HTTP or HTTPS URL without credentials.")
        email = str(data.get("email", "")).strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Enter a valid email address.")
        connection = connect()
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
            user = cursor.fetchone()
            if not user:
                return
            raw_token = secrets.token_urlsafe(32)
            cursor.execute(
                "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (%s, %s, %s)",
                (user["id"], digest(raw_token), datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=30)),
            )
            connection.commit()
        except Error:
            connection.rollback()
            raise
        finally:
            cursor.close()
            connection.close()

        reset_url = f"{base_url}/forgot-password.html?token={quote(raw_token)}"
        message = EmailMessage()
        message["Subject"] = "Reset your student-management password"
        message["From"] = smtp_from
        message["To"] = email
        message.set_content(f"Use this link within 30 minutes to set a new password:\n\n{reset_url}\n")
        port = int(os.getenv("SMTP_PORT", "587"))
        if os.getenv("SMTP_TLS", "true").lower() == "true":
            with smtplib.SMTP(smtp_host, port, timeout=15) as client:
                client.starttls(context=ssl.create_default_context())
                if os.getenv("SMTP_USER"):
                    client.login(os.environ["SMTP_USER"], os.getenv("SMTP_PASSWORD", ""))
                client.send_message(message)
        else:
            with smtplib.SMTP(smtp_host, port, timeout=15) as client:
                if os.getenv("SMTP_USER"):
                    client.login(os.environ["SMTP_USER"], os.getenv("SMTP_PASSWORD", ""))
                client.send_message(message)

    def do_GET(self) -> None:
        try:
            path = unquote(urlparse(self.path).path)
            if path == "/":
                path = "/login.html"
            if path == "/config.js":
                enabled = os.getenv("ALLOW_LOCAL_FALLBACK", "true").lower() == "true"
                payload = f"window.STUDENT_APP_CONFIG = {{allowLocalFallback: {str(enabled).lower()}}};".encode()
                self._send_bytes(payload, "application/javascript; charset=utf-8")
                return
            if path == "/api/health":
                connection = connect()
                cursor = connection.cursor()
                try:
                    cursor.execute("SELECT 1 FROM users LIMIT 0")
                finally:
                    cursor.close()
                    connection.close()
                if not UPLOADS.is_dir() or not os.access(UPLOADS, os.W_OK):
                    raise RuntimeError("The configured Aadhaar upload directory is not writable.")
                self._send({"status": "ok"})
                return
            if path == "/api/auth/csrf":
                current = self._session()
                if current:
                    self._send({"csrfToken": current["csrf_token"]})
                else:
                    token, csrf_token = self._new_session(None, None)
                    self._send({"csrfToken": csrf_token}, cookie=self._cookie(token))
                return
            if path == "/api/auth/session":
                current = self._session()
                if current and current.get("user_id"):
                    user = self._db_user(int(current["user_id"]))
                    self._send({"user": user_record(user) if user else None, "csrfToken": current["csrf_token"]})
                else:
                    self._send({"user": None, "csrfToken": current["csrf_token"] if current else None})
                return
            if path == "/api/students/me":
                current = self._require()
                if not current:
                    return
                user = self._db_user(int(current["user_id"]))
                if not user:
                    self._send({"error": "Student profile not found."}, 404)
                    return
                user["has_aadhaar"] = bool(user.get("aadhaar_filename"))
                self._send({"student": user_record(user) | {"has_aadhaar": user["has_aadhaar"]}})
                return
            if path == "/api/students":
                current = self._require("admin")
                if not current:
                    return
                connection = connect()
                cursor = connection.cursor(dictionary=True)
                try:
                    cursor.execute(
                        """SELECT id, name, email, role, dob, gender, qualification, interests,
                                  class_name, subject, marks, aadhaar_filename, created_at
                           FROM users WHERE role='student' ORDER BY name, id"""
                    )
                    students = [user_record(row) | {"has_aadhaar": bool(row.get("aadhaar_filename"))} for row in cursor.fetchall()]
                finally:
                    cursor.close()
                    connection.close()
                self._send({"students": students})
                return
            if path.startswith("/api/students/") and path.endswith("/aadhaar"):
                current = self._require()
                if not current:
                    return
                parts = path.strip("/").split("/")
                own_file = len(parts) == 4 and parts[2] == "me"
                if own_file:
                    if current.get("role") != "student":
                        self._send({"error": "Student profile not found."}, 404)
                        return
                    user_id = int(current["user_id"])
                elif len(parts) == 4 and parts[2].isdigit() and current.get("role") == "admin":
                    user_id = int(parts[2])
                else:
                    self._send({"error": "You do not have permission to access this resource."}, 403)
                    return
                user = self._db_user(user_id)
                if not user or not user.get("aadhaar_filename"):
                    self._send({"error": "Aadhaar document not found."}, 404)
                    return
                safe_name = Path(user["aadhaar_filename"]).name
                pdf = (UPLOADS / safe_name).resolve()
                if not pdf.is_relative_to(UPLOADS) or not pdf.is_file():
                    self._send({"error": "Aadhaar document not found."}, 404)
                    return
                self._send_bytes(pdf.read_bytes(), "application/pdf", filename="aadhaar.pdf")
                return
            if path.startswith("/api/"):
                self._send({"error": "Not found."}, 404)
                return
            target = (FRONTEND / path.lstrip("/")).resolve()
            if not target.is_relative_to(FRONTEND) or not target.is_file():
                self._send({"error": "Not found."}, 404)
                return
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self._send_bytes(target.read_bytes(), content_type)
        except (ValueError, OverflowError) as error:
            self._send({"error": str(error)}, 400)
        except Exception as error:
            self._server_error(error)

    def do_POST(self) -> None:
        try:
            path = urlparse(self.path).path
            body = self._body()
            current = self._session()
            content_type = self.headers.get("Content-Type", "")
            if path == "/api/auth/register":
                if not self._csrf(current):
                    return
                form = parse_multipart(content_type, body)
                self._write_registration(form)
                self._send({"message": "Registration successful. You can now log in."}, 201)
                return
            if path == "/api/auth/login":
                if not self._csrf(current):
                    return
                data = parse_json_object(body)
                email = str(data.get("email", "")).strip().lower()
                password = str(data.get("password", ""))
                if not email or not password:
                    self._send({"error": "Email and password are required."}, 400)
                    return
                if len(password) > 128:
                    self._send({"error": "Invalid email or password."}, 401)
                    return
                connection = connect()
                cursor = connection.cursor(dictionary=True)
                try:
                    cursor.execute("SELECT id, name, email, password_hash, role FROM users WHERE email=%s", (email,))
                    user = cursor.fetchone()
                finally:
                    cursor.close()
                    connection.close()
                if not user or not verify_password(user["password_hash"], password):
                    self._send({"error": "Invalid email or password."}, 401)
                    return
                token, csrf_token = self._new_session(int(user["id"]), user["role"])
                safe_user = {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}
                self._send({"user": safe_user, "csrfToken": csrf_token}, cookie=self._cookie(token))
                return
            if path == "/api/auth/logout":
                if not self._require() or not self._csrf(current):
                    return
                connection = connect()
                cursor = connection.cursor()
                try:
                    cursor.execute("DELETE FROM sessions WHERE token_hash=%s", (digest(self._session_token() or ""),))
                    connection.commit()
                finally:
                    cursor.close()
                    connection.close()
                self._send({"message": "Logged out."}, cookie=self._cookie("", clear=True))
                return
            if path == "/api/auth/forgot-password":
                if not self._csrf(current):
                    return
                self._forgot_password(parse_json_object(body))
                self._send({"message": "If that account exists, a password reset link has been sent."})
                return
            if path == "/api/auth/reset-password":
                if not self._csrf(current):
                    return
                data = parse_json_object(body)
                token = str(data.get("token", ""))
                password = str(data.get("password", ""))
                if not 8 <= len(password) <= 128 or not token:
                    self._send({"error": "A valid reset link and a password of 8–128 characters are required."}, 400)
                    return
                connection = connect()
                cursor = connection.cursor()
                try:
                    cursor.execute("SELECT user_id FROM password_resets WHERE token_hash=%s AND expires_at > UTC_TIMESTAMP()", (digest(token),))
                    reset = cursor.fetchone()
                    if not reset:
                        self._send({"error": "This password reset link is invalid or expired."}, 400)
                        return
                    user_id = reset[0]
                    cursor.execute("UPDATE users SET password_hash=%s WHERE id=%s", (hash_password(password), user_id))
                    cursor.execute("DELETE FROM password_resets WHERE user_id=%s", (user_id,))
                    cursor.execute("DELETE FROM sessions WHERE user_id=%s", (user_id,))
                    connection.commit()
                except Error:
                    connection.rollback()
                    raise
                finally:
                    cursor.close()
                    connection.close()
                self._send({"message": "Password reset. You can now log in."}, cookie=self._cookie("", clear=True))
                return
            self._send({"error": "Not found."}, 404)
        except DuplicateEmail:
            self._send({"error": "This email is already registered."}, 409)
        except (ValueError, OverflowError, json.JSONDecodeError) as error:
            self._send({"error": str(error)}, 400)
        except Exception as error:
            self._server_error(error)

    def do_PATCH(self) -> None:
        try:
            path = urlparse(self.path).path
            current = self._require()
            if not current or not self._csrf(current):
                return
            form = parse_multipart(self.headers.get("Content-Type", ""), self._body())
            if path == "/api/students/me":
                if current.get("role") != "student":
                    self._send({"error": "Student profile not found."}, 404)
                    return
                self._update_student(int(current["user_id"]), form, allow_name=True)
                self._send({"message": "Profile updated."})
                return
            match = re.fullmatch(r"/api/students/(\d+)", path)
            if match and current.get("role") == "admin":
                student_id = int(match.group(1))
                form["password"] = ""
                self._update_student(student_id, form, allow_name=False)
                self._send({"message": "Student updated."})
                return
            self._send({"error": "You do not have permission to access this resource."}, 403)
        except LookupError as error:
            self._send({"error": str(error)}, 404)
        except (ValueError, OverflowError) as error:
            self._send({"error": str(error)}, 400)
        except Exception as error:
            self._server_error(error)

    def do_DELETE(self) -> None:
        try:
            current = self._require("admin")
            if not current or not self._csrf(current):
                return
            match = re.fullmatch(r"/api/students/(\d+)", urlparse(self.path).path)
            if not match:
                self._send({"error": "Not found."}, 404)
                return
            student_id = int(match.group(1))
            connection = connect()
            cursor = connection.cursor(dictionary=True)
            try:
                cursor.execute("SELECT aadhaar_filename FROM users WHERE id=%s AND role='student'", (student_id,))
                student = cursor.fetchone()
                if not student:
                    self._send({"error": "Student not found."}, 404)
                    return
                cursor.execute("DELETE FROM users WHERE id=%s AND role='student'", (student_id,))
                connection.commit()
            except Error:
                connection.rollback()
                raise
            finally:
                cursor.close()
                connection.close()
            if student["aadhaar_filename"]:
                (UPLOADS / Path(student["aadhaar_filename"]).name).unlink(missing_ok=True)
            self._send({"message": "Student deleted."})
        except Exception as error:
            self._server_error(error)

    def _server_error(self, error: Exception) -> None:
        traceback.print_exc()
        if isinstance(error, (Error, RuntimeError, OSError, smtplib.SMTPException)):
            self._send({"error": str(error) if isinstance(error, RuntimeError) else "The server could not complete this request. Check its database or email configuration."}, 503)
        else:
            self._send({"error": "The request could not be completed."}, 500)


class DuplicateEmail(Exception):
    pass


def provision_admin() -> None:
    email = os.getenv("ADMIN_EMAIL", "").strip().lower()
    password = os.getenv("ADMIN_PASSWORD", "")
    if not email and not password:
        return
    if not email or not 12 <= len(password) <= 128:
        raise RuntimeError("Set both ADMIN_EMAIL and an ADMIN_PASSWORD between 12 and 128 characters to provision an admin.")
    connection = connect()
    cursor = connection.cursor()
    try:
        cursor.execute("SELECT id, role FROM users WHERE email=%s", (email,))
        existing = cursor.fetchone()
        if existing and existing[1] != "admin":
            raise RuntimeError("ADMIN_EMAIL is already registered to a non-admin user; choose a different admin email.")
        if not existing:
            cursor.execute(
                """INSERT INTO users (name,email,password_hash,role,dob,gender,qualification,
                   interests,class_name,subject,marks) VALUES (%s,%s,%s,'admin','1970-01-01',
                   'Prefer not to say','Other','[]','Administration','Administration',0)""",
                ("Administrator", email, hash_password(password)),
            )
            connection.commit()
    except Error:
        connection.rollback()
        raise
    finally:
        cursor.close()
        connection.close()


def run_server() -> None:
    UPLOADS.mkdir(parents=True, exist_ok=True)
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    server = ThreadingHTTPServer((host, port), StudentManagementHandler)
    print(f"Student management server running at http://{host}:{port}")
    print("Admin provisioning is enabled only when ADMIN_EMAIL and ADMIN_PASSWORD are configured.")
    try:
        provision_admin()
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()
