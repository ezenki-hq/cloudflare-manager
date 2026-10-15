import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBackendAPI } from "./api";
import { createCommanderBridge } from "./commander";
import { handleChildAction } from "./childWorkflow";
import "./styles.css";

const backendOrigin = import.meta.env.VITE_BACKEND_ORIGIN?.trim() || window.location.origin;
const bridge = createCommanderBridge();
const api = createBackendAPI(backendOrigin);
const defaults = {
  backendImage: import.meta.env.VITE_BACKEND_IMAGE?.trim() || "ezenki/cloudflare-manager:latest",
  runnerImage: import.meta.env.VITE_RUNNER_IMAGE?.trim() ?? "",
  clientId: import.meta.env.VITE_CF_CLIENT_ID?.trim() ?? "",
  publicOrigin: import.meta.env.VITE_PUBLIC_ORIGIN?.trim() ?? "",
  commanderOrigin: import.meta.env.VITE_COMMANDER_ORIGIN?.trim() || window.location.origin,
};

const root = createRoot(document.getElementById("root")!);
void (async () => {
  try {
    const [metadata, callingManager] = await Promise.all([bridge.caller.getMetadata(), bridge.caller.getCallingManager()]);
    if (isRecord(metadata) && typeof metadata.action === "string" && ["create-connection", "link-connection", "unlink-connection", "delete-connection"].includes(metadata.action)) {
      const response = await handleChildAction(bridge.caller, api, metadata, callingManager);
      bridge.wire.close(response);
      queueMicrotask(() => bridge.wire.end());
      return;
    }
  } catch {
    // The published installer can open before Deploy Commander has attached RPC context.
  }
  root.render(<App bridge={bridge} api={api} backendOrigin={backendOrigin} installDefaults={defaults} />);
})();

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
