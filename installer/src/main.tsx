import { createRoot } from "react-dom/client";
import { createCommanderBridge } from "./commander";
import { InstallApp } from "./InstallApp";
import type { InstallInput } from "./installer";
import "./styles.css";

const bridge = createCommanderBridge();
const defaults: InstallInput = {
  backendImage: import.meta.env.VITE_BACKEND_IMAGE?.trim() || "ezenki/cloudflare-manager:latest",
  runnerImage: import.meta.env.VITE_RUNNER_IMAGE?.trim() ?? "",
  clientId: import.meta.env.VITE_CF_CLIENT_ID?.trim() ?? "",
  publicOrigin: import.meta.env.VITE_PUBLIC_ORIGIN?.trim() ?? "",
  commanderOrigin: import.meta.env.VITE_COMMANDER_ORIGIN?.trim() || window.location.origin,
};

createRoot(document.getElementById("root")!).render(<InstallApp bridge={bridge} defaults={defaults} />);
