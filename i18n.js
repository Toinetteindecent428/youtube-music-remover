// Islamic Toolkit - Internationalization (English / Arabic)
const TRANSLATIONS = {
  en: {
    extName: "Islamic Toolkit - Music Remover",
    extDesc: "Removes background music from YouTube videos, leaving only vocals and speech. Now with streaming playback — no more waiting for full downloads!",
    enabled: "Extension Enabled",
    autoStart: "Auto-Start on Page Load",
    autoStartDesc: "Automatically removes music when you open a YouTube video",
    howItWorks: "How it works",
    step1: "Navigate to any YouTube video",
    step2_auto: "Music removal starts automatically!",
    step2_manual: "Click the \ud83c\udfb5 button on the video player",
    step3: "AI separates vocals from music",
    step4: "Audio streams in — starts playing instantly!",
    poweredBy: "Developed by",
    developerName: "Islamic Toolkit",
    version: "v2.1 ⚡",
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
    importingAudio: "Importing audio... ({n})",
    startingSeparation: "Starting stem separation...",
    separatingVocals: "Separating vocals from music... ({n})",
    importingTrack: "Importing YouTube track...",
    waitingImport: "Waiting for import...",
    separatingFromMusic: "Separating vocals from music...",
    vocalsReady: "Vocals ready — starting playback!",
    usingCache: "Using cached result",
    language: "Language",
    langEn: "English",
    langAr: "العربية"
  },
  ar: {
    extName: "أدوات إسلامية - مزيل الموسيقى",
    extDesc: "يزيل الموسيقى الخلفية من فيديوهات يوتيوب، ويبقي فقط الأصوات والكلام. الآن مع تشغيل متدفق — لا مزيد من الانتظار!",
    enabled: "الإضافة مفعّلة",
    autoStart: "بدء تلقائي عند فتح الصفحة",
    autoStartDesc: "يزيل الموسيقى تلقائياً عند فتح فيديو يوتيوب",
    howItWorks: "كيف يعمل",
    step1: "انتقل إلى أي فيديو على يوتيوب",
    step2_auto: "تتم إزالة الموسيقى تلقائياً!",
    step2_manual: "انقر على زر \ud83c\udfb5 في مشغّل الفيديو",
    step3: "يفصل الذكاء الاصطناعي الأصوات عن الموسيقى",
    step4: "يبدأ تشغيل الصوت فوراً!",
    poweredBy: "تطوير",
    developerName: "أدوات إسلامية",
    version: "v2.1 ⚡",
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
    importingAudio: "جارٍ استيراد الصوت... ({n})",
    startingSeparation: "جارٍ بدء فصل المسارات...",
    separatingVocals: "جارٍ فصل الأصوات عن الموسيقى... ({n})",
    importingTrack: "جارٍ استيراد مقطع يوتيوب...",
    waitingImport: "في انتظار الاستيراد...",
    separatingFromMusic: "جارٍ فصل الأصوات عن الموسيقى...",
    vocalsReady: "الأصوات جاهزة — جارٍ بدء التشغيل!",
    usingCache: "استخدام النتيجة المخزنة",
    language: "اللغة",
    langEn: "English",
    langAr: "العربية"
  }
};

function getTranslations(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

// Helper to replace placeholders like {pct} or {n}
function t(key, lang, replacements) {
  const strings = getTranslations(lang);
  let str = strings[key] || TRANSLATIONS.en[key] || key;
  if (replacements) {
    for (const [k, v] of Object.entries(replacements)) {
      str = str.replace(new RegExp("\\{" + k + "\\}", "g"), v);
    }
  }
  return str;
}
