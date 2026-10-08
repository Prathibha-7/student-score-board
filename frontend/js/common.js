"use strict";

const App = (() => {
  const USERS_KEY = "student-management-users";
  const SESSION_KEY = "student-management-session";
  const ADMIN_PASS_KEY = "student-management-local-admin-password";
  const allowLocalFallback = window.STUDENT_APP_CONFIG?.allowLocalFallback !== false;
  let mode = localStorage.getItem("student-management-mode") || "";
  let csrfToken = "";
  let sessionUser = null;
  let serviceUnavailable = false;

  const newToken = (size = 18) => {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  async function passwordHash(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function getUsers() {
    try {
      return JSON.parse(localStorage.getItem(USERS_KEY) || "[]");
    } catch {
      throw new Error("Local browser data could not be read. Clear this app's stored data and retry.");
    }
  }

  function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  async function seedLocalAdmin() {
    const users = getUsers();
    if (users.some((user) => user.role === "admin")) return;
    const password = newToken(12);
    users.push({
      id: 1,
      name: "Local Demo Administrator",
      email: "admin@local.test",
      role: "admin",
      passwordHash: await passwordHash(password),
      class_name: "Administration",
      dob: "1990-01-01",
      gender: "Prefer not to say",
      qualification: "Other",
      interests: [],
      subject: "Administration",
      marks: 0,
      aadhaarDataUrl: "",
      has_aadhaar: false,
      created_at: new Date().toISOString()
    });
    saveUsers(users);
    localStorage.setItem(ADMIN_PASS_KEY, password);
  }

  function formFields(formData) {
    return {
      name: String(formData.get("name") || "").trim(),
      email: String(formData.get("email") || "").trim().toLowerCase(),
      password: String(formData.get("password") || ""),
      dob: String(formData.get("dob") || ""),
      gender: String(formData.get("gender") || ""),
      qualification: String(formData.get("qualification") || ""),
      interests: formData.getAll("interests"),
      class_name: String(formData.get("class_name") || "").trim(),
      subject: String(formData.get("subject") || "").trim(),
      marks: Number(formData.get("marks")),
      aadhaar: formData.get("aadhaar")
    };
  }

  function checkStudentFields(student, registration) {
    if (!student.name || !student.email || !student.dob || !student.gender ||
        !student.qualification || !student.interests.length || !student.class_name ||
        !student.subject || !Number.isFinite(student.marks)) {
      throw new Error("Please complete all required fields.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(student.email)) {
      throw new Error("Enter a valid email address.");
    }
    if (student.name.length > 120 || student.email.length > 254 ||
        student.class_name.length > 80 || student.subject.length > 120) {
      throw new Error("One or more fields exceed the allowed length.");
    }
    if (student.marks < 0 || student.marks > 100) {
      throw new Error("Marks must be between 0 and 100.");
    }
    if (registration && student.password.length < 8) {
      throw new Error("Password must be between 8 and 128 characters.");
    }
    if (registration && student.password.length > 128) {
      throw new Error("Password must be between 8 and 128 characters.");
    }
    if (student.dob >= new Date().toISOString().slice(0, 10)) {
      throw new Error("Date of birth must be in the past.");
    }
  }

  async function readPdf(file, required) {
    if (!file || !file.name) {
      if (required) throw new Error("Select an Aadhaar PDF file.");
      return null;
    }
    if (!file.name.toLowerCase().endsWith(".pdf") || file.size > 5 * 1024 * 1024) {
      throw new Error("Aadhaar document must be a PDF no larger than 5 MB.");
    }
    const bytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (new TextDecoder().decode(bytes) !== "%PDF-") {
      throw new Error("The uploaded file is not a valid PDF.");
    }
    return {
      name: `${newToken(24)}.pdf`,
      data: await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read the selected PDF."));
        reader.readAsDataURL(file);
      })
    };
  }

  function currentLocalUser() {
    const id = Number(localStorage.getItem(SESSION_KEY));
    return getUsers().find((user) => user.id === id) || null;
  }

  function requireLocalUser(role) {
    const user = currentLocalUser();
    if (!user) throw new Error("Please sign in to continue.");
    if (role && user.role !== role) throw new Error("You do not have permission to access this page.");
    return user;
  }

  function localAadhaar(user) {
    if (!user.aadhaarDataUrl) return "";
    return URL.createObjectURL(dataUrlToBlob(user.aadhaarDataUrl));
  }

  function dataUrlToBlob(dataUrl) {
    const [metadata, content] = dataUrl.split(",");
    const binary = atob(content);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: metadata.match(/data:([^;]+)/)?.[1] || "application/pdf" });
  }

  async function localRequest(path, options) {
    const { method = "GET", data, formData } = options;
    const users = getUsers();
    if (path === "/api/auth/session") {
      sessionUser = currentLocalUser();
      return { user: sessionUser ? publicUser(sessionUser) : null };
    }
    if (path === "/api/auth/register" && method === "POST") {
      const student = formFields(formData);
      checkStudentFields(student, true);
      if (student.password.length > 128) throw new Error("Password must be between 8 and 128 characters.");
      if (users.some((user) => user.email === student.email)) throw new Error("This email is already registered.");
      const aadhaar = await readPdf(student.aadhaar, true);
      const { password, aadhaar: ignoredFile, ...profile } = student;
      const user = {
        ...profile,
        id: Math.max(0, ...users.map((entry) => entry.id)) + 1,
        role: "student",
        passwordHash: await passwordHash(password),
        aadhaarDataUrl: aadhaar.data,
        aadhaarFilename: aadhaar.name,
        has_aadhaar: true,
        created_at: new Date().toISOString()
      };
      users.push(user);
      saveUsers(users);
      return { message: "Registration successful. You can now log in." };
    }
    if (path === "/api/auth/login" && method === "POST") {
      const email = String(data.email || "").trim().toLowerCase();
      const user = users.find((entry) => entry.email === email);
      if (!user || await passwordHash(String(data.password || "")) !== user.passwordHash) {
        throw new Error("Invalid email or password.");
      }
      localStorage.setItem(SESSION_KEY, String(user.id));
      sessionUser = user;
      return { user: publicUser(user) };
    }
    if (path === "/api/auth/logout" && method === "POST") {
      localStorage.removeItem(SESSION_KEY);
      sessionUser = null;
      return { message: "Logged out." };
    }
    if (path === "/api/auth/forgot-password" && method === "POST") {
      const email = String(data.email || "").trim().toLowerCase();
      const user = users.find((entry) => entry.email === email);
      if (user) {
        if (data.dob !== user.dob) throw new Error("The email and date of birth do not match.");
        if (String(data.password || "").length < 8 || String(data.password || "").length > 128) {
          throw new Error("Password must be between 8 and 128 characters.");
        }
        user.passwordHash = await passwordHash(String(data.password || ""));
        saveUsers(users);
        if (user.role === "admin") localStorage.setItem(ADMIN_PASS_KEY, String(data.password));
      }
      return { message: user ? "Password updated. You can now log in." : "If that account exists, its password was updated." };
    }
    if (path === "/api/students/me" && method === "GET") {
      const user = requireLocalUser("student");
      return { student: publicUser(user) };
    }
    if (path === "/api/students/me/aadhaar" && method === "GET") {
      const user = requireLocalUser("student");
      if (!user.aadhaarDataUrl) throw new Error("Aadhaar document not found.");
      return { fileUrl: localAadhaar(user) };
    }
    if (path === "/api/students/me" && method === "PATCH") {
      const activeUser = requireLocalUser("student");
      const user = users.find((entry) => entry.id === activeUser.id);
      if (!user) throw new Error("Student profile not found.");
      const student = formFields(formData);
      student.email = user.email;
      checkStudentFields(student, false);
      const aadhaar = await readPdf(student.aadhaar, false);
      const { aadhaar: ignoredFile, password: ignoredPassword, ...profile } = student;
      Object.assign(user, profile);
      if (aadhaar) {
        user.aadhaarDataUrl = aadhaar.data;
        user.aadhaarFilename = aadhaar.name;
        user.has_aadhaar = true;
      }
      saveUsers(users);
      return { message: "Profile updated." };
    }
    if (path === "/api/students" && method === "GET") {
      requireLocalUser("admin");
      return { students: users.filter((user) => user.role === "student").map(publicUser) };
    }
    const match = path.match(/^\/api\/students\/(\d+)(?:\/aadhaar)?$/);
    if (match) {
      requireLocalUser("admin");
      const student = users.find((user) => user.id === Number(match[1]) && user.role === "student");
      if (!student) throw new Error("Student not found.");
      if (path.endsWith("/aadhaar")) {
        if (!student.aadhaarDataUrl) throw new Error("Aadhaar document not found.");
        return { fileUrl: localAadhaar(student) };
      }
      if (method === "PATCH") {
        const fields = formFields(formData);
        fields.name = student.name;
        fields.email = student.email;
        checkStudentFields(fields, false);
        const aadhaar = await readPdf(fields.aadhaar, false);
        const { aadhaar: ignoredFile, password: ignoredPassword, ...profile } = fields;
        Object.assign(student, profile);
        if (aadhaar) {
          student.aadhaarDataUrl = aadhaar.data;
          student.aadhaarFilename = aadhaar.name;
          student.has_aadhaar = true;
        }
        saveUsers(users);
        return { message: "Student updated." };
      }
      if (method === "DELETE") {
        saveUsers(users.filter((user) => user.id !== student.id));
        return { message: "Student deleted." };
      }
    }
    throw new Error("Not found.");
  }

  function publicUser(user) {
    const { passwordHash, aadhaarDataUrl, aadhaarFilename, ...publicRecord } = user;
    return { ...publicRecord, has_aadhaar: Boolean(user.has_aadhaar || aadhaarDataUrl) };
  }

  async function request(path, options = {}) {
    if (mode === "local" && allowLocalFallback) return localRequest(path, options);
    if (mode === "local") {
      mode = "server";
      localStorage.setItem("student-management-mode", mode);
    }
    const { method = "GET", data, formData } = options;
    if (method !== "GET" && !csrfToken && path !== "/api/auth/csrf") {
      try {
        const csrfResponse = await fetch("/api/auth/csrf", { credentials: "same-origin" });
        if (!csrfResponse.ok) throw new Error("The API could not provide a CSRF token.");
        const csrfData = await csrfResponse.json();
        csrfToken = csrfData.csrfToken || "";
      } catch {
        if (allowLocalFallback) {
          await activateLocalMode();
          return localRequest(path, options);
        }
        throw new Error("The service is unavailable. Please try again shortly.");
      }
    }
    const headers = {};
    let body;
    if (formData) body = formData;
    else if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(data);
    }
    if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
    let response;
    try {
      response = await fetch(path, { method, headers, body, credentials: "same-origin" });
    } catch {
      if (allowLocalFallback) {
        await activateLocalMode();
        return localRequest(path, options);
      }
      throw new Error("The service is unavailable. Please try again shortly.");
    }
    const passwordResetRequest = path === "/api/auth/forgot-password" || path === "/api/auth/reset-password";
    if (response.status >= 500 && !passwordResetRequest && allowLocalFallback) {
      await activateLocalMode();
      return localRequest(path, options);
    }
    if (response.status >= 500) {
      serviceUnavailable = true;
      showModeNotice();
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/pdf")) {
      return { fileUrl: URL.createObjectURL(await response.blob()) };
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    if (result.csrfToken) csrfToken = result.csrfToken;
    if (Object.hasOwn(result, "user")) sessionUser = result.user;
    return result;
  }

  async function initialize() {
    if (mode === "local" && allowLocalFallback) {
      await seedLocalAdmin();
      sessionUser = currentLocalUser();
      return;
    }
    if (mode === "local") {
      mode = "server";
      localStorage.setItem("student-management-mode", mode);
    }
    try {
      const response = await fetch("/api/auth/csrf", { credentials: "same-origin" });
      if (!response.ok) throw new Error("API unavailable");
      const result = await response.json();
      csrfToken = result.csrfToken || "";
      const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin" });
      if (!sessionResponse.ok) throw new Error("API unavailable");
      const current = await sessionResponse.json();
      csrfToken = current.csrfToken || csrfToken;
      sessionUser = current.user;
      mode = "server";
      localStorage.setItem("student-management-mode", mode);
    } catch {
      if (allowLocalFallback) {
        await activateLocalMode();
      } else {
        mode = "server";
        sessionUser = null;
        serviceUnavailable = true;
      }
      sessionUser = currentLocalUser();
    }
  }

  function showModeNotice() {
    if (mode !== "local" && !serviceUnavailable) return;
    if (document.querySelector(".local-mode-notice, .service-unavailable-notice")) return;
    const notice = document.createElement("p");
    if (mode === "local") {
      notice.className = "notice warning local-mode-notice";
      notice.textContent = "Local demo mode: data and authentication are stored in this browser only. Do not use real Aadhaar documents.";
    } else {
      notice.className = "notice warning service-unavailable-notice";
      notice.textContent = "The service is unavailable. Local browser storage is disabled; please try again later or contact the administrator.";
    }
    document.querySelector("main")?.prepend(notice);
  }

  async function activateLocalMode() {
    if (!allowLocalFallback) {
      serviceUnavailable = true;
      showModeNotice();
      throw new Error("The service is unavailable. Local browser storage is disabled.");
    }
    mode = "local";
    localStorage.setItem("student-management-mode", mode);
    await seedLocalAdmin();
    sessionUser = currentLocalUser();
    showModeNotice();
  }

  function calculateAge(dob) {
    const birth = new Date(`${dob}T00:00:00`);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    if (now.getMonth() < birth.getMonth() ||
        (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age -= 1;
    return age;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  return {
    initialize, request, showModeNotice, calculateAge, escapeHtml,
    get user() { return sessionUser; },
    set user(value) { sessionUser = value; },
    get mode() { return mode; },
    getAdminPassword: () => localStorage.getItem(ADMIN_PASS_KEY)
  };
})();
