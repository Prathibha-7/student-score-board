"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  await App.initialize();
  App.showModeNotice();
  const form = document.querySelector("#forgot-form");
  const message = document.querySelector("#form-message");
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const localFields = document.querySelector("#local-fields");
  const tokenFields = document.querySelector("#token-fields");
  const email = form.elements.email;
  const intro = document.querySelector("#reset-intro");
  const submit = form.querySelector("button[type=submit]");
  const localMode = App.mode === "local";

  if (token && !localMode) {
    tokenFields.classList.remove("hidden");
    email.required = false;
    email.classList.add("hidden");
    form.querySelector('label[for="email"]').classList.add("hidden");
    intro.textContent = "Choose a new password. Reset links expire after 30 minutes.";
    submit.textContent = "Reset password";
  } else if (localMode) {
    localFields.classList.remove("hidden");
    form.elements.dob.required = true;
    form.elements.password.required = true;
    intro.textContent = "Local demo recovery verifies your email and date of birth.";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    message.className = "form-message";
    if (!form.reportValidity()) return;
    submit.disabled = true;
    try {
      let result;
      if (token && !localMode) {
        const password = form.elements["new-password"].value;
        if (password !== form.elements["confirm-password"].value) {
          throw new Error("The passwords do not match.");
        }
        result = await App.request("/api/auth/reset-password", {
          method: "POST",
          data: { token, password }
        });
      } else if (localMode) {
        result = await App.request("/api/auth/forgot-password", {
          method: "POST",
          data: {
            email: email.value,
            dob: form.elements.dob.value,
            password: form.elements.password.value
          }
        });
      } else {
        result = await App.request("/api/auth/forgot-password", {
          method: "POST",
          data: { email: email.value }
        });
      }
      message.textContent = result.message;
      message.classList.add("success");
      if (token && !localMode) {
        form.reset();
        window.setTimeout(() => window.location.assign("/login.html"), 1200);
      }
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
    } finally {
      submit.disabled = false;
    }
  });
});
