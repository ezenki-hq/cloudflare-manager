import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

export interface ManagerSettings { cloudflareClientId: string; jwtSecret: string }
const selectQuery = "SELECT cloudflare_client_id, jwt_secret FROM manager_settings:current LIMIT 1";
const saveQuery = "UPSERT manager_settings:current MERGE { cloudflare_client_id: $client_id }";

export async function loadManagerSettings(caller: RPCCaller): Promise<ManagerSettings> {
  const response = await caller.databaseQuery(selectQuery);
  assertOK(response.results);
  const value = response.results[0]?.result;
  const record = Array.isArray(value) ? value[0] : value;
  const row = record && typeof record === "object" ? record as Record<string, unknown> : {};
  return { cloudflareClientId: typeof row.cloudflare_client_id === "string" ? row.cloudflare_client_id.trim() : "", jwtSecret: typeof row.jwt_secret === "string" ? row.jwt_secret : "" };
}

export async function saveCloudflareClientID(caller: RPCCaller, value: string): Promise<void> {
  if (typeof value !== "string" || value.trim().length > 512 || /[\r\n]/.test(value)) throw new Error("Cloudflare OAuth client ID is invalid");
  const response = await caller.databaseQuery(saveQuery, { client_id: value.trim() });
  assertOK(response.results);
}

function assertOK(results: Array<{ status: string }>): void {
  if (!results.length || results.some((statement) => statement.status !== "OK")) throw new Error("Manager settings could not be loaded or saved");
}
