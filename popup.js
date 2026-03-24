const enableToggle = document.getElementById("enableToggle");
const autoStartToggle = document.getElementById("autoStartToggle");
const langSelect = document.getElementById("langSelect");

// Load saved state
chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
  enableToggle.checked = resp?.enabled !== false;
  autoStartToggle.checked = resp?.autoStart === true;
  const lang = resp?.lang || "en";
  langSelect.value = lang;
  applyLanguage(lang);
});

// Save enable toggle
enableToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_STATE", enabled: enableToggle.checked });
});

// Save auto-start toggle
autoStartToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_AUTO_START", autoStart: autoStartToggle.checked });
  // Update step2 text based on auto-start state
  updateStep2();
});

// Language change
langSelect.addEventListener("change", () => {
  const lang = langSelect.value;
  chrome.runtime.sendMessage({ type: "SET_LANG", lang });
  applyLanguage(lang);
});

function applyLanguage(lang) {
  const tr = getTranslations(lang);
  const body = document.body;

  // RTL for Arabic
  if (lang === "ar") {
    body.classList.add("rtl");
  } else {
    body.classList.remove("rtl");
  }

  // Update all text elements
  document.getElementById("extName").textContent = tr.extName;
  document.getElementById("extDesc").textContent = tr.extDesc;
  document.getElementById("enableLabel").textContent = tr.enabled;
  document.getElementById("autoStartLabel").textContent = tr.autoStart;
  document.getElementById("autoStartDesc").textContent = tr.autoStartDesc;
  document.getElementById("howTitle").textContent = tr.howItWorks;
  document.getElementById("step1").textContent = tr.step1;
  document.getElementById("step3").textContent = tr.step3;
  document.getElementById("step4").textContent = tr.step4;
  document.getElementById("poweredByLabel").textContent = tr.poweredBy;
  document.getElementById("devLink").textContent = tr.developerName;
  document.getElementById("languageLabel").textContent = tr.language;
  document.getElementById("versionLabel").textContent = tr.version;

  updateStep2(lang);
}

function updateStep2(lang) {
  const currentLang = lang || langSelect.value;
  const tr = getTranslations(currentLang);
  const step2 = document.getElementById("step2");
  if (autoStartToggle.checked) {
    step2.textContent = tr.step2_auto;
  } else {
    step2.textContent = tr.step2_manual;
  }
}
