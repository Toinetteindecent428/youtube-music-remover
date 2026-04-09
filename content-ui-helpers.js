(() => {
  "use strict";

  function shouldRecreateUi({
    hasPlayerContainer,
    hasControlsMount = true,
    btnConnected,
    statusConnected
  }) {
    if (!hasPlayerContainer) return false;
    if (!hasControlsMount) return false;
    if (!btnConnected) return true;
    if (!statusConnected) return true;
    return false;
  }

  function shouldScheduleUiRepair({
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

    return shouldRecreateUi({
      hasPlayerContainer,
      hasControlsMount,
      btnConnected,
      statusConnected
    });
  }

  function shouldPromptForPlaybackChoice({
    playbackPromptEnabled,
    supportsPlaybackPrompt
  }) {
    return playbackPromptEnabled === true && supportsPlaybackPrompt === true;
  }

  function getDirectChildAnchor(container, candidate) {
    if (!container || !candidate || candidate === container) return null;

    let current = candidate;
    while (current && current.parentElement && current.parentElement !== container) {
      current = current.parentElement;
    }

    if (current && current.parentElement === container) {
      return current;
    }

    return null;
  }

  globalThis.ItkUiHelpers = {
    getDirectChildAnchor,
    shouldPromptForPlaybackChoice,
    shouldRecreateUi,
    shouldScheduleUiRepair
  };
})();
