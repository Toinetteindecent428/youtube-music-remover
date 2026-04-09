import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");
const i18nPath = path.join(projectRoot, "i18n.js");
const manifestPath = path.join(projectRoot, "manifest.json");

function loadI18n() {
  const source = fs.readFileSync(i18nPath, "utf8");
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: i18nPath });
  return context.globalThis.ITK_I18N;
}

function hasArabicScript(value) {
  return /[\u0600-\u06FF]/.test(value);
}

test("shared i18n helpers are exposed globally", () => {
  const i18n = loadI18n();
  assert.ok(i18n);
  assert.equal(typeof i18n.getTranslations, "function");
  assert.equal(typeof i18n.t, "function");
});

test("arabic translations cover popup and in-player prompt text", () => {
  const i18n = loadI18n();

  assert.equal(hasArabicScript(i18n.t("enabled", "ar")), true);
  assert.equal(hasArabicScript(i18n.t("playbackPromptTitle", "ar")), true);
  assert.equal(hasArabicScript(i18n.t("askBeforeStart", "ar")), true);
  assert.equal(hasArabicScript(i18n.t("usingCache", "ar")), true);
  assert.equal(hasArabicScript(i18n.t("directLinkProviderWarning", "ar")), true);
});

test("english translations include playback prompt and direct-link warning content", () => {
  const i18n = loadI18n();

  assert.match(i18n.t("playbackPromptTitle", "en"), /playback/i);
  assert.match(i18n.t("askBeforeStart", "en"), /ask/i);
  assert.match(i18n.t("directLinkProviderWarning", "en"), /direct video link/i);
});

test("manifest is wired for Chrome locale resources and shared content scripts", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const contentScript = manifest.content_scripts?.[0];

  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extName__");
  assert.equal(manifest.description, "__MSG_extDesc__");
  assert.deepEqual(contentScript.js, [
    "content-ui-helpers.js",
    "provider-catalog.js",
    "i18n.js",
    "content.js"
  ]);
});

test("locale message files exist for english and arabic", () => {
  const enLocalePath = path.join(projectRoot, "_locales", "en", "messages.json");
  const arLocalePath = path.join(projectRoot, "_locales", "ar", "messages.json");

  assert.equal(fs.existsSync(enLocalePath), true);
  assert.equal(fs.existsSync(arLocalePath), true);
});
