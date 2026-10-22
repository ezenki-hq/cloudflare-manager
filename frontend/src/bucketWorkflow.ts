import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI, Domain } from "./api";
import { bucketEndpoint, BUCKET_RESOURCE_TYPE, registerBucket, setBucketPrimaryDomain } from "./resources";

export interface BucketRequest {
  serviceResourceId: string;
  callingManagerId: string;
  suggested?: { account_id?: string; jurisdiction?: string; bucket?: string; domain?: string; zone_id?: string };
}

export interface BucketSelection {
  accountId: string;
  jurisdiction: string;
  bucket: string;
  mode: "create" | "existing";
  domain?: string;
  zoneId?: string;
}

export interface BucketProgress {
  bucketExists: boolean;
  resourceId?: string;
  domainAttached: boolean;
  lastCompleted: "none" | "bucket" | "resource" | "domain" | "primary";
}

export interface BucketSetupResult {
  resource: { id: string; manager: string; type: typeof BUCKET_RESOURCE_TYPE };
  bucket: { account_id: string; jurisdiction: string; name: string; s3_endpoint: string };
  cdn?: { domain: string; enabled: boolean; status?: unknown };
}

export class BucketSetupError extends Error {
  constructor(readonly failedStep: "validate" | "bucket" | "resource" | "domain" | "primary" | "status", message: string, readonly progress: BucketProgress) {
    super(message);
    this.name = "BucketSetupError";
  }
}

const emptyProgress = (): BucketProgress => ({ bucketExists: false, domainAttached: false, lastCompleted: "none" });

export async function validateBucketRequest(caller: RPCCaller, metadata: unknown, callingManager: string | null): Promise<BucketRequest> {
  try {
    if (!isRecord(metadata) || metadata.action !== "create-bucket") throw new Error("Unsupported bucket action");
    if (Object.keys(metadata).some((key) => !["action", "resource", "suggested"].includes(key))) throw new Error("Unsupported bucket request field");
    if (typeof metadata.resource !== "string" || !isCommanderId(metadata.resource)) throw new Error("The S3 provisioner resource ID is invalid");
    if (typeof callingManager !== "string" || !callingManager.trim() || !isCommanderId(callingManager)) throw new Error("The requesting calling manager is unavailable");
    const manager = await caller.getManager();
    const detail = await caller.getResource(metadata.resource);
    if (!isRecord(detail) || !isRecord(detail.resource) || !isRecord(detail.config)) throw new Error("The S3 provisioner resource could not be verified");
    const resource = detail.resource;
    const config = detail.config;
    const configMetadata = isRecord(config.metadata) ? config.metadata : null;
    if (resource.id !== metadata.resource || resource.manager !== manager || config.manager !== manager || resource.type !== "s3" || config.resource_type !== "s3" || resource.name !== "Cloudflare R2 S3" || config.name !== "Cloudflare R2 S3" || resource.external !== true || !configMetadata || configMetadata.provider !== "cloudflare-r2" || configMetadata.role !== "provisioner" || configMetadata.contract_version !== 1) {
      throw new Error("The selected resource is not this manager's S3 provisioner");
    }
    const suggested = parseSuggestions(metadata.suggested);
    return { serviceResourceId: metadata.resource, callingManagerId: callingManager, ...(suggested ? { suggested } : {}) };
  } catch (error) {
    if (error instanceof BucketSetupError) throw error;
    const message = error instanceof Error && ["Unsupported bucket action", "Unsupported bucket request field", "The S3 provisioner resource ID is invalid", "The requesting calling manager is unavailable", "The S3 provisioner resource could not be verified", "The selected resource is not this manager's S3 provisioner", "Invalid bucket suggestions"].includes(error.message) ? error.message : safeStepMessage("validate");
    throw new BucketSetupError("validate", message, emptyProgress());
  }
}

