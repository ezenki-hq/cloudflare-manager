import { getDomain } from "tldts";
import type { RPCCaller, StartRunOptions } from "@ezenki/deploy-commander-installer-interface";

export interface StartResponse {
  id: string;
  queued_at: string;
  status: number;
}

export interface InstallInput {
  backendImage: string;
  runnerImage: string;
  clientId: string;
  publicOrigin: string;
  commanderOrigin: string;
}

export function buildInstallRun(input: InstallInput & { managerId: string }): StartRunOptions {
  const managerId = requireString(input.managerId, "manager ID");
  requireImmutableImage(input.backendImage, "backend image");
  requireImmutableImage(input.runnerImage, "runner image");
  requireString(input.clientId, "Cloudflare OAuth client ID");
  validateSameSiteOrigins(input.publicOrigin, input.commanderOrigin);
  const alias = `cloudflare-manager-${managerId}`;
  const metadata = {
    services: {
      "cloudflare-manager": {
        image: input.backendImage,
        aliases: [alias],
        connections: [{ type: "Platform", data: { network: "manager" } }],
        environment: {
          CF_CLIENT_ID: input.clientId,
          PUBLIC_ORIGIN: input.publicOrigin,
          COMMANDER_ORIGIN: input.commanderOrigin,
          PORT: "8080",
          STATIC_DIR: "/app/frontend/dist",
        },
        health_check: {
          test: ["CMD", "/app/cloudflare-manager", "healthcheck"],
          interval_seconds: 10,
          timeout_seconds: 3,
          start_period_seconds: 15,
          retries: 3,
          wait_timeout_seconds: 180,
        },
      },
    },
    redirect: { redirect: `http://${alias}:8080` },
  };
  return { action: "install", runner: input.runnerImage, platform: "docker", metadata, note: "Install Cloudflare Manager" };
}

export async function startInstall(caller: RPCCaller, input: InstallInput): Promise<StartResponse> {
  await ensureNoActiveRun(caller, ["install", "teardown"]);
  const managerId = await caller.getManager();
  return caller.start(buildInstallRun({ ...input, managerId }));
}

export async function ensureNoActiveRun(caller: RPCCaller, actions: string[]): Promise<void> {
  for (const action of actions) {
    const run = await caller.getLatestRun({ action });
    if (run && (run.status === 0 || run.status === 1)) throw new Error(`A ${action} run is already queued or running`);
    if (action === "install" && run?.status === 2) throw new Error("Cloudflare Manager is already installed; use teardown to remove it");
  }
}

function validateSameSiteOrigins(publicOrigin: string, commanderOrigin: string): void {
  const publicURL = parseHTTPSOrigin(publicOrigin, "public origin");
  const commanderURL = parseHTTPSOrigin(commanderOrigin, "Commander origin");
  const publicSite = getDomain(publicURL.hostname);
  const commanderSite = getDomain(commanderURL.hostname);
  if (!publicSite || !commanderSite || publicSite !== commanderSite) throw new Error("Manager and Commander origins must use the same HTTPS site");
}

function parseHTTPSOrigin(value: string, label: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTPS origin`); }
  if (parsed.protocol !== "https:" || parsed.origin !== value.replace(/\/$/, "") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTPS origin without a path`);
  }
  return parsed;
}

function requireImmutableImage(value: string, label: string): void {
  if (!value.trim() || /\s/.test(value)) throw new Error(`${label} is required`);
  if (/@sha256:[a-f0-9]{64}$/.test(value)) return;
  const lastPart = value.slice(value.lastIndexOf("/") + 1);
  const separator = lastPart.lastIndexOf(":");
  if (separator <= 0 || lastPart.slice(separator + 1) === "latest") throw new Error(`${label} must use a version tag or SHA-256 digest`);
}

function requireString(value: string, label: string): string {
  const result = value.trim();
  if (!result || /[\r\n]/.test(result)) throw new Error(`${label} is required`);
  return result;
}
