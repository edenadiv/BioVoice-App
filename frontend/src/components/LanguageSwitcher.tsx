// F5.1 — language switcher rendered in the kiosk chrome (top-right of
// the sidebar). Two-button toggle so an operator can flip languages
// without reaching for browser settings. The persisted preference + the
// document.dir flip live in `i18n/index.ts`; this component only fires
// the change.

import { useTranslation } from "react-i18next";
import { changeLanguage, currentLanguage, SUPPORTED_LANGUAGES, type Language } from "../i18n";

const LABELS: Record<Language, string> = {
  en: "EN",
  he: "עב",
};

export function LanguageSwitcher({ className }: { className?: string }) {
  // useTranslation gives us re-render on language change.
  const { i18n } = useTranslation();
  const active = (i18n.language as Language) ?? currentLanguage();

  return (
    <div
      role="group"
      aria-label="Language"
      className={className}
      style={{
        display: "inline-flex",
        gap: 4,
        padding: 2,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 999,
      }}
    >
      {SUPPORTED_LANGUAGES.map((lang) => {
        const isActive = lang === active;
        return (
          <button
            key={lang}
            type="button"
            onClick={() => {
              if (!isActive) void changeLanguage(lang);
            }}
            aria-pressed={isActive}
            style={{
              minHeight: 32,
              minWidth: 36,
              padding: "4px 10px",
              borderRadius: 999,
              border: "none",
              background: isActive ? "rgba(120, 200, 255, 0.18)" : "transparent",
              color: isActive ? "#dff" : "rgba(255,255,255,0.66)",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              letterSpacing: "0.16em",
              cursor: isActive ? "default" : "pointer",
            }}
          >
            {LABELS[lang]}
          </button>
        );
      })}
    </div>
  );
}
