import { createRoot } from "react-dom/client";
import { createCommanderBridge } from "./commander";
import { InstallApp } from "./InstallApp";
import type { InstallInput } from "./installer";
import "./styles.css";

const bridge = createCommanderBridge();
const defaults: InstallInput = {
  backendImage: import.meta.env.VITE_BACKEND_IMAGE?.trim() || "ezenki/cloudflare-manager:latest",
  runnerImage: import.meta.env.VITE_RUNNER_IMAGE?.trim() || "ezenki/deploy-commander-runner@sha256:d3bdcc6470a469ca8344310e94292743e0020ef16bc097b6e9cc8b64d6c347c8",
};

createRoot(document.getElementById("root")!).render(<InstallApp bridge={bridge} defaults={defaults} />);
