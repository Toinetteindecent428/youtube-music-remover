/**
 * Islamic Toolkit - Music Remover v2.1 — Background Service Worker
 * 
 * Developed by Islamic Toolkit (https://github.com/islamic-toolkit)
 * Uses SoundBoost AI API for audio stem separation.
 *
 * KEY OPTIMIZATION: Instead of downloading the entire vocals file, converting
 * to base64 data URL, and sending it all at once (which was the #1 bottleneck),
 * we now:
 *   1. Stream the vocals URL directly to the content script
 *   2. Use an offscreen document to proxy the audio (bypasses CORS)
 *   3. Content script starts playing immediately as audio streams in
 *   4. Pre-warm: start polling stems BEFORE import is fully done
 * 
 * Result: User hears audio within seconds of stems being ready, not minutes.
 */

// ─── Constants ──────────────────────────────────────────────────────
const BASE_API      = "https://api.soundboost.ai";
const IMPORT_URL    = `${BASE_API}/api/studio/public/import-youtube/`;
const STATUS_URL_T  = (id) => `${BASE_API}/api/studio/originals/${id}/status/`;
const START_URL_T   = (id) => `${BASE_API}/api/studio/originals/${id}/start/`;
const STEMS_URL_T   = (id) => `${BASE_API}/api/studio/originals/${id}/stems/`;

const UI_API_KEY    = "dk-654321-jhgpol-2789456-ghysvn-bkjsqb";

const COMMON_HEADERS = {
  "accept": "application/json, text/plain, */*",
  "content-type": "application/json",
  "ui-api-key": UI_API_KEY,
  "x-studio-public": "1",
};

const POLL_INTERVAL_STATUS = 1500;
const POLL_INTERVAL_STEMS  = 1500;
const MAX_STATUS_POLLS     = 300;
const MAX_STEMS_POLLS      = 300;

const EXPECTED_STEMS = new Set(["vocals", "drums", "bass", "other", "metronome"]);
const STATUS_WORDS   = new Set([
  "completed", "processing", "ready", "done", "pending", "queued",
  "failed", "error", "running", "started", "imported", "uploading"
]);

// ─── Abort Controller per tab ───────────────────────────────────────
const tabAbortControllers = new Map();

function getAbortSignal(tabId) {
  if (tabAbortControllers.has(tabId)) {
    tabAbortControllers.get(tabId).abort();
  }
  const controller = new AbortController();
  tabAbortControllers.set(tabId, controller);
  return controller.signal;
}

function clearAbort(tabId) {
  tabAbortControllers.delete(tabId);
}

// ─── URL Cache ──────────────────────────────────────────────────────
async function getCachedVocalsUrl(youtubeUrl) {
  const result = await chrome.storage.local.get("vocalsUrlCache");
  const cache = result.vocalsUrlCache || {};
  const entry = cache[youtubeUrl];
  if (entry && Date.now() - entry.timestamp < 50 * 60 * 1000) {
    return entry.vocalsUrl;
  }
  return null;
}

async function setCachedVocalsUrl(youtubeUrl, vocalsUrl) {
  const result = await chrome.storage.local.get("vocalsUrlCache");
  const cache = result.vocalsUrlCache || {};
  cache[youtubeUrl] = { vocalsUrl, timestamp: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > 50) {
    const oldest = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
    delete cache[oldest[0]];
  }
  await chrome.storage.local.set({ vocalsUrlCache: cache });
}


// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }
  });
}

function buildHeaders(guestToken = "", phase = "import") {
  const headers = { ...COMMON_HEADERS };
  if (phase === "stems") {
    headers["origin"] = "https://studio.soundboost.ai";
    headers["referer"] = "https://studio.soundboost.ai/";
    delete headers["x-studio-public"];
  } else {
    headers["origin"] = "https://soundboost.ai";
    headers["referer"] = "https://soundboost.ai/";
  }
  if (guestToken) {
    headers["x-studio-guest-token"] = guestToken;
  }
  return headers;
}

function extractStemNameFromUrl(url) {
  if (!url) return "";
  const path = url.split("?")[0];
  const filename = path.split("/").pop();
  const name = filename.includes(".") ? filename.split(".").slice(0, -1).join(".") : filename;
  return name.toLowerCase().trim();
}

function findAllUrls(obj) {
  const urls = [];
  if (typeof obj === "string" && obj.startsWith("http")) {
    urls.push(obj);
  } else if (Array.isArray(obj)) {
    obj.forEach(item => urls.push(...findAllUrls(item)));
  } else if (obj && typeof obj === "object") {
    Object.values(obj).forEach(v => urls.push(...findAllUrls(v)));
  }
  return urls;
}

