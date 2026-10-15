import { createWire, RPC, type RPCCaller, type RPCResponse, type Wire } from "@ezenki/deploy-commander-installer-interface";

export interface CommanderBridge {
  wire: Wire;
  caller: RPCCaller;
}

export function createCommanderBridge(): CommanderBridge {
  const wire = createWire(async (call) => ({
    ok: false,
    error: { message: `Unsupported manager request: ${call.request}` },
  } satisfies RPCResponse));
  return { wire, caller: RPC.SetupRPCCaller(wire) };
}
