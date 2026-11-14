import "./styles/app.css";
import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { configureClient } from "./lib/api/client";
import { config } from "./lib/config";
import { initTheme } from "./lib/theme";
import { initTextSize } from "./lib/textSize";
import { initDesktop } from "./lib/desktop";
import { initAnalytics } from "./lib/analytics";
import { wireUpgradePrompts } from "./lib/upgrade";
import { router } from "./router";

configureClient({ baseUrl: config.apiUrl });
initDesktop();
initTheme();
initTextSize();
wireUpgradePrompts();

// Mock mode is a build-time constant, written inline so the bundler drops this
// branch, and the mock chunk with it, from production builds.
if (import.meta.env.VITE_MOCK === "1") {
  const { installMock } = await import("./mock");
  installMock();
}

void initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
