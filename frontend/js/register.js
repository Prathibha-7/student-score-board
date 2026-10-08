"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  await App.initialize();
  App.showModeNotice();
  const form = document.querySelector("#register-form");
  const message = document.querySelector("#form-message");
  const submit = form.querySelector("button[type=submit]");
  const dob = form.elements.dob;
  dob.max = new Date().toISOString().slice(0, 10);

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
    submit.disabled = true;
    try {
      const result = await App.request("/api/auth/register", {
        method: "POST",
        formData: new FormData(form)
      });
      message.textContent = result.message;
      message.classList.add("success");
      form.reset();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
    } finally {
      submit.disabled = false;
    }
  });
});
