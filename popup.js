const providersApi = globalThis.ITK_PROVIDERS || {};
const DEFAULT_PROVIDER = providersApi.DEFAULT_PROVIDER_ID || "removeMusic";
const DEFAULT_CHUNK_DURATION_SEC = 30;
const MIN_CHUNK_DURATION_SEC = 10;
const MAX_CHUNK_DURATION_SEC = 60;

const mainPage = document.getElementById("mainPage");
const settingsPage = document.getElementById("settingsPage");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const backBtn = document.getElementById("backBtn");

const enableToggle = document.getElementById("enableToggle");
const autoStartToggle = document.getElementById("autoStartToggle");
const langSelect = document.getElementById("langSelect");

const providerSelect = document.getElementById("providerSelect");
const providerWarningRow = document.getElementById("providerWarningRow");
const providerWarningText = document.getElementById("providerWarningText");
const chunkDurationRow = document.getElementById("chunkDurationRow");
const chunkDurationSlider = document.getElementById("chunkDurationSlider");
const chunkDurationValue = document.getElementById("chunkDurationValue");

const playbackPromptToggle = document.getElementById("playbackPromptToggle");
const playbackPromptRow = document.getElementById("playbackPromptRow");
const popupI18n = globalThis.ITK_I18N || {};

openSettingsBtn.addEventListener("click", () => {
  mainPage.classList.add("hidden");
  settingsPage.classList.remove("hidden");
});

backBtn.addEventListener("click", () => {
  settingsPage.classList.add("hidden");
  mainPage.classList.remove("hidden");
});

function normalizeProvider(value) {
  if (typeof providersApi.normalizeProviderId === "function") {
    return providersApi.normalizeProviderId(value);
  }
  return DEFAULT_PROVIDER;
}

function normalizeChunkDuration(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CHUNK_DURATION_SEC;
  return Math.min(MAX_CHUNK_DURATION_SEC, Math.max(MIN_CHUNK_DURATION_SEC, parsed));
}

function normalizeLang(value) {
  if (typeof popupI18n.normalizeLang === "function") return popupI18n.normalizeLang(value);
  return value === "ar" ? "ar" : "en";
}

function isRtlLang(value) {
  if (typeof popupI18n.isRtlLang === "function") return popupI18n.isRtlLang(value);
  return normalizeLang(value) === "ar";
}

function updateSliderDisplay(val, lang = langSelect.value || "en") {
  const tr = getTranslations(normalizeLang(lang));
  chunkDurationValue.textContent = `${val}${tr.chunkDurationUnitSec || "s"}`;
}

function getProviderDefinition(provider) {
  if (typeof providersApi.getProviderDefinition === "function") {
    return providersApi.getProviderDefinition(provider);
  }

  return {
    id: DEFAULT_PROVIDER,
    labelKey: "providerRemoveMusic",
    pipelineType: "upload_audio",
    supportsChunkDuration: true,
    supportsPlaybackPrompt: true,
    selectionWarningKey: null
  };
}

function renderProviderOptions(lang, selectedProvider = providerSelect.value) {
  const tr = getTranslations(normalizeLang(lang));
  const providerDefinitions = typeof providersApi.listProviders === "function"
    ? providersApi.listProviders()
    : [getProviderDefinition(DEFAULT_PROVIDER)];

  providerSelect.innerHTML = "";

  for (const providerDef of providerDefinitions) {
    const option = document.createElement("option");
    option.value = providerDef.id;
    option.textContent = tr[providerDef.labelKey] || providerDef.id;
    providerSelect.appendChild(option);
  }

  providerSelect.value = normalizeProvider(selectedProvider);
}

function updateProviderDependentControls(lang = langSelect.value || "en") {
  const tr = getTranslations(normalizeLang(lang));
  const providerDef = getProviderDefinition(providerSelect.value);

  const supportsChunkDuration = providerDef.supportsChunkDuration === true;
  chunkDurationRow.classList.toggle("disabled", !supportsChunkDuration);
  chunkDurationSlider.disabled = !supportsChunkDuration;

  const supportsPlaybackPrompt = providerDef.supportsPlaybackPrompt === true;
  playbackPromptRow.classList.toggle("disabled", !supportsPlaybackPrompt);
  playbackPromptToggle.disabled = !supportsPlaybackPrompt;

  const warningKey = providerDef.selectionWarningKey || null;
  const warningText = warningKey ? (tr[warningKey] || warningKey) : "";
  providerWarningText.textContent = warningText;
  providerWarningRow.classList.toggle("visible", Boolean(warningText));
}

