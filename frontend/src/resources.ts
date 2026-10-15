import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";

export const BUCKET_RESOURCE_TYPE = "cloudflare-r2-bucket";

export interface ManagedBucket {
  accountId: string;
  jurisdiction: string;
  name: string;
  s3Endpoint: string;
  primaryDomain?: string;
}

interface BucketMetadata {
  account_id: string;
  jurisdiction: string;
  bucket_name: string;
  s3_endpoint: string;
  primary_domain?: string;
}

export async function registerBucket(caller: RPCCaller, bucket: ManagedBucket): Promise<string> {
  const resources = await allBucketResources(caller);
  for (const resource of resources) {
    const saved = await caller.getResource(resource.id);
    if (matchesBucket(saved, bucket)) return saved.resource.id;
  }
  const metadata: BucketMetadata = {
    account_id: bucket.accountId,
    jurisdiction: bucket.jurisdiction,
    bucket_name: bucket.name,
    s3_endpoint: bucket.s3Endpoint,
    ...(bucket.primaryDomain ? { primary_domain: bucket.primaryDomain } : {}),
  };
  const created = await caller.createResource({ metadata, name: bucket.name }, false, bucket.name, BUCKET_RESOURCE_TYPE);
  return created.resource.id;
}

export async function removeBucketRecord(caller: RPCCaller, resourceId: string): Promise<void> {
  if (!resourceId.trim()) throw new Error("Resource ID is required");
  await caller.deleteResource(resourceId);
}

async function allBucketResources(caller: RPCCaller) {
  const result = [] as Awaited<ReturnType<RPCCaller["getMyResources"]>>["items"];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await caller.getMyResources({ type: BUCKET_RESOURCE_TYPE, external: false, limit, offset });
    result.push(...page.items.filter((item) => item.type === BUCKET_RESOURCE_TYPE));
    if (result.length >= page.total || page.items.length < limit) return result;
  }
  throw new Error("Too many bucket resources to check safely");
}

function matchesBucket(saved: Awaited<ReturnType<RPCCaller["getResource"]>>, bucket: ManagedBucket): boolean {
  const value: unknown = saved.config.metadata;
  if (!isRecord(value)) return false;
  return value.account_id === bucket.accountId && value.jurisdiction === bucket.jurisdiction && value.bucket_name === bucket.name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
