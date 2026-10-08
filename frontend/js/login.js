"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.querySelector("#login-form");
  const message = document.querySelector("#form-message");
  const submit = form.querySelector("button[type=submit]");
  await App.initialize();
  App.showModeNotice();

  function showLocalAdmin() {
    if (App.mode === "local") {
      const password = App.getAdminPassword();
      const demo = document.querySelector("#local-admin");
      if (password) {
        demo.classList.remove("hidden");
        demo.textContent = `Local demo admin · email: admin@local.test · password: ${password}. This account exists only in this browser.`;
      }
    }
  }
  showLocalAdmin();
  if (App.user) {
    window.location.replace(App.user.role === "admin" ? "/admin.html" : "/student.html");
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    submit.disabled = true;
    try {
      if (!form.reportValidity()) return;
      const result = await App.request("/api/auth/login", {
        method: "POST",
        data: Object.fromEntries(new FormData(form))
      });
      App.user = result.user;
      window.location.assign(result.user.role === "admin" ? "/admin.html" : "/student.html");
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
      App.showModeNotice();
      showLocalAdmin();
    } finally {
      submit.disabled = false;
    }
  });
});
