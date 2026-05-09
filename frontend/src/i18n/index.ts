// F5.1 — i18next setup. Initialised once at module load; consumed by
// `useTranslation()` in every component that surfaces user-facing copy.
//
// Lookup precedence:
//   1. ?lang=xx URL query (operator override at the kiosk).
//   2. Persisted `localStorage` preference (last selection wins).
//   3. Browser `navigator.language`.
//   4. Default: English.
//
// The persisted preference + URL override mean a Hebrew-speaking
// operator can pin the kiosk to RTL once and it stays that way across
// reboots. The two reads happen in the order above so a query string can
// re-override a stale preference (useful for QA via deep link).
//
// On every language change we mirror to <html lang="…" dir="…"> so CSS
// logical properties + the global font swap react automatically. See
// `styles/rtl.css` (F5.3) and `styles/responsive.css` (F5.5).

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import he from "./he.json";

export const SUPPORTED_LANGUAGES = ["en", "he"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
const STORAGE_KEY = "biovoice_language";

function detectInitialLanguage(): Language {
  const fromQuery = new URLSearchParams(window.location.search).get("lang");
  if (fromQuery && SUPPORTED_LANGUAGES.includes(fromQuery as Language)) {
    return fromQuery as Language;
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LANGUAGES.includes(stored as Language)) {
    return stored as Language;
  }
  const browser = navigator.language.split("-")[0];
  if (SUPPORTED_LANGUAGES.includes(browser as Language)) {
    return browser as Language;
  }
  return "en";
}

const initialLanguage = detectInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    he: { translation: he },
  },
  lng: initialLanguage,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // react already escapes
  },
});

applyDocumentDirection(initialLanguage);
i18n.on("languageChanged", (lng) => {
  if (SUPPORTED_LANGUAGES.includes(lng as Language)) {
    window.localStorage.setItem(STORAGE_KEY, lng);
    applyDocumentDirection(lng as Language);
  }
});

function applyDocumentDirection(lang: Language): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  // F5.4 — swap the body font family so Hebrew text uses Heebo and
  // Latin text falls back to Sora. The CSS sets up both font-faces;
  // here we only flip a class so the cascade picks the right one.
  document.documentElement.classList.toggle("rtl", lang === "he");
}

export function changeLanguage(lang: Language): Promise<unknown> {
  return i18n.changeLanguage(lang);
}

export function currentLanguage(): Language {
  return (i18n.language as Language) ?? "en";
}

export default i18n;
