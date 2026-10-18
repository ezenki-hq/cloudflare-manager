import type { RPCCaller, RunItem, StartRunOptions } from "@ezenki/deploy-commander-installer-interface";
import { inspectCommanderConnection, type CommanderConnection } from "./commanderConnection";

export interface StartResponse { id: string; queued_at: string; status: number }
export interface InstallInput { backendImage: string; runnerImage: string }

export function buildInstallRun(input: InstallInput & { managerId: string; commander: CommanderConnection }): StartRunOptions {
  const managerId = requireString(input.managerId, "manager ID");
  requireImageReference(input.backendImage, "backend image", true);
  requireImageReference(input.runnerImage, "runner image", false);
  const { resourceId, connectionId, managerAPI } = input.commander;
  requireString(resourceId, "Commander resource ID"); requireString(connectionId, "Commander connection ID"); requireString(managerAPI, "Commander API URL");
  const alias = `cloudflare-manager-${managerId}`;
  const metadata = {
    values_version: 1,
    services: {
      "generate-jwt-secret": {
        image: input.backendImage,
        role: "runner",
        command: ["generate-jwt-secret"],
        capture_variables: [{ stream: "stdout", pattern: "(?P<JWT_SECRET>[A-Za-z0-9_-]{43})" }],
        stream_output: false,
      },
      "cloudflare-manager": {
        image: input.backendImage,
        aliases: [alias],
        depends_on: ["generate-jwt-secret"],
        connections: [{ type: "Connection", data: { resource: resourceId, connection: connectionId } }],
        environment: {
          MANAGER_ID: managerId,
          MANAGER_API: managerAPI,
          MANAGER_PASSWORD: `[[secret:connection:${connectionId}:COMMANDER_PASSWORD]]`,
          JWT_SECRET: "[[variable:JWT_SECRET]]",
          PORT: "8080",
          STATIC_DIR: "/app/frontend/dist",
        },
        health_check: {
          test: ["CMD", "/app/cloudflare-manager", "healthcheck"],
          interval_seconds: 10, timeout_seconds: 3, start_period_seconds: 15, retries: 3, wait_timeout_seconds: 180,
        },
      },
    },
    object_hooks: [{
      kind: "container",
      name: "cloudflare-manager",
      create: { after: { query: "UPSERT manager_settings:current SET jwt_secret = $jwt_secret", bindings: { jwt_secret: "[[variable:JWT_SECRET]]" } } },
    }],
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
  const installTime = parseRunTime(install), teardownTime = parseRunTime(teardown);
  if (installTime === teardownTime) throw new Error("Install and teardown run timestamps are ambiguous");
  return teardownTime > installTime ? "ready" : "installed";
}

export async function startInstall(caller: RPCCaller, input: InstallInput, approvedConnection: CommanderConnection): Promise<StartResponse> {
  const [install, teardown] = await Promise.all([caller.getLatestRun({ action: "install" }), caller.getLatestRun({ action: "teardown" })]);
  const state = installationState(install, teardown);
  if (state === "installing") throw new Error("An install run is already queued or running");
  if (state === "tearing-down") throw new Error("A teardown run is already queued or running");
  if (state === "installed") throw new Error("Cloudflare Manager is already installed; use teardown to remove it");
  const managerId = await caller.getManager();
  const commander = await inspectCommanderConnection(caller, managerId);
  if (!commander) throw new Error("Create a Commander connection before installing");
  if (commander.connectionId !== approvedConnection.connectionId || commander.resourceId !== approvedConnection.resourceId) {
    throw new Error("The approved Commander connection changed; create or check the connection before installing");
  }
  return caller.start(buildInstallRun({ ...input, managerId, commander }));
}

function isActive(status: number | undefined): boolean { return status === 0 || status === 1; }
function parseRunTime(run: RunItem): number { const timestamp = Date.parse(run.queued_at); if (!Number.isFinite(timestamp)) throw new Error("Install and teardown run timestamps are invalid"); return timestamp; }
function requireImageReference(value: string, label: string, allowLatest: boolean): void {
  if (!value.trim() || /\s/.test(value)) throw new Error(`${label} is required`);
  if (/@sha256:[a-f0-9]{64}$/.test(value)) return;
  const lastPart = value.slice(value.lastIndexOf("/") + 1), separator = lastPart.lastIndexOf(":");
  if (separator <= 0 || (!allowLatest && lastPart.slice(separator + 1) === "latest")) throw new Error(`${label} must use a version tag or SHA-256 digest`);
}
function requireString(value: string, label: string): string { const result = value.trim(); if (!result || /[\r\n]/.test(result)) throw new Error(`${label} is required`); return result; }