function saveProcessingSettings() {
  const provider = normalizeProvider(providerSelect.value);
  const chunkDurationSec = normalizeChunkDuration(chunkDurationSlider.value);

  providerSelect.value = provider;
  chunkDurationSlider.value = String(chunkDurationSec);
  updateSliderDisplay(chunkDurationSec);
  updateProviderDependentControls();

  chrome.runtime.sendMessage({
    type: "SET_PROCESSING_SETTINGS",
    provider,
    chunkDurationSec
  });
}

chunkDurationSlider.addEventListener("input", () => {
  updateSliderDisplay(chunkDurationSlider.value);
});

chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
  enableToggle.checked = resp?.enabled !== false;
  autoStartToggle.checked = resp?.autoStart === true;

  const lang = normalizeLang(resp?.lang);
  const provider = normalizeProvider(resp?.provider);
  const chunkDurationSec = normalizeChunkDuration(resp?.chunkDurationSec);
  const playbackPromptEnabled = resp?.playbackPromptEnabled !== false;

  langSelect.value = lang;
  renderProviderOptions(lang, provider);
  chunkDurationSlider.value = String(chunkDurationSec);
  updateSliderDisplay(chunkDurationSec, lang);

  playbackPromptToggle.checked = playbackPromptEnabled;
  updateProviderDependentControls(lang);

  applyLanguage(lang);
});

enableToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_STATE", enabled: enableToggle.checked });
});

autoStartToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_AUTO_START", autoStart: autoStartToggle.checked });
  updateStep2();
});

langSelect.addEventListener("change", () => {
  const lang = normalizeLang(langSelect.value);
  chrome.runtime.sendMessage({ type: "SET_LANG", lang });
  applyLanguage(lang);
});

providerSelect.addEventListener("change", saveProcessingSettings);
chunkDurationSlider.addEventListener("change", saveProcessingSettings);

playbackPromptToggle.addEventListener("change", () => {
  const playbackPromptEnabled = playbackPromptToggle.checked;
  chrome.runtime.sendMessage({ type: "SET_PLAYBACK_PROMPT_ENABLED", playbackPromptEnabled });
});

function applyLanguage(lang) {
  const normalizedLang = normalizeLang(lang);
  const tr = getTranslations(normalizedLang);
  const body = document.body;
  const root = document.documentElement;

  root.lang = normalizedLang;
  root.dir = isRtlLang(normalizedLang) ? "rtl" : "ltr";

  if (isRtlLang(normalizedLang)) {
    body.classList.add("rtl");
  } else {
    body.classList.remove("rtl");
  }

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
  document.getElementById("versionLabel").textContent = tr.version;
  document.getElementById("settingsBtnLabel").textContent = tr.settings;
  document.getElementById("languageLabel").textContent = tr.language;

  const langOptions = langSelect.options;
  langOptions[0].textContent = tr.langEn;
  langOptions[1].textContent = tr.langAr;

  document.getElementById("backBtnLabel").textContent = tr.backToMain;
  document.getElementById("settingsTitle").textContent = tr.settings;
  document.getElementById("providerLabel").textContent = tr.provider;
  document.getElementById("chunkDurationLabel").textContent = tr.chunkDuration;
  document.getElementById("chunkDurationDesc").textContent = tr.chunkDurationDesc;
  updateSliderDisplay(chunkDurationSlider.value, normalizedLang);

  document.getElementById("playbackSectionLabel").textContent = tr.playbackSection || "Playback Behavior";
  document.getElementById("playbackPromptLabel").textContent = tr.askBeforeStart || "Ask Before Starting";
  document.getElementById("playbackPromptDesc").textContent = tr.askBeforeStartDesc || "Show a choice before processing so you can decide whether the video keeps playing with its original audio.";
  renderProviderOptions(normalizedLang, providerSelect.value);
  updateProviderDependentControls(normalizedLang);

  updateStep2(normalizedLang);
}

function updateStep2(lang) {
  const currentLang = normalizeLang(lang || langSelect.value);
  const tr = getTranslations(currentLang);
  const step2 = document.getElementById("step2");
  step2.textContent = autoStartToggle.checked ? tr.step2_auto : tr.step2_manual;
}
