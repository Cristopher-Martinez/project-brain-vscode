import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { AppProvider } from "./store/AppContext";
import { postMessage } from "./vscode";

// Global error handler for debugging
window.onerror = (msg, _src, line, col) => {
  postMessage({ type: "webviewError", error: `JS Error: ${msg} at line ${line}:${col}` });
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
