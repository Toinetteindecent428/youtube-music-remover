/**
 * Islamic Toolkit - Music Remover v2.1 — Content Script (YouTube)
 *
 * Developed by Islamic Toolkit (https://github.com/islamic-toolkit)
 * Uses SoundBoost AI API for audio stem separation.
 *
 * Features:
 *   - Auto-start: automatically begins music removal on page load (configurable)
 *   - Bilingual UI: English and Arabic support with RTL
 *   - Streaming playback via MediaSource API
 *   - Fallback to Blob URL for unsupported codecs
 */

(() => {
  "use strict";

  // ─── Inline Translations (content scripts can't import modules) ────
  const TRANSLATIONS = {
    en: {
      removeMusic: "Remove Music",
      processing: "Processing...",
      buffering: "Buffering...",
      musicRemoved: "Music Removed ✓",
      errorRetry: "Error — Retry?",
      starting: "Starting...",
      loadingAudio: "Loading audio...",
      somethingWrong: "Something went wrong",
      connectingStream: "Connecting to audio stream...",
      downloadingVocals: "Downloading vocals audio...",
      downloadingPct: "Downloading vocals... {pct}%",
      loadingPct: "Loading audio... {pct}%",
      autoStarting: "Auto-starting music removal...",
      title: "Remove background music (Islamic Toolkit)"
    },
    ar: {
      removeMusic: "إزالة الموسيقى",
      processing: "جارٍ المعالجة...",
      buffering: "جارٍ التحميل...",
      musicRemoved: "تمت إزالة الموسيقى ✓",
      errorRetry: "خطأ — إعادة المحاولة؟",
      starting: "جارٍ البدء...",
      loadingAudio: "جارٍ تحميل الصوت...",
      somethingWrong: "حدث خطأ ما",
      connectingStream: "جارٍ الاتصال بتدفق الصوت...",
      downloadingVocals: "جارٍ تحميل صوت الأصوات...",
      downloadingPct: "جارٍ تحميل الأصوات... {pct}%",
      loadingPct: "جارٍ تحميل الصوت... {pct}%",
      autoStarting: "جارٍ بدء إزالة الموسيقى تلقائياً...",
      title: "إزالة الموسيقى الخلفية (أدوات إسلامية)"
    }
  };

  let currentLang = "en";

  function tr(key, replacements) {
    const strings = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
    let str = strings[key] || TRANSLATIONS.en[key] || key;
    if (replacements) {
      for (const [k, v] of Object.entries(replacements)) {
        str = str.replace(new RegExp("\\{" + k + "\\}", "g"), v);
      }
    }
    return str;
  }

  // ─── State ────────────────────────────────────────────────────────
  let currentVideoId = null;
  let isActive = false;
  let isProcessing = false;
  let vocalsAudio = null;
  let originalVolume = 1;
  let syncInterval = null;
  let uiContainer = null;
  let mediaSource = null;
  let sourceBuffer = null;
  let autoStartEnabled = false;
  let extensionEnabled = true;
  let autoStartTriggered = false; // prevent double-trigger per video

  // ─── YouTube URL Helpers ──────────────────────────────────────────

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v") || null;
  }

  function getFullYouTubeUrl() {
    const vid = getVideoId();
    return vid ? `https://www.youtube.com/watch?v=${vid}` : null;
  }

  function getVideoElement() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  // ─── UI ───────────────────────────────────────────────────────────

  function createUI() {
    if (uiContainer) uiContainer.remove();

    uiContainer = document.createElement("div");
    uiContainer.id = "soundboost-ui";
    uiContainer.innerHTML = `
      <button id="sb-toggle" title="${tr('title')}">
        <span id="sb-icon">🎵</span>
        <span id="sb-label">${tr('removeMusic')}</span>
      </button>
      <div id="sb-status" style="display:none;"></div>
    `;

    const playerContainer =
      document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player") ||
      document.querySelector("ytd-player");

    if (playerContainer) {
      playerContainer.style.position = "relative";
      playerContainer.appendChild(uiContainer);
    } else {
      document.body.appendChild(uiContainer);
    }

    document.getElementById("sb-toggle").addEventListener("click", handleToggle);
  }

  function updateUI(state, detail = "") {
    const btn = document.getElementById("sb-toggle");
    const label = document.getElementById("sb-label");
    const icon = document.getElementById("sb-icon");
    const statusEl = document.getElementById("sb-status");

    if (!btn) return;

    switch (state) {
      case "idle":
        btn.className = "";
        icon.textContent = "🎵";
        label.textContent = tr('removeMusic');
        statusEl.style.display = "none";
        break;

      case "processing":
        btn.className = "processing";
        icon.textContent = "⏳";
        label.textContent = tr('processing');
        statusEl.style.display = "block";
        statusEl.textContent = detail || tr('starting');
        break;

      case "buffering":
        btn.className = "processing";
        icon.textContent = "⏳";
        label.textContent = tr('buffering');
        statusEl.style.display = "block";
        statusEl.textContent = detail || tr('loadingAudio');
        break;

      case "active":
        btn.className = "active";
        icon.textContent = "🔇";
        label.textContent = tr('musicRemoved');
        statusEl.style.display = "none";
        break;

      case "error":
        btn.className = "error";
        icon.textContent = "⚠️";
        label.textContent = tr('errorRetry');
        statusEl.style.display = "block";
        statusEl.textContent = detail || tr('somethingWrong');
        break;
    }
  }

  // ─── Audio Sync ───────────────────────────────────────────────────

  function startSync() {
    stopSync();
    const video = getVideoElement();
    if (!video || !vocalsAudio) return;

    video.addEventListener("play", onVideoPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("seeked", onVideoSeeked);
    video.addEventListener("ratechange", onVideoRateChange);

    syncInterval = setInterval(() => {
      if (!video || !vocalsAudio) return;
      if (vocalsAudio.readyState < 2) return;
      const drift = Math.abs(video.currentTime - vocalsAudio.currentTime);
      if (drift > 0.3) {
        vocalsAudio.currentTime = video.currentTime;
      }
    }, 500);

    vocalsAudio.currentTime = video.currentTime;
    vocalsAudio.playbackRate = video.playbackRate;
    if (!video.paused) {
      vocalsAudio.play().catch(() => {});
    }
  }

  function stopSync() {
    const video = getVideoElement();
    if (video) {
      video.removeEventListener("play", onVideoPlay);
      video.removeEventListener("pause", onVideoPause);
      video.removeEventListener("seeked", onVideoSeeked);
      video.removeEventListener("ratechange", onVideoRateChange);
    }
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  }

  function onVideoPlay() {
    if (vocalsAudio) {
      vocalsAudio.currentTime = getVideoElement().currentTime;
      vocalsAudio.play().catch(() => {});
    }
  }

  function onVideoPause() {
    if (vocalsAudio) vocalsAudio.pause();
  }

  function onVideoSeeked() {
    if (vocalsAudio) {
      vocalsAudio.currentTime = getVideoElement().currentTime;
    }
  }

  function onVideoRateChange() {
    if (vocalsAudio) {
      vocalsAudio.playbackRate = getVideoElement().playbackRate;
    }
  }

  // ─── Streaming Audio via Background Proxy ─────────────────────────

  async function streamAudioFromProxy(audioUrl) {
    const video = getVideoElement();
    if (!video) throw new Error("No video element found");

    updateUI("buffering", tr('connectingStream'));
    
    const probeResponse = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "FETCH_AUDIO_PROXY",
        audioUrl,
        range: "bytes=0-1023"
      }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (resp?.error) {
          reject(new Error(resp.error));
          return;
        }
        resolve(resp);
      });
    });

    const contentType = probeResponse.contentType || "audio/mpeg";
    const supportsRange = probeResponse.acceptRanges === "bytes" || probeResponse.status === 206;
    
    let totalSize = 0;
    if (probeResponse.contentRange) {
      const match = probeResponse.contentRange.match(/\/(\d+)/);
      if (match) totalSize = parseInt(match[1]);
    }
    if (!totalSize && probeResponse.contentLength) {
      totalSize = parseInt(probeResponse.contentLength);
    }

    console.log(`[IslamicToolkit] Audio: type=${contentType}, size=${totalSize}, rangeSupport=${supportsRange}`);

    const mseMimeMap = {
      "audio/mpeg": "audio/mpeg",
      "audio/mp3": "audio/mpeg", 
      "audio/mp4": "audio/mp4; codecs=\"mp4a.40.2\"",
      "audio/aac": "audio/mp4; codecs=\"mp4a.40.2\"",
      "audio/ogg": "audio/ogg; codecs=\"vorbis\"",
      "audio/webm": "audio/webm; codecs=\"opus\"",
    };

    const mseMime = mseMimeMap[contentType] || contentType;
    const canUseMSE = typeof MediaSource !== "undefined" && 
                      MediaSource.isTypeSupported(mseMime) &&
                      supportsRange && totalSize > 0;

    if (canUseMSE) {
      console.log("[IslamicToolkit] Using MediaSource streaming (fastest path)");
      await streamWithMediaSource(audioUrl, mseMime, totalSize, probeResponse);
    } else {
      console.log("[IslamicToolkit] Using Blob URL fallback (still fast)");
      await streamWithBlobUrl(audioUrl, totalSize);
    }
  }

  async function streamWithMediaSource(audioUrl, mime, totalSize, probeData) {
    const video = getVideoElement();

    return new Promise((resolve, reject) => {
      mediaSource = new MediaSource();
      vocalsAudio = new Audio();
      vocalsAudio.volume = 1.0;
      vocalsAudio.src = URL.createObjectURL(mediaSource);

      let started = false;
      let appendQueue = [];
      let isAppending = false;
      let fetchComplete = false;

      mediaSource.addEventListener("sourceopen", async () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer(mime);
          
          sourceBuffer.addEventListener("updateend", () => {
            isAppending = false;
            
            if (!started && sourceBuffer.buffered.length > 0) {
              started = true;
              video.volume = 0;
              isActive = true;
              updateUI("active");
              startSync();
              resolve();
            }
            
            processQueue();
          });

          sourceBuffer.addEventListener("error", (e) => {
            console.error("[IslamicToolkit] SourceBuffer error:", e);
            if (!started) {
              reject(new Error("SourceBuffer error"));
            }
          });

          function processQueue() {
            if (isAppending || appendQueue.length === 0) {
              if (fetchComplete && appendQueue.length === 0 && !isAppending) {
                try {
                  if (mediaSource.readyState === "open") {
                    mediaSource.endOfStream();
                  }
                } catch (e) { /* ignore */ }
              }
              return;
            }
            isAppending = true;
            const chunk = appendQueue.shift();
            try {
              sourceBuffer.appendBuffer(chunk);
            } catch (e) {
              console.error("[IslamicToolkit] appendBuffer error:", e);
              isAppending = false;
            }
          }

          const probeBytes = Uint8Array.from(atob(probeData.base64), c => c.charCodeAt(0));
          appendQueue.push(probeBytes);
          processQueue();

          const CHUNK_SIZE = 256 * 1024;
          let offset = probeBytes.length;

          while (offset < totalSize) {
            const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
            const pct = Math.round((offset / totalSize) * 100);
            
            if (!started) {
              updateUI("buffering", tr('loadingPct', { pct }));
            }

            const chunkResp = await new Promise((res, rej) => {
              chrome.runtime.sendMessage({
                type: "FETCH_AUDIO_PROXY",
                audioUrl,
                range: `bytes=${offset}-${end}`
              }, (resp) => {
                if (chrome.runtime.lastError) {
                  rej(new Error(chrome.runtime.lastError.message));
                  return;
                }
                if (resp?.error) {
                  rej(new Error(resp.error));
                  return;
                }
                res(resp);
              });
            });

            const chunkBytes = Uint8Array.from(atob(chunkResp.base64), c => c.charCodeAt(0));
            appendQueue.push(chunkBytes);
            processQueue();

            offset = end + 1;
          }

          fetchComplete = true;
          if (!isAppending) processQueue();

        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async function streamWithBlobUrl(audioUrl, totalSize) {
    const video = getVideoElement();

    const CHUNK_SIZE = 512 * 1024;
    const chunks = [];
    let offset = 0;

    if (!totalSize) {
      updateUI("buffering", tr('downloadingVocals'));
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "FETCH_AUDIO_PROXY",
          audioUrl,
          range: ""
        }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (resp?.error) {
            reject(new Error(resp.error));
            return;
          }
          resolve(resp);
        });
      });

      const bytes = Uint8Array.from(atob(resp.base64), c => c.charCodeAt(0));
      chunks.push(bytes);
    } else {
      while (offset < totalSize) {
        const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
        const pct = Math.round((offset / totalSize) * 100);
        updateUI("buffering", tr('downloadingPct', { pct }));

        const resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: "FETCH_AUDIO_PROXY",
            audioUrl,
            range: `bytes=${offset}-${end}`
          }, (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp?.error) {
              reject(new Error(resp.error));
              return;
            }
            resolve(resp);
          });
        });

        const bytes = Uint8Array.from(atob(resp.base64), c => c.charCodeAt(0));
        chunks.push(bytes);
        offset = end + 1;
      }
    }

    const blob = new Blob(chunks, { type: "audio/mpeg" });
    const blobUrl = URL.createObjectURL(blob);

    vocalsAudio = new Audio();
    vocalsAudio.volume = 1.0;
    vocalsAudio.preload = "auto";

    await new Promise((resolve, reject) => {
      vocalsAudio.addEventListener("canplay", () => {
        video.volume = 0;
        isActive = true;
        updateUI("active");
        startSync();
        resolve();
      }, { once: true });

      vocalsAudio.addEventListener("error", (e) => {
        const mediaErr = vocalsAudio.error;
        reject(new Error(mediaErr ? `Audio error: code=${mediaErr.code}` : "Audio load error"));
      }, { once: true });

      vocalsAudio.src = blobUrl;
      vocalsAudio.load();
    });
  }

  // ─── Activate / Deactivate ────────────────────────────────────────

  async function activate() {
    const video = getVideoElement();
    const ytUrl = getFullYouTubeUrl();
    if (!video || !ytUrl) return;

    isProcessing = true;
    updateUI("processing", tr('starting'));
    originalVolume = video.volume;

    chrome.runtime.sendMessage(
      { type: "PROCESS_YOUTUBE", url: ytUrl },
      async (response) => {
        if (chrome.runtime.lastError) {
          console.error("[IslamicToolkit] Runtime error:", chrome.runtime.lastError.message);
          isProcessing = false;
          updateUI("error", chrome.runtime.lastError.message);
          return;
        }

        if (response?.error) {
          console.error("[IslamicToolkit] Process error:", response.error);
          isProcessing = false;
          updateUI("error", response.error);
          return;
        }

        const vocalsUrl = response?.vocalsUrl;
        
        if (response?.vocalsDataUrl && !vocalsUrl) {
          console.log("[IslamicToolkit] Got legacy data URL response");
          playFromDataUrl(response.vocalsDataUrl);
          return;
        }

        if (!vocalsUrl) {
          isProcessing = false;
          updateUI("error", "No vocals URL received");
          return;
        }

        console.log("[IslamicToolkit] Got vocals URL, starting streaming playback...");

        try {
          cleanupAudio();
          await streamAudioFromProxy(vocalsUrl);
          isProcessing = false;
        } catch (err) {
          console.error("[IslamicToolkit] Streaming error:", err);
          isProcessing = false;
          updateUI("error", err.message);
          deactivate();
        }
      }
    );
  }

  function playFromDataUrl(dataUrl) {
    const video = getVideoElement();
    cleanupAudio();

    vocalsAudio = new Audio();
    vocalsAudio.volume = 1.0;

    vocalsAudio.addEventListener("canplaythrough", () => {
      video.volume = 0;
      isActive = true;
      isProcessing = false;
      updateUI("active");
      startSync();
    }, { once: true });

    vocalsAudio.addEventListener("error", (e) => {
      isProcessing = false;
      const mediaErr = vocalsAudio.error;
      updateUI("error", mediaErr ? `Audio error: code=${mediaErr.code}` : "Audio error");
      deactivate();
    });

    vocalsAudio.src = dataUrl;
    vocalsAudio.load();
  }

  function cleanupAudio() {
    if (vocalsAudio) {
      vocalsAudio.pause();
      if (vocalsAudio.src && vocalsAudio.src.startsWith("blob:")) {
        URL.revokeObjectURL(vocalsAudio.src);
      }
      vocalsAudio.removeAttribute("src");
      vocalsAudio.load();
      vocalsAudio.remove();
      vocalsAudio = null;
    }
    if (mediaSource) {
      try {
        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch (e) { /* ignore */ }
      mediaSource = null;
    }
    sourceBuffer = null;
  }

  function deactivate() {
    const video = getVideoElement();
    if (video) {
      video.volume = originalVolume || 1;
    }

    stopSync();
    cleanupAudio();

    chrome.runtime.sendMessage({ type: "CANCEL_PROCESSING" }).catch(() => {});

    isActive = false;
    isProcessing = false;
    updateUI("idle");
  }

  function handleToggle() {
    if (isProcessing) return;

    if (isActive) {
      deactivate();
    } else {
      activate();
    }
  }

  // ─── Auto-Start Logic ─────────────────────────────────────────────

  function tryAutoStart() {
    if (!autoStartEnabled || !extensionEnabled) return;
    if (isActive || isProcessing || autoStartTriggered) return;
    
    const videoId = getVideoId();
    if (!videoId) return;

    const video = getVideoElement();
    if (!video) return;

    autoStartTriggered = true;
    console.log("[IslamicToolkit] Auto-starting music removal for video:", videoId);
    activate();
  }

  // ─── Status updates from background ───────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SOUNDBOOST_STATUS") {
      const statusMap = {
        "importing": "processing",
        "splitting": "processing",
        "downloading": "buffering",
        "ready": "active",
        "error": "error",
      };
      const uiState = statusMap[msg.status] || "processing";
      updateUI(uiState, msg.detail);
    }

    if (msg.type === "AUTO_START_CHANGED") {
      autoStartEnabled = msg.autoStart;
      // If auto-start was just enabled and we're on a video page, try it
      if (autoStartEnabled && !isActive && !isProcessing) {
        autoStartTriggered = false;
        tryAutoStart();
      }
    }

    if (msg.type === "LANG_CHANGED") {
      currentLang = msg.lang;
      // Refresh the UI button text if in idle state
      if (!isActive && !isProcessing) {
        updateUI("idle");
      }
    }
  });

  // ─── Navigation Detection (YouTube SPA) ───────────────────────────

  function onNavigate() {
    const newVideoId = getVideoId();

    if (!newVideoId) {
      if (uiContainer) { uiContainer.remove(); uiContainer = null; }
      if (isActive || isProcessing) deactivate();
      currentVideoId = null;
      autoStartTriggered = false;
      return;
    }

    if (newVideoId !== currentVideoId) {
      currentVideoId = newVideoId;
      autoStartTriggered = false;
      if (isActive || isProcessing) deactivate();
      waitForPlayer(() => {
        createUI();
        // Try auto-start after UI is created
        tryAutoStart();
      });
    }
  }

  function waitForPlayer(callback, attempts = 0) {
    if (attempts > 50) return;
    const player = document.querySelector("#movie_player") || document.querySelector("video");
    if (player) {
      callback();
    } else {
      setTimeout(() => waitForPlayer(callback, attempts + 1), 100);
    }
  }

  // Debounced navigation observer
  let navDebounce = null;
  const observer = new MutationObserver(() => {
    const vid = getVideoId();
    if (vid !== currentVideoId) {
      clearTimeout(navDebounce);
      navDebounce = setTimeout(onNavigate, 100);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);

  // ─── Init ─────────────────────────────────────────────────────────
  
  // Load settings before first navigate
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
    if (chrome.runtime.lastError) {
      // Extension context may not be ready, use defaults
      onNavigate();
      return;
    }
    extensionEnabled = resp?.enabled !== false;
    autoStartEnabled = resp?.autoStart === true;
    currentLang = resp?.lang || "en";
    onNavigate();
  });

})();
