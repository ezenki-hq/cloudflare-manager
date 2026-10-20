import { createRoot } from "react-dom/client";
import { createCommanderBridge } from "./commander";
import { InstallApp } from "./InstallApp";
import type { InstallInput } from "./installer";
import "./styles.css";

const bridge = createCommanderBridge();
const defaults: InstallInput = {
  backendImage: import.meta.env.VITE_BACKEND_IMAGE?.trim() || "ezenki/cloudflare-manager:latest",
  stateTTLImage: import.meta.env.VITE_STATE_TTL_IMAGE?.trim() || "ezenki/cloudflare-manager-state-ttl:latest",
  runnerImage: import.meta.env.VITE_RUNNER_IMAGE?.trim() || "ezenki/deploy-commander-runner:latest",
};

createRoot(document.getElementById("root")!).render(<InstallApp bridge={bridge} defaults={defaults} />);
