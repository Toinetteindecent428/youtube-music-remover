import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const catalogPath = path.join(__dirname, "..", "provider-catalog.js");
const catalogSource = fs.readFileSync(catalogPath, "utf8");

const context = { globalThis: {} };
vm.runInNewContext(catalogSource, context, { filename: catalogPath });

const providers = context.globalThis.ITK_PROVIDERS;

test("provider catalog exposes direct-link and upload-audio definitions", () => {
  assert.equal(providers.getProviderDefinition("soundboost").pipelineType, "direct_link");
  assert.equal(providers.getProviderDefinition("removeMusic").pipelineType, "upload_audio");
});

test("provider capabilities are derived from the shared catalog", () => {
  assert.equal(providers.providerSupportsChunkDuration("soundboost"), false);
  assert.equal(providers.providerSupportsPlaybackPrompt("soundboost"), true);
  assert.equal(providers.getProviderSelectionWarningKey("soundboost"), "directLinkProviderWarning");

  assert.equal(providers.providerSupportsChunkDuration("removeMusic"), true);
  assert.equal(providers.providerSupportsPlaybackPrompt("removeMusic"), true);
  assert.equal(providers.getProviderSelectionWarningKey("removeMusic"), null);
});

test("unknown providers fall back to the default provider", () => {
  assert.equal(providers.normalizeProviderId("future-provider"), providers.DEFAULT_PROVIDER_ID);
  assert.equal(providers.getProviderDefinition("future-provider").id, providers.DEFAULT_PROVIDER_ID);
});

test("job reuse keys ignore chunk duration for direct-link providers", () => {
  const keyA = providers.getProviderJobReuseKey({
    providerId: "soundboost",
    youtubeUrl: "https://www.youtube.com/watch?v=abc",
    chunkDurationSec: 10
  });
  const keyB = providers.getProviderJobReuseKey({
    providerId: "soundboost",
    youtubeUrl: "https://www.youtube.com/watch?v=abc",
    chunkDurationSec: 60
  });

  assert.equal(keyA, keyB);
});

test("job reuse keys keep chunk duration for upload-audio providers", () => {
  const keyA = providers.getProviderJobReuseKey({
    providerId: "removeMusic",
    youtubeUrl: "https://www.youtube.com/watch?v=abc",
    chunkDurationSec: 10
  });
  const keyB = providers.getProviderJobReuseKey({
    providerId: "removeMusic",
    youtubeUrl: "https://www.youtube.com/watch?v=abc",
    chunkDurationSec: 60
  });

  assert.notEqual(keyA, keyB);
});
