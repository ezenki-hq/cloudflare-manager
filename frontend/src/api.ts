export interface Session {
  authenticated: boolean;
}

export interface Account {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  name: string;
  status?: string;
}

export interface Bucket {
  name: string;
  jurisdiction?: string;
  creation_date?: string;
  location?: string;
}

export interface BucketPage {
  buckets: Bucket[];
  cursor?: string;
}

export interface Domain {
  domain: string;
  enabled: boolean;
  zoneId?: string;
  status?: unknown;
}

export interface CreateCredentialInput {
  jurisdiction: string;
  connection_id: string;
  permission: "read-only" | "read-write";
}

export interface CloudflareCredential {
  token_id: string;
  access_key_id: string;
  secret_access_key: string;
}

export interface BackendAPI {
  session(): Promise<Session>;
  listAccounts(): Promise<Account[]>;
  listZones(accountId: string): Promise<Zone[]>;
  listBuckets(accountId: string, jurisdiction: string, cursor?: string): Promise<BucketPage>;
  getBucket(accountId: string, jurisdiction: string, bucket: string): Promise<Bucket>;
  createBucket(accountId: string, jurisdiction: string, bucket: string): Promise<Bucket>;
  deleteBucket(accountId: string, jurisdiction: string, bucket: string): Promise<void>;
  listDomains(accountId: string, jurisdiction: string, bucket: string): Promise<Domain[]>;
  attachDomain(accountId: string, jurisdiction: string, bucket: string, domain: string, zoneId: string): Promise<void>;
  detachDomain(accountId: string, jurisdiction: string, bucket: string, domain: string): Promise<void>;
  createCredential(accountId: string, bucket: string, input: CreateCredentialInput): Promise<CloudflareCredential>;
  findCredential(accountId: string, connectionId: string): Promise<{ token_id: string }>;
  revokeCredential(accountId: string, input: { token_id: string; connection_id: string }): Promise<void>;
}

export function createBackendAPI(baseURL: string, fetcher: typeof fetch = fetch): BackendAPI {
  const base = baseURL.replace(/\/$/, "");
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : `Manager API request failed (${response.status})`;
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return payload as T;
  };
  const id = (value: string) => encodeURIComponent(value);
  const bucketBase = (account: string, bucket: string, jurisdiction: string) =>
    `/api/accounts/${id(account)}/buckets/${id(bucket)}?jurisdiction=${id(jurisdiction)}`;

  return {
    session: () => request<Session>("/api/session"),
    listAccounts: () => request<Account[]>("/api/accounts"),
    listZones: (accountId) => request<Zone[]>(`/api/accounts/${id(accountId)}/zones`),
    listBuckets: (accountId, jurisdiction, cursor) => {
      const params = new URLSearchParams({ jurisdiction });
      if (cursor) params.set("cursor", cursor);
      return request<BucketPage>(`/api/accounts/${id(accountId)}/buckets?${params}`);
    },
    getBucket: (accountId, jurisdiction, bucket) => request<Bucket>(bucketBase(accountId, bucket, jurisdiction)),
    createBucket: (accountId, jurisdiction, bucket) => request<Bucket>(`/api/accounts/${id(accountId)}/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: bucket, jurisdiction }),
    }),
    deleteBucket: (accountId, jurisdiction, bucket) => request<void>(bucketBase(accountId, bucket, jurisdiction), { method: "DELETE", body: "{}" }),
    listDomains: (accountId, jurisdiction, bucket) => request<Domain[]>(`${bucketBase(accountId, bucket, jurisdiction).replace(/\?.*$/, "/domains")}?jurisdiction=${id(jurisdiction)}`),
    attachDomain: (accountId, jurisdiction, bucket, domain, zoneId) => request<void>(`/api/accounts/${id(accountId)}/buckets/${id(bucket)}/domains?jurisdiction=${id(jurisdiction)}`, {
      method: "POST",
      body: JSON.stringify({ domain, zone_id: zoneId }),
    }),
    detachDomain: (accountId, jurisdiction, bucket, domain) => request<void>(`/api/accounts/${id(accountId)}/buckets/${id(bucket)}/domains/${id(domain)}?jurisdiction=${id(jurisdiction)}`, { method: "DELETE", body: "{}" }),
    createCredential: (accountId, bucket, input) => request<CloudflareCredential>(`/api/accounts/${id(accountId)}/buckets/${id(bucket)}/credentials`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    findCredential: (accountId, connectionId) => request<{ token_id: string }>(`/api/accounts/${id(accountId)}/credentials/find?connection_id=${id(connectionId)}`),
    revokeCredential: (accountId, input) => request<void>(`/api/accounts/${id(accountId)}/credentials/revoke`, { method: "POST", body: JSON.stringify(input) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
