import React from "react";
import ReactDOM from "react-dom/client";
// F5.1 — initialise i18n BEFORE the App tree mounts so the first render
// already has the correct locale + dir on <html>. The module has side
// effects (calls i18next.init + sets document.dir).
import "./i18n";
// F5.3 + F5.4 + F5.5 — global stylesheets for RTL logical properties,
// Heebo font face, and the responsive breakpoints that linearise the
// kiosk stage on mobile.
import "./styles/rtl.css";
import "./styles/responsive.css";
import App from "./app.jsx";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
