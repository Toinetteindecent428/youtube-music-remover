import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const helperPath = path.join(__dirname, "..", "content-ui-helpers.js");
const helperSource = fs.readFileSync(helperPath, "utf8");

const context = { globalThis: {} };
vm.runInNewContext(helperSource, context, { filename: helperPath });

const {
  getDirectChildAnchor,
  shouldPromptForPlaybackChoice,
  shouldRecreateUi,
  shouldScheduleUiRepair
} = context.globalThis.ItkUiHelpers;

test("recreates the UI when the toolbar button is missing", () => {
  assert.equal(shouldRecreateUi({
    hasControlsMount: true,
    hasPlayerContainer: true,
    btnConnected: false,
    statusConnected: true
  }), true);
});

test("recreates the UI when the status bar is missing from an active player", () => {
  assert.equal(shouldRecreateUi({
    hasControlsMount: true,
    hasPlayerContainer: true,
    btnConnected: true,
    statusConnected: false
  }), true);
});

test("does not recreate the UI when both mounts are still connected", () => {
  assert.equal(shouldRecreateUi({
    hasControlsMount: true,
    hasPlayerContainer: true,
    btnConnected: true,
    statusConnected: true
  }), false);
});

test("schedules a repair only for the current enabled video page", () => {
  assert.equal(shouldScheduleUiRepair({
    hasVideoId: true,
    sameVideo: true,
    settingsLoaded: true,
    extensionEnabled: true,
    hasControlsMount: true,
    hasPlayerContainer: true,
    btnConnected: false,
    statusConnected: true
  }), true);
});

test("skips repair when the extension is disabled or the page context changed", () => {
  assert.equal(shouldScheduleUiRepair({
    hasVideoId: true,
    sameVideo: true,
    settingsLoaded: true,
    extensionEnabled: false,
    hasControlsMount: true,
    hasPlayerContainer: true,
    btnConnected: false,
    statusConnected: true
  }), false);

  assert.equal(shouldScheduleUiRepair({
    hasVideoId: true,
    sameVideo: false,
    settingsLoaded: true,
    extensionEnabled: true,
    hasControlsMount: true,
    hasPlayerContainer: true,
    btnConnected: false,
    statusConnected: true
  }), false);
});

test("only prompts for playback choice when the provider supports it", () => {
  assert.equal(shouldPromptForPlaybackChoice({
    playbackPromptEnabled: true,
    supportsPlaybackPrompt: true
  }), true);

  assert.equal(shouldPromptForPlaybackChoice({
    playbackPromptEnabled: true,
    supportsPlaybackPrompt: false
  }), false);

  assert.equal(shouldPromptForPlaybackChoice({
    playbackPromptEnabled: false,
    supportsPlaybackPrompt: true
  }), false);
});

test("resolves a nested candidate to the direct child anchor", () => {
  const nested = { parentElement: null };
  const wrapper = { parentElement: null };
  const container = { parentElement: null };
  nested.parentElement = wrapper;
  wrapper.parentElement = container;

  assert.equal(getDirectChildAnchor(container, nested), wrapper);
  assert.equal(getDirectChildAnchor(container, wrapper), wrapper);
  assert.equal(getDirectChildAnchor(container, null), null);
});
