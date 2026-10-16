import { getDomain } from "tldts";
import type { RPCCaller, RunItem, StartRunOptions } from "@ezenki/deploy-commander-installer-interface";

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
  requireImageReference(input.backendImage, "backend image", true);
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

export type InstallationState = "ready" | "installing" | "installed" | "tearing-down";

export function installationState(install: RunItem | null, teardown: RunItem | null): InstallationState {
  if (isActive(teardown?.status)) return "tearing-down";
  if (isActive(install?.status)) return "installing";
  if (!install || install.status !== 2) return "ready";
  if (!teardown || teardown.status !== 2) return "installed";

  const installTime = parseRunTime(install);
  const teardownTime = parseRunTime(teardown);
  if (installTime === teardownTime) throw new Error("Install and teardown run timestamps are ambiguous");
  return teardownTime > installTime ? "ready" : "installed";
}

export async function startInstall(caller: RPCCaller, input: InstallInput): Promise<StartResponse> {
  const [install, teardown] = await Promise.all([
    caller.getLatestRun({ action: "install" }),
    caller.getLatestRun({ action: "teardown" }),
  ]);
  const state = installationState(install, teardown);
  if (state === "installing") throw new Error("An install run is already queued or running");
  if (state === "tearing-down") throw new Error("A teardown run is already queued or running");
  if (state === "installed") throw new Error("Cloudflare Manager is already installed; use teardown to remove it");
  const managerId = await caller.getManager();
  return caller.start(buildInstallRun({ ...input, managerId }));
}

function isActive(status: number | undefined): boolean {
  return status === 0 || status === 1;
}

function parseRunTime(run: RunItem): number {
  const timestamp = Date.parse(run.queued_at);
  if (!Number.isFinite(timestamp)) throw new Error("Install and teardown run timestamps are invalid");
  return timestamp;
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
  requireImageReference(value, label, false);
}

function requireImageReference(value: string, label: string, allowLatest: boolean): void {
  if (!value.trim() || /\s/.test(value)) throw new Error(`${label} is required`);
  if (/@sha256:[a-f0-9]{64}$/.test(value)) return;
  const lastPart = value.slice(value.lastIndexOf("/") + 1);
  const separator = lastPart.lastIndexOf(":");
  if (separator <= 0 || (!allowLatest && lastPart.slice(separator + 1) === "latest")) throw new Error(`${label} must use a version tag or SHA-256 digest`);
}

function requireString(value: string, label: string): string {
  const result = value.trim();
  if (!result || /[\r\n]/.test(result)) throw new Error(`${label} is required`);
  return result;
}
