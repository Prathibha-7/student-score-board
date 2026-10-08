"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  await App.initialize();
  App.showModeNotice();
  const profileNode = document.querySelector("#profile");
  const form = document.querySelector("#profile-form");
  const panel = document.querySelector("#edit-panel");
  const message = document.querySelector("#form-message");
  const dobInput = form.elements.dob;
  dobInput.max = new Date().toISOString().slice(0, 10);
  let profile;

  async function loadProfile() {
    const session = await App.request("/api/auth/session");
    if (!session.user) {
      window.location.replace("/login.html");
      return false;
    }
    if (session.user.role !== "student") {
      window.location.replace("/admin.html");
      return false;
    }
    const result = await App.request("/api/students/me");
    profile = result.student;
    App.user = session.user;
    renderProfile();
    fillForm();
    return true;
  }

  function renderProfile() {
    document.querySelector("#welcome").textContent = `Welcome, ${profile.name} (User ID: #${profile.id})`;
    const fileLink = profile.has_aadhaar
      ? '<a id="aadhaar-link" href="/api/students/me/aadhaar" target="_blank" rel="noopener">Open Aadhaar PDF</a>'
      : '<span class="muted">Not uploaded</span>';
    profileNode.innerHTML = `
      <div class="profile-grid">
        <div><span class="detail-label">Full name</span><strong>${App.escapeHtml(profile.name)}</strong></div>
        <div><span class="detail-label">Email</span><strong>${App.escapeHtml(profile.email)}</strong></div>
        <div><span class="detail-label">Date of birth</span><strong>${App.escapeHtml(profile.dob)}</strong></div>
        <div><span class="detail-label">Age</span><strong>${App.calculateAge(profile.dob)}</strong></div>
        <div><span class="detail-label">Gender</span><strong>${App.escapeHtml(profile.gender)}</strong></div>
        <div><span class="detail-label">Qualification</span><strong>${App.escapeHtml(profile.qualification)}</strong></div>
        <div><span class="detail-label">Interests</span><strong>${App.escapeHtml((profile.interests || []).join(", "))}</strong></div>
        <div><span class="detail-label">Class</span><strong>${App.escapeHtml(profile.class_name)}</strong></div>
        <div><span class="detail-label">Subject</span><strong>${App.escapeHtml(profile.subject)}</strong></div>
        <div><span class="detail-label">Marks</span><strong>${App.escapeHtml(profile.marks)}%</strong></div>
        <div><span class="detail-label">Aadhaar document</span><strong>${fileLink}</strong></div>
      </div>`;
    const link = document.querySelector("#aadhaar-link");
    if (link) {
      link.addEventListener("click", async (event) => {
        if (App.mode !== "local") return;
        event.preventDefault();
        const popup = window.open("about:blank", "_blank");
        if (!popup) return;
        const file = await App.request("/api/students/me/aadhaar");
        popup.opener = null;
        popup.location = file.fileUrl;
      });
    }
  }

  function fillForm() {
    for (const key of ["name", "email", "dob", "qualification", "class_name", "subject", "marks"]) {
      form.elements[key].value = profile[key] ?? "";
    }
    form.querySelectorAll('input[name="gender"]').forEach((input) => {
      input.checked = input.value === profile.gender;
    });
    form.querySelectorAll('input[name="interests"]').forEach((input) => {
      input.checked = (profile.interests || []).includes(input.value);
    });
  }

  try {
    if (!await loadProfile()) return;
  } catch {
    window.location.replace("/login.html");
    return;
  }

  document.querySelector("#edit-toggle").addEventListener("click", () => panel.classList.toggle("hidden"));
  document.querySelector("#cancel-edit").addEventListener("click", () => {
    panel.classList.add("hidden");
    fillForm();
  });
  document.querySelector("[data-logout]").addEventListener("click", async () => {
    try {
      await App.request("/api/auth/logout", { method: "POST" });
      window.location.assign("/login.html");
    } catch (error) {
      message.textContent = error.message;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    message.className = "form-message";
    if (!form.reportValidity()) return;
    if (!form.querySelector('input[name="interests"]:checked')) {
      message.textContent = "Choose at least one interest.";
      message.classList.add("error");
      return;
    }
    try {
      const data = new FormData(form);
      data.set("email", profile.email);
      const result = await App.request("/api/students/me", { method: "PATCH", formData: data });
      message.textContent = result.message;
      message.classList.add("success");
      await loadProfile();
      panel.classList.add("hidden");
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
    }
  });
});
