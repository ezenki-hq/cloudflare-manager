import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import type { BackendAPI } from "./api";
import { bucketEndpoint } from "./resources";
import { BucketSetupError, setupBucket, validateBucketRequest, type BucketSelection } from "./bucketWorkflow";

const serviceResourceId = "service-resource";
const managerId = "cloudflare-manager";
const accountId = "account-1";
const bucketName = "media-files";
const bucketResourceId = "bucket-resource";
const domain = "cdn.example.test";
const zoneId = "zone-1";

function serviceResource(type = "s3") {
  return { resource: { id: serviceResourceId, manager: managerId, type, name: "Cloudflare R2 S3", external: true }, config: { id: serviceResourceId, manager: managerId, resource_type: type, agent: "", name: "Cloudflare R2 S3", metadata: { provider: "cloudflare-r2", role: "provisioner", contract_version: 1 } } };
}

function harness() {
  const caller = {
    getManager: vi.fn().mockResolvedValue(managerId),
    getResource: vi.fn().mockImplementation(async (id: string) => id === serviceResourceId ? serviceResource() : ({ config: { metadata: { keep: true } } })),
    updateResource: vi.fn().mockResolvedValue(undefined),
  } as unknown as RPCCaller;
  const api = {
    listAccounts: vi.fn().mockResolvedValue([{ id: accountId, name: "Account One" }]),
    listZones: vi.fn().mockResolvedValue([{ id: zoneId, name: "example.test" }]),
    getBucket: vi.fn().mockResolvedValue({ name: bucketName, jurisdiction: "default" }),
    createBucket: vi.fn().mockResolvedValue({ name: bucketName, jurisdiction: "default" }),
    registerResource: vi.fn().mockResolvedValue({ resource_id: bucketResourceId }),
    listDomains: vi.fn().mockResolvedValue([]),
    attachDomain: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendAPI;
  const request = { serviceResourceId, callingManagerId: "application-manager" };
  return { caller, api, request };
}

const selection: BucketSelection = { accountId, jurisdiction: "default", bucket: bucketName, mode: "create" };

describe("Cloudflare bucket child request validation", () => {
  it("accepts a trusted caller and the exact provisioner resource", async () => {
    const { caller } = harness();
    await expect(validateBucketRequest(caller, { action: "create-bucket", resource: serviceResourceId, suggested: { account_id: accountId, bucket: bucketName } }, "application-manager")).resolves.toEqual({
      serviceResourceId, callingManagerId: "application-manager", suggested: { account_id: accountId, bucket: bucketName },
    });
  });

  it("rejects missing caller, foreign resource, or unsupported metadata before Cloudflare calls", async () => {
    const { caller, api } = harness();
    await expect(validateBucketRequest(caller, { action: "create-bucket", resource: serviceResourceId }, null)).rejects.toThrow(/calling manager/i);
    vi.mocked(caller.getResource).mockResolvedValueOnce(serviceResource("database") as never);
    await expect(validateBucketRequest(caller, { action: "create-bucket", resource: serviceResourceId }, "application-manager")).rejects.toThrow(/provisioner/i);
    await expect(validateBucketRequest(caller, { action: "delete-everything", resource: serviceResourceId }, "application-manager")).rejects.toThrow(/unsupported/i);
    expect(api.createBucket).not.toHaveBeenCalled();
    expect(api.registerResource).not.toHaveBeenCalled();
  });
});

describe("R2 bucket and CDN provisioning workflow", () => {
  it("creates, registers, attaches a CDN domain, and returns pending status without secrets", async () => {
    const { caller, api, request } = harness();
    vi.mocked(api.listDomains).mockResolvedValueOnce([]).mockResolvedValueOnce([{ domain, enabled: false, zoneId, status: { ownership: "pending", ssl: "pending" } }]);
    const progress: unknown[] = [];

    const result = await setupBucket(caller, api, request, { ...selection, domain, zoneId }, (value) => progress.push(value));

    expect(api.createBucket).toHaveBeenCalledWith(accountId, "default", bucketName);
    expect(api.registerResource).toHaveBeenCalledWith({ account_id: accountId, jurisdiction: "default", bucket: bucketName, s3_endpoint: bucketEndpoint(accountId, "default"), primary_domain: domain });
    expect(api.attachDomain).toHaveBeenCalledWith(accountId, "default", bucketName, domain, zoneId);
    expect(caller.updateResource).toHaveBeenCalledWith(bucketResourceId, { config: { metadata: { keep: true, primary_domain: domain } } });
    expect(result).toEqual({
      resource: { id: bucketResourceId, manager: managerId, type: "cloudflare-r2-bucket" },
      bucket: { account_id: accountId, jurisdiction: "default", name: bucketName, s3_endpoint: bucketEndpoint(accountId, "default") },
      cdn: { domain, enabled: false, status: { ownership: "pending", ssl: "pending" } },
    });
    expect(progress.at(-1)).toMatchObject({ bucketExists: true, resourceId: bucketResourceId, domainAttached: true, lastCompleted: "primary" });
    expect(JSON.stringify(result)).not.toMatch(/access_key|secret|token/i);
  });

  it("verifies an existing bucket without creating it and omits CDN data when unused", async () => {
    const { caller, api, request } = harness();
    const result = await setupBucket(caller, api, request, { ...selection, mode: "existing" });

    expect(api.getBucket).toHaveBeenCalledWith(accountId, "default", bucketName);
    expect(api.createBucket).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("cdn");
  });

  it("recovers a bucket after registration failed by retrying in existing mode", async () => {
    const { caller, api, request } = harness();
    vi.mocked(api.registerResource).mockRejectedValueOnce(new Error("Commander unavailable"));
    let error: unknown;
    try { await setupBucket(caller, api, request, selection); } catch (caught) { error = caught; }

    expect(error).toBeInstanceOf(BucketSetupError);
    expect(error).toMatchObject({ failedStep: "resource", progress: { bucketExists: true, lastCompleted: "bucket" } });
    await expect(setupBucket(caller, api, request, { ...selection, mode: "existing" })).resolves.toMatchObject({ resource: { id: bucketResourceId } });
    expect(api.createBucket).toHaveBeenCalledTimes(1);
  });

  it("does not attach a requested domain that is already attached", async () => {
    const { caller, api, request } = harness();
    vi.mocked(api.listDomains).mockResolvedValue([{ domain, enabled: true, zoneId, status: { ownership: "active", ssl: "active" } }]);

    const result = await setupBucket(caller, api, request, { ...selection, mode: "existing", domain, zoneId });

    expect(api.attachDomain).not.toHaveBeenCalled();
    expect(result.cdn).toEqual({ domain, enabled: true, status: { ownership: "active", ssl: "active" } });
  });

  it("recognizes an attached domain on retry after primary metadata update fails", async () => {
    const { caller, api, request } = harness();
    vi.mocked(api.listDomains).mockResolvedValueOnce([]).mockResolvedValueOnce([{ domain, enabled: false, zoneId, status: { ownership: "pending", ssl: "pending" } }]).mockResolvedValueOnce([{ domain, enabled: false, zoneId, status: { ownership: "pending", ssl: "pending" } }]).mockResolvedValueOnce([{ domain, enabled: false, zoneId, status: { ownership: "pending", ssl: "pending" } }]);
    vi.mocked(caller.updateResource).mockRejectedValueOnce(new Error("Commander unavailable"));

    await expect(setupBucket(caller, api, request, { ...selection, mode: "existing", domain, zoneId })).rejects.toMatchObject({ failedStep: "primary", progress: { domainAttached: true, lastCompleted: "domain" } });
    await setupBucket(caller, api, request, { ...selection, mode: "existing", domain, zoneId });

    expect(api.attachDomain).toHaveBeenCalledTimes(1);
  });

  it("rejects account or zone selections outside the signed-in user's options", async () => {
    const { caller, api, request } = harness();
    await expect(setupBucket(caller, api, request, { ...selection, accountId: "other-account" })).rejects.toMatchObject({ failedStep: "validate" });
    await expect(setupBucket(caller, api, request, { ...selection, mode: "existing", domain, zoneId: "other-zone" })).rejects.toMatchObject({ failedStep: "validate" });
    expect(api.createBucket).not.toHaveBeenCalled();
    expect(api.registerResource).not.toHaveBeenCalled();
  });
});

describe("S3 endpoint selection", () => {
  it("uses the account endpoint and includes only nondefault jurisdictions", () => {
    expect(bucketEndpoint(accountId, "default")).toBe("https://account-1.r2.cloudflarestorage.com");
    expect(bucketEndpoint(accountId, "eu")).toBe("https://account-1.eu.r2.cloudflarestorage.com");
  });
});
