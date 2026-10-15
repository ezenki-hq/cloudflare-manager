import { describe, expect, it, vi } from "vitest";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { registerBucket, removeBucketRecord, type ManagedBucket } from "./resources";

const bucket: ManagedBucket = {
  accountId: "account-1",
  jurisdiction: "eu",
  name: "media-files",
  s3Endpoint: "https://account-1.eu.r2.cloudflarestorage.com",
  primaryDomain: "cdn.example.test",
};

describe("Cloudflare bucket resources", () => {
  it("creates a nonsecret resource record with bucket identity metadata", async () => {
    const getMyResources = vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 });
    const createResource = vi.fn().mockResolvedValue({ resource: { id: "resource-1" } });
    const id = await registerBucket({ getMyResources, createResource } as unknown as RPCCaller, bucket);

    expect(id).toBe("resource-1");
    expect(createResource).toHaveBeenCalledWith(
      {
        metadata: {
          account_id: "account-1",
          jurisdiction: "eu",
          bucket_name: "media-files",
          s3_endpoint: bucket.s3Endpoint,
          primary_domain: "cdn.example.test",
        },
        name: "media-files",
      },
      false,
      "media-files",
      "cloudflare-r2-bucket",
    );
    expect(JSON.stringify(createResource.mock.calls)).not.toMatch(/secret|access.key|token/i);
  });

  it("returns an existing matching record without creating a duplicate", async () => {
    const getMyResources = vi.fn().mockResolvedValue({ items: [{ id: "existing", type: "cloudflare-r2-bucket", labels: {}, name: bucket.name }], limit: 50, offset: 0, total: 1 });
    const getResource = vi.fn().mockResolvedValue({ resource: { id: "existing" }, config: { metadata: { account_id: bucket.accountId, jurisdiction: bucket.jurisdiction, bucket_name: bucket.name } } });
    const createResource = vi.fn();
    const id = await registerBucket({ getMyResources, getResource, createResource } as unknown as RPCCaller, bucket);
    expect(id).toBe("existing");
    expect(createResource).not.toHaveBeenCalled();
  });

  it("removes a resource through manager-scoped deleteResource", async () => {
    const deleteResource = vi.fn().mockResolvedValue(undefined);
    await removeBucketRecord({ deleteResource } as unknown as RPCCaller, "resource-1");
    expect(deleteResource).toHaveBeenCalledWith("resource-1");
  });
});
