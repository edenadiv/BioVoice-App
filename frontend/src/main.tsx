import React from "react";
import ReactDOM from "react-dom/client";
// Mobile breakpoints + WCAG touch targets (not i18n-coupled).
import "./styles/responsive.css";
import App from "./app.jsx";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
