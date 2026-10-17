import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

const readClientIDQuery = "SELECT cloudflare_client_id FROM manager_settings:current LIMIT 1";
const writeClientIDQuery = "UPSERT manager_settings:current MERGE { cloudflare_client_id: $client_id }";

export async function loadClientID(caller: RPCCaller): Promise<string> {
  const response = await caller.databaseQuery(readClientIDQuery);
  assertStatementsSucceeded(response.results);
  const value = response.results[0]?.result;
  const record = Array.isArray(value) ? value[0] : value;
  if (!record || typeof record !== "object") return "";
  const clientID = (record as Record<string, unknown>).cloudflare_client_id;
  return typeof clientID === "string" ? clientID : "";
}

export async function saveClientID(caller: RPCCaller, clientID: string): Promise<void> {
  if (typeof clientID !== "string" || clientID.trim().length > 512 || /[\r\n]/.test(clientID)) throw new Error("Cloudflare OAuth client ID is invalid");
  const response = await caller.databaseQuery(writeClientIDQuery, { client_id: clientID.trim() });
  assertStatementsSucceeded(response.results);
}

function assertStatementsSucceeded(results: Array<{ statement: number; status: string }>): void {
  if (!results.length || results.some((result) => result.status !== "OK")) throw new Error("Manager settings could not be saved or loaded");
}
