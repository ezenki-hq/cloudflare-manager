import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBackendAPI } from "./api";
import { createCommanderBridge } from "./commander";
import { handleChildAction } from "./childWorkflow";
import { BucketSetup } from "./BucketSetup";
import { validateBucketRequest } from "./bucketWorkflow";
import "./styles.css";

const backendOrigin = window.location.origin;
const bridge = createCommanderBridge();
const api = createBackendAPI(backendOrigin, bridge.caller);

const root = createRoot(document.getElementById("root")!);
void (async () => {
  let metadata: unknown;
  let callingManager: string | null = null;
  try {
    [metadata, callingManager] = await Promise.all([bridge.caller.getMetadata(), bridge.caller.getCallingManager()]);
  } catch {
    // The published installer can open before Deploy Commander has attached RPC context.
  }
  if (isRecord(metadata) && typeof metadata.action === "string") {
    let closed = false;
    const close = (response: import("@ezenki/deploy-commander-installer-interface").InterfaceResponse) => {
      if (closed) return;
      closed = true;
      bridge.wire.close(response);
      queueMicrotask(() => bridge.wire.end());
    };
    if (metadata.action === "create-bucket") {
      try {
        const request = await validateBucketRequest(bridge.caller, metadata, callingManager);
        root.render(<BucketSetup request={request} api={api} bridge={bridge} backendOrigin={backendOrigin} onClose={close} />);
      } catch (error) {
        const manager = await bridge.caller.getManager().catch(() => "");
        close({ manager, ok: false, error: { message: error instanceof Error ? error.message : "The bucket request could not be validated" } });
      }
      return;
    }
    if (["create-connection", "link-connection", "unlink-connection", "delete-connection"].includes(metadata.action)) {
      close(await handleChildAction(bridge.caller, api, metadata, callingManager));
      return;
    }
    const manager = await bridge.caller.getManager().catch(() => "");
    close({ manager, ok: false, error: { message: `Unsupported child action: ${metadata.action}`, status: 400 } });
    return;
  }
  root.render(<App bridge={bridge} api={api} backendOrigin={backendOrigin} />);
})();

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
