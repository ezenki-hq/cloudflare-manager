import { createWire, RPC, type Events, type RPCCaller, type RPCResponse, type Wire } from "@ezenki/deploy-commander-installer-interface";

export type InterfaceEvent = Events.InterfaceEvent;

export interface CommanderBridge {
  wire: Wire;
  caller: RPCCaller;
  onEvent(handler: (event: InterfaceEvent) => void): () => void;
}

export function createCommanderBridge(): CommanderBridge {
  const listeners = new Set<(event: InterfaceEvent) => void>();
  const wire = createWire(async (call) => ({
    ok: false,
    error: { message: `Unsupported manager request: ${call.request}` },
  } satisfies RPCResponse), (event) => listeners.forEach((listener) => listener(event)));
  return {
    wire,
    caller: RPC.SetupRPCCaller(wire),
    onEvent(handler) { listeners.add(handler); return () => listeners.delete(handler); },
  };
}
