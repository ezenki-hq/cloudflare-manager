import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account, BackendAPI, Bucket, BucketPage, Domain, Zone } from "./api";
import type { CommanderBridge } from "./commander";
import { provisionConnection, revokeConnection } from "./connections";
import { InstallPanel, RunSummary } from "./components/InstallPanel";
import { BucketDetail } from "./components/BucketDetail";
import { startInstall as startInstallRun, type InstallInput } from "./installer";
import { findBucketResource, registerBucket, removeBucketRecord, setBucketPrimaryDomain, type ManagedBucket } from "./resources";
import { loadRunHistory, startTeardown, type RunHistory } from "./teardown";

interface AppProps {
  bridge: CommanderBridge;
  api: BackendAPI;
  backendOrigin: string;
  installDefaults: InstallInput;
}

type AuthState = "checking" | "signed-out" | "signed-in" | "blocked" | "unavailable";

export function App({ bridge, api, backendOrigin, installDefaults }: AppProps) {
  const { caller } = bridge;
  const popupRef = useRef<Window | null>(null);
  const bucketListRef = useRef<Bucket[]>([]);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [authError, setAuthError] = useState("");
  const [installHistory, setInstallHistory] = useState<RunHistory | null>(null);
  const [teardownHistory, setTeardownHistory] = useState<RunHistory | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("default");
  const [bucketPage, setBucketPage] = useState<BucketPage>({ buckets: [] });
  const [bucketLoading, setBucketLoading] = useState(false);
  const [selectedBucket, setSelectedBucket] = useState<Bucket | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<Bucket | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [resourceId, setResourceId] = useState("");
  const [appManagers, setAppManagers] = useState<Array<{ id: string; name: string }>>([]);
  const [connections, setConnections] = useState<Array<{ id: string; manager: string; metadata: Record<string, unknown> }>>([]);
  const [connectionManager, setConnectionManager] = useState("");
  const [permission, setPermission] = useState<"read-only" | "read-write">("read-only");
  const [bucketName, setBucketName] = useState("");
  const [pageError, setPageError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const surfaceError = (error: unknown) => {
    setPageError(message(error));
    if (statusOf(error) === 401) {
      setAuth("signed-out");
      setAuthError("Your Cloudflare session expired. Sign in again to continue.");
    }
  };

  const installed = installHistory?.run.status === 2 && teardownHistory?.run.status !== 2;
  const installActive = isActive(installHistory?.run.status);
  const teardownActive = isActive(teardownHistory?.run.status);
  const currentBucket = useMemo<ManagedBucket | null>(() => selectedBucket && accountId ? {
    accountId,
    jurisdiction: selectedBucket.jurisdiction ?? jurisdiction,
    name: selectedBucket.name,
    s3Endpoint: s3Endpoint(accountId, selectedBucket.jurisdiction ?? jurisdiction),
  } : null, [selectedBucket, accountId, jurisdiction]);

  const refreshHistory = useCallback(async (action: "install" | "teardown") => {
    try {
      const history = await loadRunHistory(caller, action);
      if (action === "install") setInstallHistory(history);
      else setTeardownHistory(history);
      return history;
    } catch {
      return null;
    }
  }, [caller]);

  const loadAccounts = useCallback(async () => {
    try {
      const list = await api.listAccounts();
      setAccounts(list);
      setAccountId((current) => current || list[0]?.id || "");
      setPageError("");
    } catch (error) { surfaceError(error); }
  }, [api]);

  const loadBuckets = useCallback(async (cursor?: string, append = false) => {
    if (!accountId) return;
    setBucketLoading(true);
    try {
      const page = await api.listBuckets(accountId, jurisdiction, cursor);
      const buckets = append ? [...bucketListRef.current, ...page.buckets] : page.buckets;
      bucketListRef.current = buckets;
      setBucketPage({ buckets, cursor: page.cursor });
      setPageError("");
    } catch (error) { surfaceError(error); }
    finally { setBucketLoading(false); }
  }, [api, accountId, jurisdiction]);

  const loadRunState = useCallback(async () => {
    await Promise.all([refreshHistory("install"), refreshHistory("teardown")]);
  }, [refreshHistory]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [installResult, teardownResult] = await Promise.all([
        loadRunHistory(caller, "install").catch(() => null),
        loadRunHistory(caller, "teardown").catch(() => null),
      ]);
      if (!live) return;
      setInstallHistory(installResult);
      setTeardownHistory(teardownResult);
      try {
        const session = await api.session();
        if (!live) return;
        setAuth(session.authenticated ? "signed-in" : "signed-out");
      } catch (error) {
        if (!live) return;
        setAuth(statusOf(error) === 401 ? "signed-out" : "unavailable");
        if (statusOf(error) !== 401) setAuthError(message(error));
      }
    })();
    return () => { live = false; };
  }, [api, caller]);

  useEffect(() => () => bridge.wire.end(), [bridge]);

  useEffect(() => bridge.onEvent((event) => {
    if (event.eventType === "run-start" && (event.data.action === "install" || event.data.action === "teardown")) {
      void refreshHistory(event.data.action);
    }
    if (event.eventType === "run-update") {
      void refreshHistory("install");
      void refreshHistory("teardown");
    }
  }), [bridge, refreshHistory]);

  useEffect(() => {
    if (auth === "signed-in") void loadAccounts();
  }, [auth, loadAccounts]);

  useEffect(() => {
    if (auth === "signed-in" && accountId) void loadBuckets();
  }, [auth, accountId, jurisdiction, loadBuckets]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== apiOrigin(backendOrigin) || event.source !== popupRef.current || event.data?.type !== "cloudflare-oauth-complete") return;
      void (async () => {
        try {
          const session = await api.session();
          if (session.authenticated) { popupRef.current = null; setAuth("signed-in"); setAuthError(""); }
          else { setAuth("blocked"); }
        } catch (error) {
          if (statusOf(error) === 401) { setAuth("blocked"); }
          else { setAuth("unavailable"); setAuthError(message(error)); }
        }
      })();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [api, backendOrigin]);

  const signIn = () => {
    const url = `${backendOrigin.replace(/\/$/, "")}/auth/start`;
    popupRef.current = window.open(url, "cloudflare-oauth", "popup,width=640,height=760");
    if (!popupRef.current) setAuthError("Allow popups for this Deploy Commander site, then try again.");
  };

  const selectBucket = async (bucket: Bucket) => {
    setSelectedBucket(bucket);
    setSelectedDetail(null);
    setDomains([]);
    setZones([]);
    setResourceId("");
    setPageError("");
    const bucketJurisdiction = bucket.jurisdiction ?? jurisdiction;
    try {
      const [detail, domainList, zoneList, resource] = await Promise.all([
        api.getBucket(accountId, bucketJurisdiction, bucket.name),
        api.listDomains(accountId, bucketJurisdiction, bucket.name),
        api.listZones(accountId),
        findBucketResource(caller, { accountId, jurisdiction: bucketJurisdiction, name: bucket.name, s3Endpoint: s3Endpoint(accountId, bucketJurisdiction) }),
      ]);
      setSelectedDetail(detail);
      setDomains(domainList);
      setZones(zoneList);
      setResourceId(resource?.resource.id ?? "");
    } catch (error) { surfaceError(error); }
  };

  const refreshConnections = useCallback(async (id: string) => {
    if (!id) { setConnections([]); return; }
    try {
      const items = await listAllConnections(caller, id);
      const saved = await Promise.all(items.map(async (item) => {
        try {
          const detail = await caller.getConnection(item.id);
          const metadata = isRecord(detail.config.metadata) ? detail.config.metadata : {};
          return isManagedConnection(metadata) ? { id: item.id, manager: item.manager, metadata } : null;
        } catch { return null; }
      }));
      setConnections(saved.filter((item): item is NonNullable<typeof item> => item !== null));
    } catch (error) { setPageError(message(error)); }
  }, [caller]);

  useEffect(() => {
    if (!resourceId) { setConnections([]); setAppManagers([]); return; }
    void refreshConnections(resourceId);
    void (async () => {
      try {
        const [managerId, list] = await Promise.all([caller.getManager(), caller.getManagers({ limit: 100, offset: 0 })]);
        setAppManagers(list.items.filter((item) => item.id !== managerId).map((item) => ({ id: item.id, name: item.name })));
      } catch { setAppManagers([]); }
    })();
  }, [caller, resourceId, refreshConnections]);

  const trackBucket = async () => {
    if (!currentBucket) return;
    await runAction("track", async () => {
      const id = await registerBucket(caller, currentBucket);
      setResourceId(id);
    });
  };

  const attachDomain = async (domain: string, zoneId: string) => {
    if (!selectedBucket) return;
    await runAction("domain", async () => {
      await api.attachDomain(accountId, selectedBucket.jurisdiction ?? jurisdiction, selectedBucket.name, domain, zoneId);
      const refreshed = await api.listDomains(accountId, selectedBucket.jurisdiction ?? jurisdiction, selectedBucket.name);
      setDomains(refreshed);
    });
  };

  const detachDomain = async (domain: string) => {
    if (!selectedBucket || !window.confirm(`Detach ${domain} from ${selectedBucket.name}?`)) return;
    await runAction("domain", async () => {
      await api.detachDomain(accountId, selectedBucket.jurisdiction ?? jurisdiction, selectedBucket.name, domain);
      setDomains(await api.listDomains(accountId, selectedBucket.jurisdiction ?? jurisdiction, selectedBucket.name));
    });
  };

  const setPrimary = async (domain?: string) => {
    if (!selectedBucket) return;
    await runAction("primary", async () => {
      let id = resourceId;
      if (!id) id = await registerBucket(caller, {
        accountId, jurisdiction: selectedBucket.jurisdiction ?? jurisdiction, name: selectedBucket.name,
        s3Endpoint: s3Endpoint(accountId, selectedBucket.jurisdiction ?? jurisdiction), ...(domain ? { primaryDomain: domain } : {}),
      });
      if (domain) await setBucketPrimaryDomain(caller, id, domain);
      else await setBucketPrimaryDomain(caller, id);
      setResourceId(id);
    });
  };

  const createApplicationConnection = async () => {
    if (!resourceId || !connectionManager) return;
    await runAction("connection", async () => {
      await provisionConnection(caller, api, { resourceId, managerId: connectionManager, permission });
      await refreshConnections(resourceId);
      setConnectionManager("");
    });
  };

  const removeApplicationConnection = async (id: string) => {
    if (!window.confirm("Revoke this application's Cloudflare token and remove its Deploy Commander connection?")) return;
    await runAction("connection", async () => {
      await revokeConnection(caller, api, id);
      if (resourceId) await refreshConnections(resourceId);
    });
  };

  const deleteSelectedBucket = async () => {
    if (!selectedBucket) return;
    const bucketLabel = `${accountName(accounts, accountId)} / ${selectedBucket.name}`;
    if (!window.confirm(`Delete ${bucketLabel}? Applications will lose access. Cloudflare only deletes empty buckets; bucket contents will not be removed by this manager.`)) return;
    await runAction("delete-bucket", async () => {
      if (resourceId) {
        const items = await listAllConnections(caller, resourceId);
        const saved = await Promise.all(items.map((connection) => caller.getConnection(connection.id)));
        if (saved.some((connection) => !isManagedConnection(connection.config.metadata))) {
          throw new Error("Remove the non-Cloudflare connection from this bucket before deleting it.");
        }
        for (const connection of items) await revokeConnection(caller, api, connection.id);
      }
      const jurisdictionValue = selectedBucket.jurisdiction ?? jurisdiction;
      await api.deleteBucket(accountId, jurisdictionValue, selectedBucket.name);
      if (resourceId) await removeBucketRecord(caller, resourceId);
      setSelectedBucket(null);
      setSelectedDetail(null);
      setResourceId("");
      await loadBuckets();
    });
  };

  const createBucket = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bucketName.trim()) return;
    await runAction("create-bucket", async () => {
      const bucket = await api.createBucket(accountId, jurisdiction, bucketName.trim());
      const managed: ManagedBucket = { accountId, jurisdiction, name: bucket.name, s3Endpoint: s3Endpoint(accountId, jurisdiction) };
      await registerBucket(caller, managed);
      setBucketName("");
      await loadBuckets();
      await selectBucket(bucket);
    });
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    setPageError("");
    try { await action(); }
    catch (error) { surfaceError(error); }
    finally { setBusyAction(""); }
  };

  const install = async (input: InstallInput) => {
    const started = await startInstallRun(caller, input);
    void loadRunState();
    if (started.status === 0) setPageError("");
  };

  const teardown = async () => {
    if (!window.confirm("Tear down the Cloudflare Manager service? Application tokens and Deploy Commander bucket records will be removed. Cloudflare buckets and domains will remain.")) return;
    await runAction("teardown", async () => {
      await startTeardown(caller, api);
      await loadRunState();
    });
  };

  if (auth === "checking") return <main className="app-shell"><div className="loading-card">Loading Cloudflare Manager…</div></main>;
  const showInstall = !installed;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#"><span className="brand-mark">C</span><span>Cloudflare Manager<small>Deploy Commander</small></span></a>
      {installed && <div className="topbar-actions"><span className={`status-pill ${auth === "signed-in" ? "status-live" : "status-neutral"}`}>{auth === "signed-in" ? "Cloudflare connected" : "Cloudflare sign-in needed"}</span><button className="text-button text-danger" disabled={teardownActive || auth !== "signed-in"} onClick={teardown}>Tear down</button></div>}
    </header>

    <section className="hero">
      <div className="hero-copy"><div className="eyebrow">OBJECT STORAGE · EDGE DELIVERY</div><h1>R2 storage, under control.</h1><p>Manage Cloudflare buckets, connect custom domains, and issue scoped credentials for the applications that use them.</p></div>
      <div className="hero-stat"><span>YOUR ACCESS</span><strong>{installed ? auth === "signed-in" ? "Ready" : "Sign-in required" : "Setup"}</strong><small>OAuth stays with the signed-in user.</small></div>
    </section>

    {installed && installHistory && <RunSummary history={installHistory} />}
    {installed && teardownHistory && <RunSummary history={teardownHistory} />}

    {showInstall ? <InstallPanel defaults={installDefaults} history={installHistory} installed={false} active={installActive || teardownActive} onInstall={install} /> : auth !== "signed-in" ? <section className="panel auth-panel">
      <div className="panel-kicker">CLOUDFLARE AUTHORIZATION</div>
      <h2>{auth === "unavailable" ? "Manager service is unavailable" : "Connect your Cloudflare account"}</h2>
      <p>{auth === "unavailable" ? "The manager API did not respond. Check the configured same-site route and service health." : "Sign in to Cloudflare to see your accounts. Access is personal to your Cloudflare user and is not shared with application credentials."}</p>
      {authError && <p className="inline-error" role="alert">{authError}</p>}
      {auth === "blocked" && <div className="cookie-help"><strong>Authorization finished, but this frame cannot read its session.</strong><p>Route the manager and Deploy Commander through the same HTTPS site. The Go API must allow the exact Commander origin, and the browser must accept the manager's host-only cookie in this embedded flow. Try opening the manager in a top-level tab if your browser blocks third-party cookies.</p></div>}
      {auth !== "unavailable" && <button className="button button-primary" onClick={signIn}>Sign in with Cloudflare</button>}
      {auth === "unavailable" && <button className="button button-secondary" onClick={() => { setAuth("checking"); void api.session().then((result) => setAuth(result.authenticated ? "signed-in" : "signed-out")).catch((error) => { setAuth(statusOf(error) === 401 ? "signed-out" : "unavailable"); setAuthError(message(error)); }); }}>Retry connection</button>}
    </section> : <>
      {pageError && <div className="page-error" role="alert"><span>{pageError}</span><button onClick={() => setPageError("")} aria-label="Dismiss error">×</button></div>}
      <section className="manager-grid">
        <section className="panel bucket-panel" aria-labelledby="bucket-list-title">
          <div className="panel-kicker">YOUR CLOUDFLARE</div>
          <div className="panel-heading"><div><h2 id="bucket-list-title">R2 buckets</h2><p>Choose an account and location to browse buckets.</p></div><button className="icon-button" aria-label="Refresh buckets" onClick={() => void loadBuckets()} disabled={bucketLoading}>↻</button></div>
          <div className="filter-row">
            <label>Account<select value={accountId} onChange={(event) => { setAccountId(event.target.value); setBucketPage({ buckets: [] }); setSelectedBucket(null); }}><option value="">Select an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <label>Jurisdiction<select value={jurisdiction} onChange={(event) => { setJurisdiction(event.target.value); setBucketPage({ buckets: [] }); setSelectedBucket(null); }}><option value="default">Default</option><option value="eu">European Union</option><option value="us">United States</option><option value="fedramp">FedRAMP</option><option value="fedramp-high">FedRAMP High</option></select></label>
          </div>
          <form className="create-bucket-form" onSubmit={createBucket}><label className="sr-only" htmlFor="bucket-name">New bucket name</label><input id="bucket-name" value={bucketName} onChange={(event) => setBucketName(event.target.value)} placeholder="New bucket name" /><button className="button button-secondary" type="submit" disabled={!bucketName.trim() || !!busyAction}>Create bucket</button></form>
          <div className="bucket-list" aria-live="polite">
            {bucketLoading && <div className="empty-row">Loading buckets…</div>}
            {!bucketLoading && bucketPage.buckets.length === 0 && <div className="empty-row">No buckets found in this location.</div>}
            {bucketPage.buckets.map((bucket) => <div key={`${bucket.jurisdiction ?? jurisdiction}/${bucket.name}`} className={`bucket-row ${selectedBucket?.name === bucket.name ? "bucket-row-selected" : ""}`}>
              <button className="bucket-select" onClick={() => void selectBucket(bucket)}><span className="bucket-icon">▧</span><span><strong>{bucket.name}</strong><small>{bucket.jurisdiction ?? jurisdiction} · R2 bucket</small></span><span className="row-chevron">›</span></button>
            </div>)}
            {bucketPage.cursor && <button className="button button-quiet page-button" disabled={bucketLoading} onClick={() => void loadBuckets(bucketPage.cursor, true)}>Next page</button>}
          </div>
        </section>

        {selectedBucket && selectedDetail && <div className="detail-column">
          <BucketDetail key={`${accountId}/${selectedDetail.jurisdiction ?? jurisdiction}/${selectedDetail.name}`} bucket={selectedDetail} domains={domains} zones={zones} tracked={!!resourceId} onTrack={() => void trackBucket()} onAttach={(domain, zoneId) => void attachDomain(domain, zoneId)} onDetach={(domain) => void detachDomain(domain)} onPrimary={(domain) => void setPrimary(domain)} onDelete={() => void deleteSelectedBucket()} />
          {resourceId && <section className="panel connection-panel" aria-labelledby="connections-title">
            <div className="panel-kicker">DEPLOY COMMANDER CONNECTIONS</div><div className="panel-heading"><div><h2 id="connections-title">Application access</h2><p>Each connection receives S3 keys scoped to this bucket.</p></div></div>
            <form className="connection-form" onSubmit={(event) => { event.preventDefault(); void createApplicationConnection(); }}>
              <label>Application manager<select value={connectionManager} onChange={(event) => setConnectionManager(event.target.value)}><option value="">Select an application</option>{appManagers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</select></label>
              <label>Permission<select value={permission} onChange={(event) => setPermission(event.target.value as "read-only" | "read-write")}><option value="read-only">Object read only</option><option value="read-write">Object read and write</option></select></label>
              <button className="button button-secondary" disabled={!connectionManager || !!busyAction}>Create connection</button>
            </form>
            {connections.length ? <ul className="connection-list">{connections.map((connection) => <li key={connection.id}><div><strong>{appManagers.find((item) => item.id === connection.manager)?.name ?? connection.manager}</strong><small>{String(connection.metadata.permission ?? "R2 connection")} · {String(connection.metadata.status ?? "ready")}</small></div><button className="text-button text-danger" onClick={() => void removeApplicationConnection(connection.id)}>Revoke</button></li>)}</ul> : <div className="empty-row">No application connections yet.</div>}
          </section>}
        </div>}
      </section>
    </>}
    <footer className="footer"><span>Cloudflare owns your buckets and domains.</span><span>Deploy Commander stores resource records and application secrets.</span></footer>
  </main>;
}

function isActive(status?: number): boolean { return status === 0 || status === 1; }
function statusOf(error: unknown): number | undefined { return isRecord(error) && typeof error.status === "number" ? error.status : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function accountName(accounts: Account[], id: string): string { return accounts.find((account) => account.id === id)?.name ?? id; }
function s3Endpoint(accountId: string, jurisdiction: string): string { return `https://${accountId}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com`; }
function isManagedConnection(value: unknown): boolean {
  return isRecord(value)
    && ["pending", "ready", "revoke_pending", "revoked"].includes(String(value.status))
    && (value.permission === "read-only" || value.permission === "read-write")
    && typeof value.accountId === "string"
    && typeof value.bucket === "string"
    && typeof value.jurisdiction === "string"
    && typeof value.endpoint === "string";
}
async function listAllConnections(caller: CommanderBridge["caller"], resource: string) {
  const result: Awaited<ReturnType<typeof caller.getConnections>>["items"] = [];
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await caller.getConnections({ resource, limit, offset, include_labels: true });
    result.push(...page.items);
    if (result.length >= page.total || page.items.length < limit) return result;
  }
  throw new Error("Too many bucket connections to process safely");
}
function apiOrigin(value: string): string { try { return new URL(value || window.location.origin, window.location.origin).origin; } catch { return window.location.origin; } }