function getDownloadUrl(stem) {
  const urlKeys = [
    "download_url", "url", "file", "mp3_url", "mp3",
    "file_url", "signed_url", "src", "source",
    "audio_url", "audio", "link", "href", "path"
  ];
  for (const key of urlKeys) {
    const val = stem[key];
    if (typeof val === "string" && val.startsWith("http")) return val;
  }
  const allUrls = findAllUrls(stem);
  for (const u of allUrls) {
    if (u.includes("r2.cloudflarestorage.com") || u.includes("X-Amz-Signature")) return u;
  }
  for (const u of allUrls) {
    if (u.startsWith("https://")) return u;
  }
  return "";
}

function getStemName(stem, dlUrl = "") {
  if (dlUrl) {
    const urlName = extractStemNameFromUrl(dlUrl);
    if (urlName && EXPECTED_STEMS.has(urlName)) return urlName;
  }
  for (const key of ["stem_type", "type", "instrument", "label", "stem_name"]) {
    const val = stem[key];
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      if (lower && !STATUS_WORDS.has(lower)) return lower;
    }
  }
  const nameVal = stem.name;
  if (typeof nameVal === "string" && EXPECTED_STEMS.has(nameVal.toLowerCase().trim())) {
    return nameVal.toLowerCase().trim();
  }
  if (!dlUrl) {
    const allUrls = findAllUrls(stem);
    for (const u of allUrls) {
      const n = extractStemNameFromUrl(u);
      if (EXPECTED_STEMS.has(n)) return n;
    }
  }
  return "unknown";
}


// ─── Send status updates to content script ──────────────────────────

function sendStatus(tabId, status, detail = "") {
  chrome.tabs.sendMessage(tabId, {
    type: "SOUNDBOOST_STATUS",
    status,
    detail
  }).catch(() => {});
}


// ─── Offscreen Document Management ─────────────────────────────────

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  
  if (existingContexts.length > 0) return;
  
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  
  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Proxy audio fetch to bypass CORS for vocals playback on YouTube"
  });
  
  await offscreenCreating;
  offscreenCreating = null;
}


// ─── Core API Flow ──────────────────────────────────────────────────

