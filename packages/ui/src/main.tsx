import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { ErrorBoundary } from "./components/error-boundary";
import "./index.css";

// biome-ignore lint/style/noNonNullAssertion: #app is guaranteed in index.html
createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
