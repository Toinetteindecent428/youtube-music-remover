/**
 * Islamic Toolkit - Music Remover v4.1 — Content Script (YouTube)
 *
 * v4.1 Enhancements:
 *   1. Smooth chunk crossfade (no more audio jumps between chunks)
 *   2. Button injected into YouTube's right controls bar (inline with CC, settings, etc.)
 *   3. Circular progress ring around the icon shows processing state
 *   4. "Play immediately" setting — for upload-based providers only
 *   5. All status details shown only on hover (tooltip), nothing displayed directly
 *   6. Video pauses when processing starts (unless Play Immediately is ON)
 */

(() => {
  "use strict";

  const itkI18n = globalThis.ITK_I18N || {};
  const providersApi = globalThis.ITK_PROVIDERS || {};
  const DEFAULT_PROVIDER = providersApi.DEFAULT_PROVIDER_ID || "removeMusic";
  const DEFAULT_CHUNK_DURATION_SEC = 30;
  const MIN_CHUNK_DURATION_SEC = 10;
  const MAX_CHUNK_DURATION_SEC = 60;

  let currentLang = typeof itkI18n.normalizeLang === "function"
    ? itkI18n.normalizeLang("en")
    : "en";

  function tr(key, replacements) {
    if (typeof itkI18n.t === "function") return itkI18n.t(key, currentLang, replacements);
    return key;
  }

  function trRuntimeText(message) {
    if (!message) return "";
    if (typeof itkI18n.translateRuntimeText === "function") {
      return itkI18n.translateRuntimeText(message, currentLang);
    }
    return message;
  }

  function isRtlLang() {
    if (typeof itkI18n.isRtlLang === "function") return itkI18n.isRtlLang(currentLang);
    return currentLang === "ar";
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(response || {});
      });
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isDisconnectedError(error) {
    const m = error?.message || "";
    return m.includes("Extension context invalidated") ||
      m.includes("Receiving end does not exist") ||
      m.includes("Could not establish connection");
  }

  async function fetchAudioProxy(audioUrl, range = "") {
    const response = await sendMessage({ type: "FETCH_AUDIO_PROXY", audioUrl, range });
    if (response?.error) throw new Error(response.error);
    return response;
  }

  // ─── State ───
  let currentVideoId = null;
  let isActive = false;
  let isProcessing = false;
  let vocalsAudio = null;
  let originalVolume = 1;
  let originalMuted = false;
  let syncInterval = null;
  let overlayElement = null;
  let btnElement = null;       // the button element in YT controls
  let dismissBtnElement = null;
  let playbackPromptElement = null;
  let progressivePlayback = null;
  let autoStartEnabled = false;
  let extensionEnabled = true;
  let processingProvider = DEFAULT_PROVIDER;
  let chunkDurationSec = DEFAULT_CHUNK_DURATION_SEC;
  let autoStartTriggered = false;
  let currentJobId = null;
  let jobPollTimer = null;
  let processingGeneration = 0;
  let retriedFreshForVideo = false;
  let currentProcessingForceFresh = false;
  let settingsLoaded = false;
  let extensionRuntimeAlive = true;
  let playImmediately = false;  // play video with original audio while processing
  let playbackPromptEnabled = true;
  let videoPausedByUs = false;  // track if we paused the video
  let overlayDismissed = false;
  let pendingStartOptions = null;

  const itkUiHelpers = globalThis.ItkUiHelpers || {
    shouldRecreateUi({ hasPlayerContainer, hasControlsMount = true, btnConnected, statusConnected }) {
      if (!hasPlayerContainer) return false;
      if (!hasControlsMount) return false;
      if (!btnConnected) return true;
      if (!statusConnected) return true;
      return false;
    },
    shouldScheduleUiRepair({
      hasVideoId,
      sameVideo,
      settingsLoaded,
      extensionEnabled,
      hasPlayerContainer,
      hasControlsMount = true,
      btnConnected,
      statusConnected
    }) {
      if (!hasVideoId || !sameVideo || !settingsLoaded || !extensionEnabled) {
        return false;
      }

      return this.shouldRecreateUi({
        hasPlayerContainer,
        hasControlsMount,
        btnConnected,
        statusConnected
      });
    },
    shouldPromptForPlaybackChoice({ playbackPromptEnabled, supportsPlaybackPrompt }) {
      return playbackPromptEnabled === true && supportsPlaybackPrompt === true;
    }
  };

  // Track the current tooltip detail text (shown on hover)
  let currentUiState = "idle";
  let currentTooltipDetail = "";
  let statusBarElement = null;  // progress status bar element

  function normalizeProvider(value) {
    if (typeof providersApi.normalizeProviderId === "function") {
      return providersApi.normalizeProviderId(value);
    }
    return DEFAULT_PROVIDER;
  }

  function getProviderDefinition(value) {
    if (typeof providersApi.getProviderDefinition === "function") {
      return providersApi.getProviderDefinition(value);
    }

    return {
      id: DEFAULT_PROVIDER,
      pipelineType: "upload_audio",
      supportsChunkDuration: true,
      supportsPlaybackPrompt: true,
      selectionWarningKey: null
    };
  }

  function normalizeChunkDurationSec(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_CHUNK_DURATION_SEC;
    return Math.min(MAX_CHUNK_DURATION_SEC, Math.max(MIN_CHUNK_DURATION_SEC, parsed));
  }

  function providerSupportsPlaybackPrompt(value = processingProvider) {
    if (typeof providersApi.providerSupportsPlaybackPrompt === "function") {
      return providersApi.providerSupportsPlaybackPrompt(value);
    }
    return getProviderDefinition(value).supportsPlaybackPrompt === true;
  }

  // ─── YouTube URL Helpers ───

  function getVideoId() {
    return new URLSearchParams(window.location.search).get("v") || null;
  }

  function getFullYouTubeUrl() {
    const vid = getVideoId();
    return vid ? `https://www.youtube.com/watch?v=${vid}` : null;
  }

  function getVideoElement() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function getPlayerContainer() {
    return document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
  }

  function getLeftControlsContainer() {
    return document.querySelector(".ytp-left-controls");
  }

  function getAfterTimeDisplayReference(container) {
    if (!container) return null;

    const timeDisplay = itkUiHelpers?.getDirectChildAnchor
      ? itkUiHelpers.getDirectChildAnchor(container, container.querySelector(".ytp-time-display"))
      : container.querySelector(".ytp-time-display");

    return timeDisplay?.nextSibling || null;
  }

  function setUiVisibility() {
    const showOverlay = extensionEnabled;
    if (btnElement) btnElement.style.display = showOverlay ? "" : "none";
    if (statusBarElement) statusBarElement.style.display = showOverlay ? "" : "none";
    if (playbackPromptElement) playbackPromptElement.style.display = showOverlay ? "" : "none";
  }

  function applyLocalizedElementDirection(element) {
    if (!element) return;
    element.lang = currentLang;
    element.dir = isRtlLang() ? "rtl" : "ltr";
  }

  function refreshLocalizedUiText() {
    if (btnElement) {
      btnElement.setAttribute("aria-label", tr("title"));
      applyLocalizedElementDirection(btnElement);
    }

    const tooltip = btnElement?.querySelector(".itk-tooltip");
    if (tooltip) applyLocalizedElementDirection(tooltip);

    if (statusBarElement) applyLocalizedElementDirection(statusBarElement);

    if (playbackPromptElement) {
      applyLocalizedElementDirection(playbackPromptElement);
      const promptCard = playbackPromptElement.querySelector(".itk-playback-prompt-card");
      applyLocalizedElementDirection(promptCard);

      const titleEl = playbackPromptElement.querySelector("#itk-playback-prompt-title");
      const descEl = playbackPromptElement.querySelector("#itk-playback-prompt-desc");
      const waitBtn = playbackPromptElement.querySelector('[data-choice="wait"]');
      const playBtn = playbackPromptElement.querySelector('[data-choice="play"]');
      const dontAskLabel = playbackPromptElement.querySelector("#itk-playback-prompt-dont-ask-label");
      const dismissBtn = playbackPromptElement.querySelector("#itk-playback-prompt-dismiss");

      if (titleEl) titleEl.textContent = tr("playbackPromptTitle");
      if (descEl) descEl.textContent = tr("playbackPromptDesc");
      if (waitBtn) waitBtn.textContent = tr("playbackPromptWait");
      if (playBtn) playBtn.textContent = tr("playbackPromptPlay");
      if (dontAskLabel) dontAskLabel.textContent = tr("playbackPromptDontAsk");
      if (dismissBtn) dismissBtn.textContent = tr("playbackPromptNotNow");
    }
  }

  function clearJobPolling(resetJobId = true) {
    if (jobPollTimer) { clearTimeout(jobPollTimer); jobPollTimer = null; }
    if (resetJobId) currentJobId = null;
  }

  function scheduleJobPoll(delayMs, generation) {
    clearJobPolling(false);
    if (!currentJobId) return;
    const waitMs = Math.max(500, Math.min(delayMs || 1000, 2000));
    jobPollTimer = setTimeout(() => {
      pollProcessingJob(generation).catch(err => {
        if (generation !== processingGeneration) return;
        if (isDisconnectedError(err)) { extensionRuntimeAlive = false; stopAllProcessing(false); return; }
        stopAllProcessing(true);
        updateUI("error", err.message);
      });
    }, waitMs);
  }

  function silenceOriginalVideo() {
    const video = getVideoElement();
    if (video) video.muted = true;
  }

  function restoreOriginalVideoState() {
    const video = getVideoElement();
    if (video) {
      video.volume = originalVolume;
      video.muted = originalMuted;
      // If we paused the video, resume it
      if (videoPausedByUs) {
        videoPausedByUs = false;
        // Only resume if it's still paused (user might have manually unpaused)
      }
    }
  }

  /**
   * Pause the video when processing starts.
   * Upload-audio providers can opt into continuing playback while processing.
   * Direct-link providers always pause until the cleaned audio is ready.
   */
  function pauseVideoForProcessing() {
    const video = getVideoElement();
    if (!video) return;

    // Upload-audio providers can keep the original audio playing during processing.
    if (playImmediately && providerSupportsPlaybackPrompt()) return;

    // Pause the video
    if (!video.paused) {
      video.pause();
      videoPausedByUs = true;
    }
  }

  /**
   * Resume the video when the first playable audio becomes available.
   */
  function resumeVideoForPlayback() {
    const video = getVideoElement();
    if (!video) return;
    if (videoPausedByUs || video.paused) {
      videoPausedByUs = false;
      video.play().catch(() => {});
    }
  }

  function cancelCurrentJob(cancelRemote = true) {
    clearJobPolling(false);
    const jobId = currentJobId;
    currentJobId = null;
    if (cancelRemote && jobId) sendMessage({ type: "CANCEL_PROCESSING", jobId }).catch(() => {});
  }

  function stopAllProcessing(cancelRemote = true) {
    processingGeneration += 1;
    cancelCurrentJob(cancelRemote);
    restoreOriginalVideoState();
    stopSync();
    cleanupAudio();
    isActive = false;
    isProcessing = false;
    currentProcessingForceFresh = false;

    // If we paused the video, resume it when stopping
    if (videoPausedByUs) {
      const video = getVideoElement();
      if (video && video.paused) {
        video.play().catch(() => {});
      }
      videoPausedByUs = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // UI — YouTube Controls Bar Integration + Progress Circle
  // ═══════════════════════════════════════════════════════════

  // SVG paths for the music note icon
  const ICON_MUSIC = `<svg class="itk-icon-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
  </svg>`;

  const ICON_MUSIC_OFF = `<svg class="itk-icon-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
    <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  const ICON_ERROR = `<svg class="itk-icon-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
  </svg>`;

  const PROGRESS_RING_R = 13;
  const PROGRESS_RING_CIRCUMFERENCE = Math.PI * 2 * PROGRESS_RING_R;

  function createUI() {
    // Remove old button if exists
    if (overlayElement) overlayElement.remove();
    if (btnElement) btnElement.remove();
    if (statusBarElement) statusBarElement.remove();
    if (playbackPromptElement) playbackPromptElement.remove();

    const playerContainer = getPlayerContainer();
    const leftControls = getLeftControlsContainer();
    if (!playerContainer || !leftControls) return;

    overlayElement = null;
    dismissBtnElement = null;

    // Mount the control as a native-style YouTube button at the end of the left controls.
    btnElement = document.createElement("button");
    btnElement.className = "ytp-button itk-music-btn";
    btnElement.setAttribute("aria-label", tr('title'));
    btnElement.setAttribute("title", ""); // prevent default title tooltip
    btnElement.type = "button";
    btnElement.innerHTML = `
      <span class="itk-btn-inner">
        ${ICON_MUSIC}
        <svg class="itk-progress-ring" id="itk-progress-ring" viewBox="0 0 32 32">
          <circle class="itk-ring-bg" cx="16" cy="16" r="${PROGRESS_RING_R}"/>
          <circle class="itk-ring-fg" cx="16" cy="16" r="${PROGRESS_RING_R}"
            stroke-dasharray="${PROGRESS_RING_CIRCUMFERENCE}"
            stroke-dashoffset="${PROGRESS_RING_CIRCUMFERENCE}"/>
        </svg>
      </span>
      <div class="itk-tooltip" id="itk-tooltip">${tr('removeMusic')}</div>
    `;

    const referenceNode = getAfterTimeDisplayReference(leftControls);
    if (referenceNode && referenceNode.parentNode === leftControls) {
      leftControls.insertBefore(btnElement, referenceNode);
    } else {
      leftControls.appendChild(btnElement);
    }

    // Create status bar for progress details (shown inside the player)
    statusBarElement = document.createElement("div");
    statusBarElement.className = "itk-status-bar";
    statusBarElement.id = "itk-status-bar";
    statusBarElement.innerHTML = '<div class="itk-status-spinner"></div><span class="itk-status-text"></span>';
    applyLocalizedElementDirection(statusBarElement);
    playerContainer.appendChild(statusBarElement);

    playbackPromptElement = document.createElement("div");
    playbackPromptElement.className = "itk-playback-prompt";
    playbackPromptElement.innerHTML = `
      <div class="itk-playback-prompt-backdrop" data-dismiss-prompt="true"></div>
      <div class="itk-playback-prompt-card" role="dialog" aria-modal="true" aria-labelledby="itk-playback-prompt-title">
        <div class="itk-playback-prompt-title" id="itk-playback-prompt-title">${tr('playbackPromptTitle')}</div>
        <div class="itk-playback-prompt-desc" id="itk-playback-prompt-desc">${tr('playbackPromptDesc')}</div>
        <div class="itk-playback-prompt-actions">
          <button type="button" class="itk-playback-choice-btn" data-choice="wait">${tr('playbackPromptWait')}</button>
          <button type="button" class="itk-playback-choice-btn primary" data-choice="play">${tr('playbackPromptPlay')}</button>
        </div>
        <label class="itk-playback-prompt-checkbox">
          <input type="checkbox" id="itk-playback-prompt-dont-ask">
          <span id="itk-playback-prompt-dont-ask-label">${tr('playbackPromptDontAsk')}</span>
        </label>
        <button type="button" class="itk-playback-prompt-secondary" id="itk-playback-prompt-dismiss" data-dismiss-prompt="true">${tr('playbackPromptNotNow')}</button>
      </div>
    `;
    applyLocalizedElementDirection(playbackPromptElement);
    playerContainer.appendChild(playbackPromptElement);

    btnElement.addEventListener("click", handleToggle);

    for (const choiceBtn of playbackPromptElement.querySelectorAll("[data-choice]")) {
      choiceBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await confirmPlaybackPromptChoice(event.currentTarget.dataset.choice);
      });
    }

    for (const dismissTarget of playbackPromptElement.querySelectorAll("[data-dismiss-prompt]")) {
      dismissTarget.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        dismissPlaybackPrompt();
      });
    }

    refreshLocalizedUiText();
    applyCurrentUiState();
    if (pendingStartOptions) showPlaybackPrompt(pendingStartOptions);
  }

  function shouldPromptForPlaybackChoice() {
    return itkUiHelpers.shouldPromptForPlaybackChoice({
      playbackPromptEnabled,
      supportsPlaybackPrompt: providerSupportsPlaybackPrompt()
    });
  }

  function updatePlaybackPromptButtons() {
    if (!playbackPromptElement) return;
    const playBtn = playbackPromptElement.querySelector('[data-choice="play"]');
    const waitBtn = playbackPromptElement.querySelector('[data-choice="wait"]');
    if (!playBtn || !waitBtn) return;
    playBtn.classList.toggle("primary", playImmediately === true);
    waitBtn.classList.toggle("primary", playImmediately !== true);
  }

  function showPlaybackPrompt(startOptions = {}) {
    if (!playbackPromptElement) return false;
    pendingStartOptions = startOptions;
    const dontAskCheckbox = playbackPromptElement.querySelector("#itk-playback-prompt-dont-ask");
    if (dontAskCheckbox) dontAskCheckbox.checked = false;
    updatePlaybackPromptButtons();
    playbackPromptElement.classList.add("visible");
    return true;
  }

  function dismissPlaybackPrompt(clearPendingStart = true) {
    if (playbackPromptElement) playbackPromptElement.classList.remove("visible");
    if (clearPendingStart) pendingStartOptions = null;
  }

  async function confirmPlaybackPromptChoice(choice) {
    const nextPlayImmediately = choice === "play";
    const startOptions = pendingStartOptions;
    const dontAskCheckbox = playbackPromptElement?.querySelector("#itk-playback-prompt-dont-ask");
    const dontAskLater = dontAskCheckbox?.checked === true;

    playImmediately = nextPlayImmediately;
    if (dontAskLater) playbackPromptEnabled = false;

    dismissPlaybackPrompt(false);

    try {
      await sendMessage({ type: "SET_PLAY_IMMEDIATELY", playImmediately: nextPlayImmediately });
      if (dontAskLater) {
        await sendMessage({ type: "SET_PLAYBACK_PROMPT_ENABLED", playbackPromptEnabled: false });
      }
    } catch (error) {
      pendingStartOptions = null;
      updateUI("error", error.message || tr('somethingWrong'));
      return;
    }

    pendingStartOptions = null;
    if (startOptions) {
      activate(startOptions).catch(err => {
        if (!isDisconnectedError(err)) console.error("[IslamicToolkit] Start after prompt failed:", err);
      });
    }
  }

  function requestActivation(startOptions = {}) {
    if (playbackPromptElement?.classList.contains("visible")) return;

    if (shouldPromptForPlaybackChoice()) {
      showPlaybackPrompt(startOptions);
      return;
    }

    activate(startOptions).catch(err => {
      if (!isDisconnectedError(err)) console.error("[IslamicToolkit] Activation failed:", err);
    });
  }

  function ensureUIMounted() {
    const playerContainer = getPlayerContainer();
    const leftControls = getLeftControlsContainer();
    const shouldRecreate = itkUiHelpers.shouldRecreateUi({
      hasPlayerContainer: Boolean(playerContainer),
      hasControlsMount: Boolean(leftControls),
      btnConnected: Boolean(btnElement?.isConnected),
      statusConnected: Boolean(statusBarElement?.isConnected)
    });

    if (!shouldRecreate) return false;
    createUI();
    return true;
  }

  function setProgressRing(fraction, indeterminate = false) {
    const ring = btnElement?.querySelector(".itk-progress-ring");
    if (!ring) return;

    const fg = ring.querySelector(".itk-ring-fg");
    if (!fg) return;

    if (indeterminate) {
      ring.classList.add("visible", "indeterminate");
      ring.classList.remove("done");
      return;
    }

    ring.classList.remove("indeterminate");
    const clamped = Math.max(0, Math.min(1, fraction));
    const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - clamped);
    fg.style.strokeDashoffset = offset;

    if (clamped > 0) {
      ring.classList.add("visible");
    }
    if (clamped >= 1) {
      ring.classList.add("done");
    } else {
      ring.classList.remove("done");
    }
  }

  /**
   * Update UI state. All detail info is in the tooltip (hover-only).
   * Nothing is displayed directly on screen.
   */
  function updateUI(state, detail = "") {
    currentUiState = state;
    // Store detail for tooltip
    currentTooltipDetail = detail;
    const resolvedDetail = trRuntimeText(detail);

    if (!btnElement) return;
    const tooltip = btnElement.querySelector(".itk-tooltip");
    const ring = btnElement.querySelector(".itk-progress-ring");
    const btnInner = btnElement.querySelector(".itk-btn-inner");

    switch (state) {
      case "idle":
        btnElement.className = "ytp-button itk-music-btn";
        if (btnInner) btnInner.innerHTML = ICON_MUSIC + getRingSVG();
        if (tooltip) tooltip.textContent = tr('removeMusic');
        if (ring) ring.classList.remove("visible", "indeterminate", "done");
        setProgressRing(0);
        updateStatusBar("", "idle");
        break;

      case "processing": {
        btnElement.className = "ytp-button itk-music-btn processing";
        if (btnInner) btnInner.innerHTML = ICON_MUSIC + getRingSVG();
        // Tooltip: short label + detail
        const tooltipText = resolvedDetail ? `${tr('processing')} ${resolvedDetail}` : tr('processing');
        if (tooltip) tooltip.textContent = tooltipText;
        setProgressRing(0, true); // indeterminate spinner
        updateStatusBar(resolvedDetail || tr('processing'), "processing");
        break;
      }

      case "buffering": {
        btnElement.className = "ytp-button itk-music-btn processing";
        if (btnInner) btnInner.innerHTML = ICON_MUSIC + getRingSVG();
        const tooltipText = resolvedDetail ? `${tr('buffering')} ${resolvedDetail}` : tr('buffering');
        if (tooltip) tooltip.textContent = tooltipText;
        setProgressRing(0, true);
        updateStatusBar(resolvedDetail || tr('buffering'), "buffering");
        break;
      }

      case "active":
        btnElement.className = "ytp-button itk-music-btn active";
        if (btnInner) btnInner.innerHTML = ICON_MUSIC_OFF + getRingSVG();
        if (tooltip) tooltip.textContent = tr('musicRemoved');
        setProgressRing(1);
        updateStatusBar(tr('musicRemoved'), "done");
        // Auto-hide the status bar after 3 seconds when fully done
        setTimeout(() => { updateStatusBar("", "idle"); }, 3000);
        break;

      case "streaming": {
        btnElement.className = "ytp-button itk-music-btn active";
        if (btnInner) btnInner.innerHTML = ICON_MUSIC_OFF + getRingSVG();
        // Show chunk progress in tooltip
        let tooltipText = tr('musicRemoved');
        if (resolvedDetail) tooltipText += ` - ${resolvedDetail}`;
        if (tooltip) tooltip.textContent = tooltipText;
        // Calculate progress from chunks
        if (progressivePlayback) {
          const total = progressivePlayback.chunks.size;
          let ready = 0;
          for (const c of progressivePlayback.chunks.values()) {
            if (c.status === "ready") ready++;
          }
          setProgressRing(total > 0 ? ready / total : 0.5);
          updateStatusBar(`${tr('musicRemoved')} - ${tr('chunksReady', { ready, total })}`, "streaming");
        }
        break;
      }

      case "error":
        btnElement.className = "ytp-button itk-music-btn error";
        if (btnInner) btnInner.innerHTML = ICON_ERROR + getRingSVG();
        if (tooltip) tooltip.textContent = resolvedDetail ? `${tr('errorRetry')}: ${resolvedDetail}` : tr('errorRetry');
        setProgressRing(0);
        if (ring) ring.classList.remove("visible", "indeterminate");
        updateStatusBar(resolvedDetail || tr('errorRetry'), "error");
        break;
    }
  }

  function applyCurrentUiState() {
    updateUI(currentUiState, currentTooltipDetail);
    setUiVisibility();
  }

  function getRingSVG() {
    return `<svg class="itk-progress-ring" viewBox="0 0 32 32">
      <circle class="itk-ring-bg" cx="16" cy="16" r="${PROGRESS_RING_R}"/>
      <circle class="itk-ring-fg" cx="16" cy="16" r="${PROGRESS_RING_R}"
        stroke-dasharray="${PROGRESS_RING_CIRCUMFERENCE}"
        stroke-dashoffset="${PROGRESS_RING_CIRCUMFERENCE}"/>
    </svg>`;
  }

  function updateStatusBar(text, state) {
    if (!statusBarElement) return;
    const resolvedText = trRuntimeText(text);
    const textEl = statusBarElement.querySelector(".itk-status-text");
    const spinnerEl = statusBarElement.querySelector(".itk-status-spinner");
    // Remove old indicator elements
    const oldCheck = statusBarElement.querySelector(".itk-status-check");
    if (oldCheck) oldCheck.remove();
    const oldErrIcon = statusBarElement.querySelector(".itk-status-error-icon");
    if (oldErrIcon) oldErrIcon.remove();

    if (!resolvedText || state === "idle") {
      statusBarElement.classList.remove("visible");
      return;
    }

    if (textEl) textEl.textContent = resolvedText;

    if (state === "done") {
      if (spinnerEl) spinnerEl.style.display = "none";
      const check = document.createElement("span");
      check.className = "itk-status-check";
      check.textContent = "✓";
      statusBarElement.insertBefore(check, textEl);
    } else if (state === "error") {
      if (spinnerEl) spinnerEl.style.display = "none";
      const errIcon = document.createElement("span");
      errIcon.className = "itk-status-error-icon";
      errIcon.textContent = "✕";
      statusBarElement.insertBefore(errIcon, textEl);
    } else {
      if (spinnerEl) spinnerEl.style.display = "";
    }

    statusBarElement.classList.add("visible");
  }

  // ═══════════════════════════════════════════
  // Audio Sync
  // ═══════════════════════════════════════════

  function startSync() {
    stopSync();
    const video = getVideoElement();
    if (!video) return;
    if (!vocalsAudio && !progressivePlayback) return;

    video.addEventListener("play", onVideoPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("seeked", onVideoSeeked);
    video.addEventListener("ratechange", onVideoRateChange);

    syncInterval = setInterval(() => {
      if (!video) return;
      if (progressivePlayback) { syncProgressivePlaybackState(); return; }
      if (!vocalsAudio) return;
      if (vocalsAudio.readyState < 2) return;
      // For non-chunked playback, keep simple time sync
      const drift = Math.abs(video.currentTime - vocalsAudio.currentTime);
      if (drift > 0.3) vocalsAudio.currentTime = video.currentTime;
    }, 250);

    if (progressivePlayback) {
      syncProgressivePlaybackState({ forceSwitch: true });
      return;
    }

    if (vocalsAudio) {
      vocalsAudio.currentTime = video.currentTime;
      vocalsAudio.playbackRate = video.playbackRate;
      if (!video.paused) vocalsAudio.play().catch(() => {});
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
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  }

  function onVideoPlay() {
    if (progressivePlayback) { syncProgressivePlaybackState({ forcePlay: true }); return; }
    if (vocalsAudio) { vocalsAudio.currentTime = getVideoElement().currentTime; vocalsAudio.play().catch(() => {}); }
  }
  function onVideoPause() {
    if (vocalsAudio) vocalsAudio.pause();
  }
  function onVideoSeeked() {
    if (progressivePlayback) { syncProgressivePlaybackState({ forceSwitch: true }); return; }
    if (vocalsAudio) vocalsAudio.currentTime = getVideoElement().currentTime;
  }
  function onVideoRateChange() {
    if (progressivePlayback) { syncProgressivePlaybackState(); return; }
    if (vocalsAudio) vocalsAudio.playbackRate = getVideoElement().playbackRate;
  }

  // ═══════════════════════════════════════════════════════════
  // Progressive (Chunked) Playback — with Smooth Crossfade
  // ═══════════════════════════════════════════════════════════

  const CROSSFADE_DURATION_MS = 150; // ms to crossfade between chunks

  function clampValue(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function teardownVocalsAudioElement() {
    if (!vocalsAudio) return;
    vocalsAudio.pause();
    vocalsAudio.removeAttribute("src");
    vocalsAudio.load();
    vocalsAudio.remove();
    vocalsAudio = null;
  }

  function disposeAudioElement(audioElement) {
    if (!audioElement) return;
    try { audioElement.pause(); } catch (e) {}
    try { audioElement.removeAttribute("src"); } catch (e) {}
    try { audioElement.load(); } catch (e) {}
    try { audioElement.remove(); } catch (e) {}
  }

  function cleanupProgressivePlayback() {
    if (!progressivePlayback) return;
    if (progressivePlayback._outgoingAudio) {
      try {
        progressivePlayback._outgoingAudio.pause();
        progressivePlayback._outgoingAudio.removeAttribute("src");
        progressivePlayback._outgoingAudio.load();
      } catch(e) {}
      progressivePlayback._outgoingAudio = null;
    }
    for (const blobUrl of progressivePlayback.blobUrls.values()) URL.revokeObjectURL(blobUrl);
    progressivePlayback = null;
  }

  function getProgressiveChunkForTime(timeSec) {
    if (!progressivePlayback) return null;
    for (const chunk of progressivePlayback.chunks.values()) {
      if (timeSec >= chunk.startSec && timeSec < chunk.endSec) return chunk;
    }
    return progressivePlayback.chunks.get(progressivePlayback.currentChunkIndex ?? 0) || null;
  }

  function createProgressivePlayback(jobId, generation) {
    cleanupProgressivePlayback();
    progressivePlayback = {
      jobId, generation,
      chunks: new Map(), blobUrls: new Map(), loadingChunks: new Set(),
      currentChunkIndex: null, switchingToChunkIndex: null, started: false,
      _outgoingAudio: null,
    };
  }

  function applyProgressiveChunkMetadata(chunks) {
    if (!progressivePlayback || !Array.isArray(chunks)) return;
    for (const chunk of chunks) progressivePlayback.chunks.set(chunk.index, { ...chunk });
  }

  async function ensureProgressiveChunkLoaded(chunk, generation) {
    if (!progressivePlayback || generation !== processingGeneration) return;
    if (!chunk || !chunk.vocalsUrl) return;
    if (progressivePlayback.blobUrls.has(chunk.index) || progressivePlayback.loadingChunks.has(chunk.index)) return;

    progressivePlayback.loadingChunks.add(chunk.index);
    try {
      const response = await fetchAudioProxy(chunk.vocalsUrl, "");
      const binary = atob(response.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: response.contentType || "audio/wav" });
      const blobUrl = URL.createObjectURL(blob);
      progressivePlayback.blobUrls.set(chunk.index, blobUrl);

      if (!progressivePlayback.started) {
        // First chunk is ready — resume video and start playback
        resumeVideoForPlayback();
        syncProgressivePlaybackState({ forceSwitch: true, forcePlay: true });
      }
    } finally {
      if (progressivePlayback) progressivePlayback.loadingChunks.delete(chunk.index);
    }
  }

  /**
   * Smooth chunk switching with crossfade.
   */
  async function setProgressiveChunkAudio(chunk, options = {}) {
    const playbackState = progressivePlayback;
    if (!playbackState) return false;
    const blobUrl = playbackState.blobUrls.get(chunk.index);
    if (!blobUrl) return false;
    const video = getVideoElement();
    if (!video) return false;

    playbackState.switchingToChunkIndex = chunk.index;

    // --- Crossfade: keep old audio alive briefly ---
    const oldAudio = vocalsAudio;
    const hadOldAudio = !!oldAudio && !oldAudio.paused;

    // Create new audio element
    const newAudio = new Audio();
    newAudio.volume = hadOldAudio ? 0 : 1.0;
    newAudio.preload = "auto";
    newAudio.src = blobUrl;

    await new Promise((resolve, reject) => {
      newAudio.addEventListener("loadedmetadata", resolve, { once: true });
      newAudio.addEventListener("error", () => {
        const mediaErr = newAudio?.error;
        reject(new Error(mediaErr ? `Chunk audio error: code=${mediaErr.code}` : "Chunk audio error"));
      }, { once: true });
      newAudio.load();
    });

    if (progressivePlayback !== playbackState) {
      disposeAudioElement(newAudio);
      return false;
    }

    // Store the ACTUAL audio duration from the decoded audio element
    // This is more accurate than the pre-computed chunk.durationSec
    const actualDuration = (newAudio.duration && isFinite(newAudio.duration))
      ? newAudio.duration : chunk.durationSec;
    const storedChunk = playbackState.chunks.get(chunk.index);
    if (storedChunk) storedChunk._actualDuration = actualDuration;

    // Use actual duration for computing relative time offset
    const effectiveDuration = actualDuration || chunk.durationSec;
    const relativeTime = clampValue(video.currentTime - chunk.startSec, 0, Math.max(0, effectiveDuration - 0.05));

    newAudio.currentTime = relativeTime;
    newAudio.playbackRate = video.playbackRate;

    // Set as active
    vocalsAudio = newAudio;
    playbackState.currentChunkIndex = chunk.index;
    playbackState.started = true;
    silenceOriginalVideo();
    isActive = true;
    startSync();

    if (!video.paused || options.forcePlay) await newAudio.play().catch(() => {});

    // --- Perform crossfade ---
    if (hadOldAudio && oldAudio) {
      const steps = 10;
      const stepMs = CROSSFADE_DURATION_MS / steps;
      playbackState._outgoingAudio = oldAudio;

      for (let i = 1; i <= steps; i++) {
        await sleep(stepMs);
        if (progressivePlayback !== playbackState) break;
        const progress = i / steps;
        try {
          newAudio.volume = Math.min(1, progress);
          oldAudio.volume = Math.max(0, 1 - progress);
        } catch(e) { break; }
      }

      try {
        oldAudio.pause();
        oldAudio.removeAttribute("src");
        oldAudio.load();
      } catch(e) {}
      if (progressivePlayback === playbackState) playbackState._outgoingAudio = null;
    } else {
      newAudio.volume = 1.0;
    }

    if (progressivePlayback === playbackState) {
      playbackState.switchingToChunkIndex = null;
    }
    return true;
  }

  function syncProgressivePlaybackState(options = {}) {
    if (!progressivePlayback) return;
    const video = getVideoElement();
    if (!video) return;

    const targetChunk = getProgressiveChunkForTime(video.currentTime);
    if (!targetChunk) return;

    const shouldSwitch = options.forceSwitch || progressivePlayback.currentChunkIndex !== targetChunk.index;
    if (shouldSwitch) {
      const playbackState = progressivePlayback;
      if (!playbackState) return;
      if (playbackState.switchingToChunkIndex === targetChunk.index) return;
      if (!playbackState.blobUrls.has(targetChunk.index)) return;
      setProgressiveChunkAudio(targetChunk, options).catch(error => {
        if (progressivePlayback === playbackState) playbackState.switchingToChunkIndex = null;
        console.error("[IslamicToolkit] Progressive chunk switch failed:", error);
      });
      return;
    }

    if (!vocalsAudio) return;
    // Use actual audio duration if available for more accurate sync
    const effectiveDuration = targetChunk._actualDuration || targetChunk.durationSec;
    const relativeTime = clampValue(video.currentTime - targetChunk.startSec, 0, Math.max(0, effectiveDuration - 0.05));
    if (Math.abs(vocalsAudio.currentTime - relativeTime) > 0.3) vocalsAudio.currentTime = relativeTime;
    vocalsAudio.playbackRate = video.playbackRate;
    if (!video.paused || options.forcePlay) vocalsAudio.play().catch(() => {});
    else vocalsAudio.pause();
  }

  // ─── Streaming Audio from Proxy (for SoundBoost single-URL fallback) ───

  async function streamAudioFromProxy(audioUrl) {
    const video = getVideoElement();
    if (!video) throw new Error("No video element found");
    updateUI("buffering", tr('connectingStream'));

    const probeResponse = await fetchAudioProxy(audioUrl, "bytes=0-65535");
    const contentType = probeResponse.contentType || "audio/mpeg";
    let totalSize = 0;
    if (probeResponse.contentRange) {
      const match = probeResponse.contentRange.match(/\/(\d+)/);
      if (match) totalSize = parseInt(match[1]);
    }
    if (!totalSize && probeResponse.contentLength) totalSize = parseInt(probeResponse.contentLength);

    updateUI("buffering", tr('downloadingVocals'));
    const chunks = [];
    const CHUNK_SIZE = 512 * 1024;
    let offset = 0;

    if (!totalSize || !probeResponse.acceptRanges) {
      const resp = await fetchAudioProxy(audioUrl, "");
      chunks.push(Uint8Array.from(atob(resp.base64), c => c.charCodeAt(0)));
    } else {
      chunks.push(Uint8Array.from(atob(probeResponse.base64), c => c.charCodeAt(0)));
      offset = chunks[0].length;
      while (offset < totalSize) {
        const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
        const pct = Math.round((offset / totalSize) * 100);
        updateUI("buffering", `${pct}%`);
        const resp = await fetchAudioProxy(audioUrl, `bytes=${offset}-${end}`);
        chunks.push(Uint8Array.from(atob(resp.base64), c => c.charCodeAt(0)));
        offset = end + 1;
      }
    }

    const blob = new Blob(chunks, { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    vocalsAudio = new Audio();
    vocalsAudio.volume = 1.0;
    vocalsAudio.preload = "auto";

    await new Promise((resolve, reject) => {
      vocalsAudio.addEventListener("canplay", () => {
        silenceOriginalVideo();
        isActive = true;
        // Resume video if we paused it
        resumeVideoForPlayback();
        updateUI("active");
        startSync();
        resolve();
      }, { once: true });
      vocalsAudio.addEventListener("error", (e) => {
        reject(new Error(vocalsAudio.error ? `Audio error: code=${vocalsAudio.error.code}` : "Audio load error"));
      }, { once: true });
      vocalsAudio.src = blobUrl;
      vocalsAudio.load();
    });
  }

  // ═══════════════════════════════════════════
  // Activate / Deactivate
  // ═══════════════════════════════════════════

  async function startPlaybackFromJob(snapshot, generation) {
    const vocalsUrl = snapshot?.vocalsUrl;
    if (!vocalsUrl) { stopAllProcessing(true); updateUI("error", "No vocals URL received"); return; }
    updateUI("buffering", snapshot.detail || tr('loadingAudio'));
    try {
      cleanupAudio();
      await streamAudioFromProxy(vocalsUrl);
      if (generation !== processingGeneration) { cleanupAudio(); restoreOriginalVideoState(); return; }
      isProcessing = false;
    } catch (err) {
      if (generation !== processingGeneration) return;
      const ytUrl = getFullYouTubeUrl();
      if (snapshot.fromCache && !currentProcessingForceFresh && !retriedFreshForVideo && ytUrl) {
        retriedFreshForVideo = true;
        isProcessing = false;
        await sendMessage({ type: "INVALIDATE_VOCALS_CACHE", url: ytUrl }).catch(() => {});
        activate({ forceFresh: true });
        return;
      }
      stopAllProcessing(true);
      updateUI("error", err.message);
    }
  }

  async function syncChunkedSnapshot(snapshot, generation) {
    if (!snapshot?.jobId) return;

    if (!progressivePlayback || progressivePlayback.jobId !== snapshot.jobId) {
      cleanupAudio();
      createProgressivePlayback(snapshot.jobId, generation);
    }

    applyProgressiveChunkMetadata(snapshot.chunks);

    const readyChunks = (snapshot.chunks || [])
      .filter(c => c.status === "ready" && c.vocalsUrl)
      .sort((a, b) => a.index - b.index);

    for (const chunk of readyChunks) {
      await ensureProgressiveChunkLoaded(chunk, generation);
    }

    if (progressivePlayback?.started) {
      syncProgressivePlaybackState();
      // Short detail for tooltip
      const readyCount = readyChunks.length;
      const totalCount = snapshot.chunks.length;
      const shortDetail = snapshot.status === "ready" ? "" : `${readyCount}/${totalCount}`;
      updateUI(
        snapshot.status === "ready" ? "active" : "streaming",
        shortDetail
      );
    } else {
      updateUI("processing", snapshot.detail || tr('processing'));
    }
  }

  async function handleJobSnapshot(snapshot, generation) {
    if (generation !== processingGeneration) return;

    if (snapshot?.error && snapshot.status !== "error") {
      stopAllProcessing(true); updateUI("error", snapshot.error); return;
    }
    if (snapshot?.jobId) currentJobId = snapshot.jobId;

    // ─── ALL providers now use chunked progressive playback ───
    if (snapshot?.chunks && snapshot.chunks.length > 0) {
      const isSingleChunkWithUrl = snapshot.chunks.length === 1 &&
        snapshot.chunks[0].vocalsUrl;

      if (isSingleChunkWithUrl && snapshot.status === "ready") {
        clearJobPolling();
        await startPlaybackFromJob({ vocalsUrl: snapshot.chunks[0].vocalsUrl, detail: snapshot.detail }, generation);
        return;
      }

      if (snapshot.status === "error") {
        stopAllProcessing(true);
        updateUI("error", snapshot.error || snapshot.detail || tr('somethingWrong'));
        return;
      }
      if (snapshot.status === "cancelled") {
        stopAllProcessing(false); updateUI("idle"); return;
      }

      if (snapshot.chunks.length > 1 || !isSingleChunkWithUrl) {
        await syncChunkedSnapshot(snapshot, generation);
        if (snapshot.status === "ready") { clearJobPolling(); isProcessing = false; return; }
        scheduleJobPoll(snapshot?.nextPollInMs, generation);
        return;
      }
    }

    // Fallback: non-chunked result
    if (snapshot?.status === "ready") {
      clearJobPolling();
      await startPlaybackFromJob(snapshot, generation);
      return;
    }
    if (snapshot?.status === "error") {
      stopAllProcessing(true);
      updateUI("error", snapshot.error || snapshot.detail || tr('somethingWrong'));
      return;
    }
    if (snapshot?.status === "cancelled") {
      stopAllProcessing(false); updateUI("idle"); return;
    }

    updateUI("processing", snapshot?.detail || tr('processing'));
    scheduleJobPoll(snapshot?.nextPollInMs, generation);
  }

  async function pollProcessingJob(generation) {
    if (generation !== processingGeneration || !currentJobId || !isProcessing) return;
    const snapshot = await sendMessage({
      type: "POLL_PROCESS_YOUTUBE",
      jobId: currentJobId,
      playbackStartSec: getVideoElement()?.currentTime || 0
    });
    await handleJobSnapshot(snapshot, generation);
  }

  async function activate(options = {}) {
    const forceFresh = options.forceFresh === true;
    const video = getVideoElement();
    const ytUrl = getFullYouTubeUrl();
    if (!settingsLoaded || !extensionRuntimeAlive) return;
    if (!video || !ytUrl || !extensionEnabled) return;

    const generation = ++processingGeneration;
    clearJobPolling();
    currentJobId = null;
    currentProcessingForceFresh = forceFresh;
    if (!forceFresh) retriedFreshForVideo = false;

    isProcessing = true;
    updateUI("processing", tr('starting'));
    originalVolume = video.volume;
    originalMuted = video.muted;

    // Pause the video while processing (unless Play Immediately is ON for upload providers)
    pauseVideoForProcessing();

    try {
      const snapshot = await sendMessage({
        type: "START_PROCESS_YOUTUBE",
        url: ytUrl, forceFresh,
        provider: processingProvider,
        chunkDurationSec,
        playbackStartSec: video.currentTime || 0
      });
      await handleJobSnapshot(snapshot, generation);
    } catch (err) {
      if (generation !== processingGeneration) return;
      if (isDisconnectedError(err)) { extensionRuntimeAlive = false; stopAllProcessing(false); return; }
      stopAllProcessing(true);
      updateUI("error", err.message);
    }
  }

  function cleanupAudio() {
    if (vocalsAudio && !progressivePlayback && vocalsAudio.src && vocalsAudio.src.startsWith("blob:")) {
      URL.revokeObjectURL(vocalsAudio.src);
    }
    teardownVocalsAudioElement();
    cleanupProgressivePlayback();
  }

  function deactivate() {
    retriedFreshForVideo = false;
    stopAllProcessing(true);
    updateUI("idle");
  }

  function handleToggle() {
    if (!settingsLoaded || !extensionRuntimeAlive || !extensionEnabled) return;
    if (isProcessing || isActive) deactivate();
    else requestActivation({ source: "manual" });
  }

  // ─── Auto-Start Logic ───

  function tryAutoStart() {
    if (!settingsLoaded || !extensionRuntimeAlive) return;
    if (!autoStartEnabled || !extensionEnabled) return;
    if (isActive || isProcessing || autoStartTriggered) return;
    const videoId = getVideoId();
    if (!videoId) return;
    const video = getVideoElement();
    if (!video) return;
    autoStartTriggered = true;
    requestActivation({ source: "auto" });
  }

  // ─── YouTube Audio Info Extraction ───

  function extractAudioStreamInfo() {
    return new Promise((resolve, reject) => {
      try {
        const video = document.querySelector("video.html5-main-video, video");
        let durationSec = 0;
        if (video && video.duration && isFinite(video.duration)) durationSec = Math.round(video.duration);
        if (!durationSec) {
          const metaDuration = document.querySelector('meta[itemprop="duration"]');
          if (metaDuration) {
            const isoD = metaDuration.getAttribute("content") || "";
            const match = isoD.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (match) durationSec = (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
          }
        }
        if (durationSec > 0) {
          resolve({ durationSec, url: "", mimeType: "audio/mpeg", bitrate: 0, contentLength: "0", approxDurationMs: String(durationSec * 1000) });
        } else {
          setTimeout(() => {
            const v = document.querySelector("video.html5-main-video, video");
            if (v && v.duration && isFinite(v.duration)) {
              resolve({ durationSec: Math.round(v.duration), url: "", mimeType: "audio/mpeg", bitrate: 0, contentLength: "0", approxDurationMs: String(Math.round(v.duration * 1000)) });
            } else {
              reject(new Error("Could not determine video duration"));
            }
          }, 2000);
        }
      } catch (e) { reject(new Error(e.message || "Failed to extract audio info")); }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_YOUTUBE_AUDIO_INFO") {
      extractAudioStreamInfo()
        .then(info => sendResponse(info))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }
  });

  // ─── Status updates from background ───

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SOUNDBOOST_STATUS" || msg.type === "PROCESS_STATUS") {
      const statusMap = { "importing": "processing", "splitting": "processing", "downloading": "buffering", "ready": "buffering", "error": "error", "processing": "processing" };
      const uiState = statusMap[msg.statusType || msg.status] || "processing";
      if (isProcessing) updateUI(uiState, msg.message || msg.detail);
    }
    if (msg.type === "STATE_CHANGED") {
      extensionEnabled = msg.enabled !== false;
      if (!extensionEnabled) {
        if (isActive || isProcessing) deactivate();
        dismissPlaybackPrompt();
      }
      else if (getVideoId()) waitForPlayer(() => ensureUIMounted());
      setUiVisibility();
    }
    if (msg.type === "AUTO_START_CHANGED") {
      autoStartEnabled = msg.autoStart;
      if (autoStartEnabled && !isActive && !isProcessing) { autoStartTriggered = false; tryAutoStart(); }
    }
    if (msg.type === "LANG_CHANGED") {
      currentLang = typeof itkI18n.normalizeLang === "function" ? itkI18n.normalizeLang(msg.lang) : (msg.lang === "ar" ? "ar" : "en");
      refreshLocalizedUiText();
      applyCurrentUiState();
    }
    if (msg.type === "PROCESSING_SETTINGS_CHANGED") {
      processingProvider = normalizeProvider(msg.provider);
      chunkDurationSec = normalizeChunkDurationSec(msg.chunkDurationSec);
      if (playbackPromptElement?.classList.contains("visible") && !shouldPromptForPlaybackChoice()) {
        dismissPlaybackPrompt();
      }
    }
    if (msg.type === "PLAY_IMMEDIATELY_CHANGED") {
      playImmediately = msg.playImmediately === true;
      updatePlaybackPromptButtons();
    }
    if (msg.type === "PLAYBACK_PROMPT_CHANGED") {
      playbackPromptEnabled = msg.playbackPromptEnabled !== false;
      if (!playbackPromptEnabled && playbackPromptElement?.classList.contains("visible")) {
        dismissPlaybackPrompt();
      }
    }
  });

  // ─── Navigation Detection (YouTube SPA) ───

  function onNavigate() {
    const newVideoId = getVideoId();
    if (!newVideoId) {
      clearTimeout(uiRepairDebounce);
      if (overlayElement) { overlayElement.remove(); overlayElement = null; }
      if (btnElement) { btnElement.remove(); }
      btnElement = null;
      dismissBtnElement = null;
      if (playbackPromptElement) { playbackPromptElement.remove(); playbackPromptElement = null; }
      if (statusBarElement) { statusBarElement.remove(); statusBarElement = null; }
      if (isActive || isProcessing) deactivate();
      overlayDismissed = false;
      pendingStartOptions = null;
      currentVideoId = null; autoStartTriggered = false; retriedFreshForVideo = false;
      return;
    }
    if (newVideoId !== currentVideoId) {
      clearTimeout(uiRepairDebounce);
      currentVideoId = newVideoId;
      overlayDismissed = false;
      pendingStartOptions = null;
      autoStartTriggered = false; retriedFreshForVideo = false;
      if (isActive || isProcessing) deactivate();
      waitForPlayer(() => { ensureUIMounted(); tryAutoStart(); });
    }
  }

  function waitForPlayer(callback, attempts = 0) {
    if (attempts > 50) return;
    const playerContainer = getPlayerContainer();
    const leftControls = getLeftControlsContainer();
    if (playerContainer && leftControls) callback();
    else setTimeout(() => waitForPlayer(callback, attempts + 1), 100);
  }

  let navDebounce = null;
  let uiRepairDebounce = null;
  const observer = new MutationObserver(() => {
    const vid = getVideoId();
    if (vid !== currentVideoId) {
      clearTimeout(navDebounce);
      navDebounce = setTimeout(onNavigate, 100);
      return;
    }

    const shouldRepairUi = itkUiHelpers.shouldScheduleUiRepair({
      hasVideoId: Boolean(vid),
      sameVideo: vid === currentVideoId,
      settingsLoaded,
      extensionEnabled,
      hasPlayerContainer: Boolean(getPlayerContainer()),
      hasControlsMount: Boolean(getLeftControlsContainer()),
      btnConnected: Boolean(btnElement?.isConnected),
      statusConnected: Boolean(statusBarElement?.isConnected)
    });

    if (shouldRepairUi) {
      clearTimeout(uiRepairDebounce);
      uiRepairDebounce = setTimeout(() => {
        ensureUIMounted();
      }, 50);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);

  // ─── Init ───
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (resp) => {
    if (chrome.runtime.lastError) {
      if (chrome.runtime.lastError.message && (
        chrome.runtime.lastError.message.includes("Extension context invalidated") ||
        chrome.runtime.lastError.message.includes("Receiving end does not exist")
      )) { extensionRuntimeAlive = false; return; }
      settingsLoaded = true; onNavigate(); return;
    }
    settingsLoaded = true;
    extensionEnabled = resp?.enabled !== false;
    autoStartEnabled = resp?.autoStart === true;
    currentLang = typeof itkI18n.normalizeLang === "function" ? itkI18n.normalizeLang(resp?.lang) : (resp?.lang === "ar" ? "ar" : "en");
    processingProvider = normalizeProvider(resp?.provider);
    chunkDurationSec = normalizeChunkDurationSec(resp?.chunkDurationSec);
    playImmediately = resp?.playImmediately === true;
    playbackPromptEnabled = resp?.playbackPromptEnabled !== false;
    onNavigate();
  });

})();
