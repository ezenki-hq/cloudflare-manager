import type { RPCCaller, Wire } from "@ezenki/deploy-commander-installer-interface";

export interface CommanderConnection {
  resourceId: string;
  connectionId: string;
  managerAPI: string;
}

const passwordSecret = "COMMANDER_PASSWORD";

export async function resolveCommanderConnection(caller: RPCCaller, wire: Wire, managerId: string): Promise<CommanderConnection> {
  const commanderManagers = await caller.getManagers({ name: "commander", kind: "commander", limit: 100, offset: 0 });
  if (commanderManagers.items.length !== 1) throw new Error("Expected exactly one reserved Commander manager");
  const commanderManagerId = commanderManagers.items[0].id;
  if (!commanderManagerId) throw new Error("Commander manager identity is missing");
  const resources = await caller.getResources({ type: "commander", manager: commanderManagerId, limit: 100, offset: 0 });
  if (resources.items.length !== 1) throw new Error("Expected exactly one reserved Commander resource");
  const resourceId = resources.items[0].id;
  const detail = await caller.getResource(resourceId);
  if (detail.resource.id !== resourceId || detail.resource.manager !== commanderManagerId || detail.resource.type !== "commander") {
    throw new Error("Commander resource identity does not match its manager");
  }
  const managerAPI = managerAPIURL(detail.config.metadata?.manager_api);
  const existing = await caller.getConnections({ manager: managerId, resource: resourceId, limit: 100, offset: 0 });
  if (existing.items.length > 1) throw new Error("Multiple Cloudflare Manager connections to Commander were found");
  let connectionId: string;
  if (existing.items.length === 1) {
    const connection = existing.items[0];
    const saved = await caller.getConnection(connection.id);
    if (saved.connection.id !== connection.id || saved.connection.manager !== managerId || saved.connection.resource !== resourceId) {
      throw new Error("Existing Commander connection identity is invalid");
    }
    const savedAPI = saved.config.metadata?.manager_api;
    if (savedAPI !== undefined && managerAPIURL(savedAPI) !== managerAPI) throw new Error("Existing Commander connection API metadata does not match the resource");
    connectionId = connection.id;
  } else {
    const password = randomPassword();
    const child = await wire.startInterface({ manager: commanderManagerId, metadata: { action: "create-connection", metadata: { createUser: { password } } } });
    const result = await child.close;
    if (!result.ok) throw new Error(result.error?.message || "Commander connection approval was denied");
    const value = result.result as { connection?: { id?: string; manager?: string; resource?: string } } | undefined;
    const connection = value?.connection;
    if (!connection?.id || connection.manager !== managerId || connection.resource !== resourceId) {
      throw new Error("Approved Commander connection identity does not match the request");
    }
    connectionId = connection.id;
    await caller.setSecret("connection", connectionId, passwordSecret, password);
  }
  const keys = await caller.getSecretKeys("connection", connectionId);
  if (!keys.some(({ key }) => key === passwordSecret)) throw new Error("Commander connection is missing its COMMANDER_PASSWORD secret; repair or recreate it before installing");
  return { resourceId, connectionId, managerAPI };
}

export function managerAPIURL(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Commander resource is missing manager_api metadata");
  const metadata = value as { host?: unknown; port?: unknown; tls?: unknown };
  if (typeof metadata.host !== "string" || !metadata.host.trim() || /[\s/@?#]/.test(metadata.host)) throw new Error("Commander manager_api host is invalid");
  const port = metadata.port === undefined ? 6080 : metadata.port;
  const tls = metadata.tls === undefined ? false : metadata.tls;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || typeof tls !== "boolean") throw new Error("Commander manager_api port or TLS setting is invalid");
  const host = metadata.host.includes(":") && !metadata.host.startsWith("[") ? `[${metadata.host}]` : metadata.host;
  return `${tls ? "https" : "http"}://${host}:${port}/api/v1`;
}

function randomPassword(): string {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure browser randomness is unavailable");
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