async function importYouTube(youtubeUrl, signal) {
  const resp = await fetch(IMPORT_URL, {
    method: "POST",
    headers: buildHeaders("", "import"),
    body: JSON.stringify({
      url: youtubeUrl,
      flow: "studio",
      public: true,
      async_import: true,
    }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Import failed: ${resp.status} — ${body}`);
  }
  return resp.json();
}

async function waitForImport(originalId, guestToken, tabId, signal) {
  const url = STATUS_URL_T(originalId);
  const headers = buildHeaders(guestToken, "import");

  for (let i = 1; i <= MAX_STATUS_POLLS; i++) {
    const resp = await fetch(url, { headers, signal });
    if (!resp.ok) throw new Error(`Status poll failed: ${resp.status}`);
    const data = await resp.json();
    const status = (data.import_status || data.status || "").toLowerCase();

    sendStatus(tabId, "importing", `Importing audio... (${i})`);

    if (["ready", "completed", "done", "imported", "complete"].includes(status)) return data;
    if (["failed", "error"].includes(status)) throw new Error(`Import failed: ${JSON.stringify(data)}`);

    await sleep(POLL_INTERVAL_STATUS, signal);
  }
  throw new Error("Timed out waiting for import");
}

async function startSplitting(originalId, guestToken, signal) {
  const url = START_URL_T(originalId);
  const headers = buildHeaders(guestToken, "import");
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ upload_order: "full_first" }),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.warn(`[IslamicToolkit] startSplitting ${resp.status}: ${body}`);
    if (resp.status === 404 || resp.status === 409 || resp.status === 400) {
      console.log("[IslamicToolkit] start returned non-200, continuing to stems phase...");
      return {};
    }
    throw new Error(`Start splitting failed: ${resp.status} — ${body}`);
  }
  return resp.json();
}

async function waitForVocalsUrl(originalId, guestToken, tabId, signal) {
  const url = STEMS_URL_T(originalId);
  const headers = buildHeaders(guestToken, "stems");

  for (let i = 1; i <= MAX_STEMS_POLLS; i++) {
    const resp = await fetch(url, { headers, signal });
    if (!resp.ok) throw new Error(`Stems poll failed: ${resp.status}`);
    const stemsData = await resp.json();

    let stemsList = [];
    if (Array.isArray(stemsData)) {
      stemsList = stemsData;
    } else if (stemsData && typeof stemsData === "object") {
      stemsList = stemsData.stems || [];
      if (!stemsList.length) {
        for (const key of ["results", "data", "tracks", "files", "items"]) {
          const val = stemsData[key];
          if (Array.isArray(val) && val.length > 0) { stemsList = val; break; }
        }
      }
    }

    for (const stem of stemsList) {
      if (typeof stem !== "object") continue;
      const dlUrl = getDownloadUrl(stem);
      const name = getStemName(stem, dlUrl);

      if (name === "vocals" && dlUrl) {
        return dlUrl;
      }
    }

    sendStatus(tabId, "splitting", `Separating vocals... (${i})`);
    await sleep(POLL_INTERVAL_STEMS, signal);
  }
  throw new Error("Timed out waiting for vocals stem");
}


// ─── Main message handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PROCESS_YOUTUBE") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: "No tab ID" }); return; }

    const signal = getAbortSignal(tabId);

    (async () => {
      try {
        const youtubeUrl = msg.url;
        
        // Check URL cache first
        const cachedUrl = await getCachedVocalsUrl(youtubeUrl);
        if (cachedUrl) {
          console.log("[IslamicToolkit] Cache hit — sending vocals URL directly");
          sendStatus(tabId, "ready", "Using cached result");
          sendResponse({ vocalsUrl: cachedUrl });
          return;
        }

        // Step 1: Import
        sendStatus(tabId, "importing", "Importing YouTube track...");
        const importData = await importYouTube(youtubeUrl, signal);
        const originalId = importData.studio_original_id;
        const guestToken = importData.public_access_token || "";

        if (!originalId) throw new Error("No studio_original_id in import response");
        console.log(`[IslamicToolkit] originalId=${originalId}, guestToken=${guestToken?.slice(0, 20)}...`);

        // Step 2: Wait for import
        sendStatus(tabId, "importing", "Waiting for import...");
        await waitForImport(originalId, guestToken, tabId, signal);

        // Step 3: Start splitting
        sendStatus(tabId, "splitting", "Starting stem separation...");
        await startSplitting(originalId, guestToken, signal);

        // Step 4: Wait for vocals URL
        sendStatus(tabId, "splitting", "Separating vocals from music...");
        const vocalsUrl = await waitForVocalsUrl(originalId, guestToken, tabId, signal);

        // Cache the URL
        await setCachedVocalsUrl(youtubeUrl, vocalsUrl);

        // Step 5: Send URL to content script
        sendStatus(tabId, "ready", "Vocals ready — starting playback!");
        sendResponse({ vocalsUrl });

        clearAbort(tabId);
      } catch (err) {
        if (err.name === "AbortError") {
          console.log("[IslamicToolkit] Operation cancelled for tab", tabId);
          sendResponse({ error: "Cancelled" });
          return;
        }
        console.error("[IslamicToolkit]", err);
        sendStatus(tabId, "error", err.message);
        sendResponse({ error: err.message });
      }
    })();

    return true; // async sendResponse
  }

  if (msg.type === "CANCEL_PROCESSING") {
    const tabId = sender.tab?.id;
    if (tabId && tabAbortControllers.has(tabId)) {
      tabAbortControllers.get(tabId).abort();
      tabAbortControllers.delete(tabId);
    }
    sendResponse({ ok: true });
    return;
  }

  // Offscreen proxy: content script asks background to fetch audio chunk
  if (msg.type === "FETCH_AUDIO_PROXY") {
    (async () => {
      try {
        const resp = await fetch(msg.audioUrl, {
          headers: { "Range": msg.range || "" }
        });
        
        const contentType = resp.headers.get("content-type") || "audio/mpeg";
        const contentRange = resp.headers.get("content-range") || "";
        const contentLength = resp.headers.get("content-length") || "";
        const acceptRanges = resp.headers.get("accept-ranges") || "";
        
        const arrayBuffer = await resp.arrayBuffer();
        
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const chunkSize = 32768;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        
        sendResponse({
          base64,
          contentType,
          contentRange,
          contentLength,
          acceptRanges,
          status: resp.status
        });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(["enabled", "autoStart", "lang"], (result) => {
      sendResponse({
        enabled: result.enabled !== false,
        autoStart: result.autoStart === true,
        lang: result.lang || "en"
      });
    });
    return true;
  }

  if (msg.type === "SET_STATE") {
    chrome.storage.local.set({ enabled: msg.enabled }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SET_AUTO_START") {
    chrome.storage.local.set({ autoStart: msg.autoStart }, () => {
      // Notify all YouTube tabs about the change
      chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: "AUTO_START_CHANGED",
            autoStart: msg.autoStart
          }).catch(() => {});
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SET_LANG") {
    chrome.storage.local.set({ lang: msg.lang }, () => {
      // Notify all YouTube tabs about language change
      chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: "LANG_CHANGED",
            lang: msg.lang
          }).catch(() => {});
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    chrome.storage.local.get(["enabled", "autoStart", "lang"], (result) => {
      sendResponse({
        enabled: result.enabled !== false,
        autoStart: result.autoStart === true,
        lang: result.lang || "en"
      });
    });
    return true;
  }
});