export async function setupBucket(caller: RPCCaller, api: BackendAPI, request: BucketRequest, selection: BucketSelection, onProgress?: (progress: BucketProgress) => void): Promise<BucketSetupResult> {
  const progress = emptyProgress();
  const report = () => onProgress?.({ ...progress });
  const fail = (step: BucketSetupError["failedStep"]): never => { throw new BucketSetupError(step, safeStepMessage(step), { ...progress }); };

  try {
    if (!isCommanderId(request.serviceResourceId) || !isCommanderId(request.callingManagerId) || !isRecord(selection) || !isCommanderId(selection.accountId) || !validJurisdiction(selection.jurisdiction) || !validBucket(selection.bucket) || !["create", "existing"].includes(selection.mode)) fail("validate");
    const accounts = await api.listAccounts();
    if (!accounts.some((account) => account.id === selection.accountId)) fail("validate");
    const domainName = selection.domain?.trim() ?? "";
    let zoneId = selection.zoneId?.trim() ?? "";
    if (domainName) {
      if (!validDomain(domainName) || !zoneId) fail("validate");
      const zones = await api.listZones(selection.accountId);
      if (!zones.some((zone) => zone.id === zoneId)) fail("validate");
    } else {
      zoneId = "";
    }

    try {
      if (selection.mode === "create") await api.createBucket(selection.accountId, selection.jurisdiction, selection.bucket);
      else await api.getBucket(selection.accountId, selection.jurisdiction, selection.bucket);
      progress.bucketExists = true;
      progress.lastCompleted = "bucket";
      report();
    } catch { fail("bucket"); }

    const endpoint = bucketEndpoint(selection.accountId, selection.jurisdiction);
    let resourceId = "";
    try {
      resourceId = await registerBucket(api, { accountId: selection.accountId, jurisdiction: selection.jurisdiction, name: selection.bucket, s3Endpoint: endpoint, ...(domainName ? { primaryDomain: domainName } : {}) });
      progress.resourceId = resourceId;
      progress.lastCompleted = "resource";
      report();
    } catch { fail("resource"); }

    let cdn: BucketSetupResult["cdn"];
    if (domainName) {
      let attached: Domain | undefined;
      try {
        const existingDomains = await api.listDomains(selection.accountId, selection.jurisdiction, selection.bucket);
        attached = existingDomains.find((domain) => domain.domain.toLowerCase() === domainName.toLowerCase());
        if (attached && attached.zoneId && attached.zoneId !== zoneId) fail("domain");
        if (!attached) {
          await api.attachDomain(selection.accountId, selection.jurisdiction, selection.bucket, domainName, zoneId);
          progress.domainAttached = true;
          progress.lastCompleted = "domain";
          report();
          let updated: Domain[] = [];
          try { updated = await api.listDomains(selection.accountId, selection.jurisdiction, selection.bucket); }
          catch { fail("status"); }
          attached = updated.find((domain) => domain.domain.toLowerCase() === domainName.toLowerCase());
          if (!attached) fail("status");
        }
        progress.domainAttached = true;
        progress.lastCompleted = "domain";
        report();
      } catch (error) {
        if (error instanceof BucketSetupError) throw error;
        fail("domain");
      }

      try {
        await setBucketPrimaryDomain(caller, resourceId, domainName);
        progress.lastCompleted = "primary";
        report();
      } catch { fail("primary"); }
      if (!attached) return fail("status");
      cdn = { domain: attached.domain, enabled: attached.enabled, ...(attached.status !== undefined ? { status: attached.status } : {}) };
    }

    return {
      resource: { id: resourceId, manager: await caller.getManager(), type: BUCKET_RESOURCE_TYPE },
      bucket: { account_id: selection.accountId, jurisdiction: selection.jurisdiction, name: selection.bucket, s3_endpoint: endpoint },
      ...(cdn ? { cdn } : {}),
    };
  } catch (error) {
    if (error instanceof BucketSetupError) throw error;
    return fail("validate");
  }
}

function parseSuggestions(value: unknown): BucketRequest["suggested"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !["account_id", "jurisdiction", "bucket", "domain", "zone_id"].includes(key))) throw new Error("Invalid bucket suggestions");
  const result: NonNullable<BucketRequest["suggested"]> = {};
  for (const key of ["account_id", "jurisdiction", "bucket", "domain", "zone_id"] as const) {
    const field = value[key];
    if (field !== undefined) {
      if (typeof field !== "string" || field.length > 253) throw new Error("Invalid bucket suggestions");
      result[key] = field;
    }
  }
  return result;
}

function safeStepMessage(step: BucketSetupError["failedStep"]): string {
  return ({ validate: "The bucket request or selection is invalid.", bucket: "The Cloudflare bucket could not be prepared.", resource: "The bucket resource could not be registered.", domain: "The CDN domain could not be attached.", primary: "The bucket's primary domain could not be saved.", status: "The CDN domain status could not be confirmed." })[step];
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isCommanderId(value: string): boolean { return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value); }
function validBucket(value: string): boolean { return value.length >= 3 && value.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value); }
function validJurisdiction(value: string): boolean { return ["default", "eu", "us", "fedramp", "fedramp-high"].includes(value); }
function validDomain(value: string): boolean { return value.length <= 253 && /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value); }
