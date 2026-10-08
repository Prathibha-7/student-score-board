"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  await App.initialize();
  App.showModeNotice();
  const rows = document.querySelector("#student-rows");
  const message = document.querySelector("#form-message");
  const dialog = document.querySelector("#edit-dialog");
  const form = document.querySelector("#edit-form");
  const editMessage = document.querySelector("#edit-message");
  let students = [];
  form.elements.dob.max = new Date().toISOString().slice(0, 10);

  async function loadStudents() {
    const session = await App.request("/api/auth/session");
    if (!session.user) {
      window.location.replace("/login.html");
      return false;
    }
    if (session.user.role !== "admin") {
      window.location.replace("/student.html");
      return false;
    }
    App.user = session.user;
    const result = await App.request("/api/students");
    students = result.students;
    updateClassOptions();
    renderRows();
    return true;
  }

  function updateClassOptions() {
    const select = document.querySelector("#filter-class");
    const selected = select.value;
    const classes = [...new Set(students.map((student) => student.class_name))].sort();
    select.innerHTML = '<option value="">All classes</option>' +
      classes.map((value) => `<option value="${App.escapeHtml(value)}">${App.escapeHtml(value)}</option>`).join("");
    select.value = classes.includes(selected) ? selected : "";
  }

  function renderRows() {
    const term = document.querySelector("#filter-name").value.trim().toLocaleLowerCase();
    const className = document.querySelector("#filter-class").value;
    const minValue = document.querySelector("#min-age").value;
    const maxValue = document.querySelector("#max-age").value;
    const minAge = minValue === "" ? null : Number(minValue);
    const maxAge = maxValue === "" ? null : Number(maxValue);
    const filtered = students.filter((student) => {
      const age = App.calculateAge(student.dob);
      return student.name.toLocaleLowerCase().includes(term) &&
        (!className || student.class_name === className) &&
        (minAge === null || age >= minAge) &&
        (maxAge === null || age <= maxAge);
    });
    document.querySelector("#student-count").textContent = `${filtered.length} student${filtered.length === 1 ? "" : "s"}`;
    if (!filtered.length) {
      rows.innerHTML = '<tr><td colspan="8" class="empty-state">No students match these filters.</td></tr>';
      return;
    }
    rows.innerHTML = filtered.map((student) => `<tr>
      <td>${App.escapeHtml(student.name)}</td>
      <td>${App.escapeHtml(student.email)}</td>
      <td>${App.calculateAge(student.dob)}</td>
      <td>${App.escapeHtml(student.class_name)}</td>
      <td>${App.escapeHtml(student.subject)}</td>
      <td>${App.escapeHtml(student.marks)}%</td>
      <td>${student.has_aadhaar
        ? `<a href="/api/students/${student.id}/aadhaar" data-aadhaar="${student.id}" target="_blank" rel="noopener">Open PDF</a>`
        : '<span class="muted">—</span>'}</td>
      <td class="actions"><button class="button small secondary" data-edit="${student.id}">Edit</button>
      <button class="button small danger" data-delete="${student.id}">Delete</button></td>
    </tr>`).join("");
  }

  function openEditor(student) {
    form.reset();
    editMessage.textContent = "";
    form.elements.student_id.value = student.id;
    for (const key of ["name", "email", "dob", "qualification", "class_name", "subject", "marks"]) {
      form.elements[key].value = student[key] ?? "";
    }
    form.querySelectorAll('input[name="gender"]').forEach((input) => {
      input.checked = input.value === student.gender;
    });
    form.querySelectorAll('input[name="interests"]').forEach((input) => {
      input.checked = (student.interests || []).includes(input.value);
    });
    dialog.showModal();
  }

  try {
    if (!await loadStudents()) return;
  } catch {
    window.location.replace("/login.html");
    return;
  }

  ["#filter-name", "#filter-class", "#min-age", "#max-age"].forEach((selector) => {
    document.querySelector(selector).addEventListener("input", renderRows);
    document.querySelector(selector).addEventListener("change", renderRows);
  });
  document.querySelector("[data-logout]").addEventListener("click", async () => {
    try {
      await App.request("/api/auth/logout", { method: "POST" });
      window.location.assign("/login.html");
    } catch (error) {
      message.textContent = error.message;
    }
  });
  rows.addEventListener("click", async (event) => {
    const editButton = event.target.closest("[data-edit]");
    const deleteButton = event.target.closest("[data-delete]");
    const fileLink = event.target.closest("[data-aadhaar]");
    if (editButton) {
      const student = students.find((entry) => entry.id === Number(editButton.dataset.edit));
      if (student) openEditor(student);
    }
    if (deleteButton) {
      const student = students.find((entry) => entry.id === Number(deleteButton.dataset.delete));
      if (!student || !window.confirm(`Delete ${student.name}'s student record? This cannot be undone.`)) return;
      try {
        await App.request(`/api/students/${student.id}`, { method: "DELETE" });
        await loadStudents();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    }
    if (fileLink && App.mode === "local") {
      event.preventDefault();
      try {
        const popup = window.open("about:blank", "_blank");
        if (!popup) return;
        const result = await App.request(`/api/students/${fileLink.dataset.aadhaar}/aadhaar`);
        popup.opener = null;
        popup.location = result.fileUrl;
      } catch (error) {
        message.textContent = error.message;
      }
    }
  });
  document.querySelectorAll("#close-dialog, #cancel-dialog").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (!form.querySelector('input[name="interests"]:checked')) {
      editMessage.textContent = "Choose at least one interest.";
      editMessage.className = "form-message error";
      return;
    }
    const id = form.elements.student_id.value;
    const data = new FormData(form);
    data.delete("student_id");
    data.set("email", form.elements.email.value);
    try {
      const result = await App.request(`/api/students/${id}`, { method: "PATCH", formData: data });
      dialog.close();
      message.textContent = result.message;
      message.className = "form-message success";
      await loadStudents();
    } catch (error) {
      editMessage.textContent = error.message;
      editMessage.className = "form-message error";
    }
  });
});
