import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account, BackendAPI, Bucket, BucketPage, Domain, Zone } from "./api";
import type { CommanderBridge } from "./commander";
import { reloadCommanderHost } from "./hostNavigation";
import { getCurrentManagerRedirect } from "./managerRedirect";
import { provisionConnection, revokeConnection } from "./connections";
import { BucketDetail } from "./components/BucketDetail";
import { findBucketResource, registerBucket, removeBucketRecord, setBucketPrimaryDomain, type ManagedBucket } from "./resources";
import { loadLatestTeardown, type TeardownSnapshot } from "./runHistory";
import { startTeardown } from "./teardown";

interface AppProps {
  bridge: CommanderBridge;
  api: BackendAPI;
  backendOrigin: string;
  reloadHost?: typeof reloadCommanderHost;
}

type AuthState = "checking" | "signed-out" | "signed-in" | "blocked" | "unavailable";

export function App({ bridge, api, backendOrigin, reloadHost = reloadCommanderHost }: AppProps) {
  const { caller } = bridge;
  const popupRef = useRef<Window | null>(null);
  const bucketListRef = useRef<Bucket[]>([]);
  const teardownRefreshVersion = useRef(0);
  const activeInstallIds = useRef(new Set<string>());
  const [auth, setAuth] = useState<AuthState>("checking");
  const [authError, setAuthError] = useState("");
  const [clientID, setClientID] = useState("");
  const [savingClientID, setSavingClientID] = useState(false);
  const [teardownHistory, setTeardownHistory] = useState<TeardownSnapshot | null>(null);
  const [installRun, setInstallRun] = useState<Awaited<ReturnType<typeof caller.getLatestRun>>>(null);
  const [reloadBlocked, setReloadBlocked] = useState(false);
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

  const teardownActive = isActive(teardownHistory?.run.status);
  const installActive = isActive(installRun?.status);
  const currentBucket = useMemo<ManagedBucket | null>(() => selectedBucket && accountId ? {
    accountId,
    jurisdiction: selectedBucket.jurisdiction ?? jurisdiction,
    name: selectedBucket.name,
    s3Endpoint: s3Endpoint(accountId, selectedBucket.jurisdiction ?? jurisdiction),
  } : null, [selectedBucket, accountId, jurisdiction]);

  const refreshTeardown = useCallback(async () => {
    const version = ++teardownRefreshVersion.current;
    try {
      const snapshot = await loadLatestTeardown(caller);
      if (version !== teardownRefreshVersion.current) return null;
      setTeardownHistory((current) => {
        if (!snapshot) return current?.run.status === 0 || current?.run.status === 1 ? current : null;
        if (current?.run.id === snapshot.run.id && current.lastEvent && (!snapshot.lastEvent || current.lastEvent.seq > snapshot.lastEvent.seq)) {
          return { ...snapshot, lastEvent: current.lastEvent };
        }
        return snapshot;
      });
      return snapshot;
    } catch {
      return null;
    }
  }, [caller]);

  const refreshLifecycle = useCallback(async () => {
    const [teardown, install] = await Promise.all([refreshTeardown(), Promise.resolve(caller.getLatestRun({ action: "install" })).catch(() => null)]);
    if (install) setInstallRun((current) => !current || current.id !== install.id || install.status >= current.status ? install : current);
    if (install && isActive(install.status)) activeInstallIds.current.add(install.id);
    if (install?.status === 2 && activeInstallIds.current.has(install.id)) {
      activeInstallIds.current.delete(install.id);
      const managerId = await caller.getManager().catch(() => "");
      if (managerId && !reloadHost(managerId, "install", install.id)) setReloadBlocked(true);
    }
    if (teardown && isActive(teardown.run.status)) {
      const state = await getCurrentManagerRedirect(caller);
      if (state === "cleared") {
        const managerId = await caller.getManager().catch(() => "");
        if (managerId && !reloadHost(managerId, "teardown", teardown.run.id)) setReloadBlocked(true);
      }
    } else if (teardown?.run.status === 2) {
      const managerId = await caller.getManager().catch(() => "");
      if (managerId && !reloadHost(managerId, "teardown", teardown.run.id)) setReloadBlocked(true);
    }
  }, [caller, refreshTeardown, reloadHost]);

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

  useEffect(() => {
    let live = true;
    void refreshLifecycle();
    void (async () => {
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
  }, [api, refreshLifecycle]);

  useEffect(() => {
    if (!teardownActive && !installActive) return;
    const poll = () => { void refreshLifecycle(); };
    const timer = window.setInterval(poll, 3000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [teardownActive, installActive, refreshLifecycle]);

  useEffect(() => { void api.clientID().then(setClientID).catch((error) => setAuthError(message(error))); }, [api]);

  useEffect(() => () => {
    teardownRefreshVersion.current += 1;
    bridge.wire.end();
  }, [bridge]);

  useEffect(() => bridge.onEvent((event) => {
    if (event.eventType === "run-start" && event.data.action === "install") {
      activeInstallIds.current.add(event.data.id);
      void refreshLifecycle();
      return;
    }
    if (event.eventType === "run-start" && event.data.action === "teardown") {
      void refreshLifecycle();
      return;
    }
    if (event.eventType !== "run-update") return;
    const update = event.data;
    if (update.type === "event") {
      const payload = update.payload;
      if (payload.run_id && typeof payload.seq === "number" && typeof payload.message === "string" && payload.message.trim()) {
        const { run_id: runId, seq, message: eventMessage } = payload;
        setTeardownHistory((current) => {
          if (!current || current.run.id !== runId || current.lastEvent && seq <= current.lastEvent.seq) return current;
          return { ...current, lastEvent: { seq, message: eventMessage } };
        });
      }
    }
    void refreshLifecycle();
  }), [bridge, refreshLifecycle]);

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
    const popup = window.open("about:blank", "cloudflare-oauth", "popup,width=640,height=760");
    popupRef.current = popup;
    if (!popup) { setAuthError("Allow popups for this Deploy Commander site, then try again."); return; }
    setAuthError("");
    void api.startOAuth(clientID, window.location.origin, new URL(backendOrigin || window.location.origin, window.location.origin).origin)
      .then(({ authorization_url }) => { if (popupRef.current === popup) popup.location.href = authorization_url; })
      .catch((error) => { popup.close(); popupRef.current = null; setAuthError(message(error)); });
  };

  const saveClient = async (event: React.FormEvent) => { event.preventDefault(); setSavingClientID(true); try { await api.saveClientID(clientID); setClientID(clientID.trim()); setAuthError(""); } catch (error) { setAuthError(message(error)); } finally { setSavingClientID(false); } };

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
        findBucketResource(api, { accountId, jurisdiction: bucketJurisdiction, name: bucket.name, s3Endpoint: s3Endpoint(accountId, bucketJurisdiction) }),
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
      const items = await api.listConnections(id);
      setConnections(items.map(({ connection }) => ({ id: connection.id, manager: connection.manager ?? "", metadata: connection.metadata ?? {} })));
    } catch (error) { setPageError(message(error)); }
  }, [api]);

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
      const id = await registerBucket(api, currentBucket);
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
      if (!id) id = await registerBucket(api, {
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
      await registerBucket(api, managed);
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

  const teardown = async () => {
    if (!window.confirm("Tear down the Cloudflare Manager service? Application access keys may remain active. Cloudflare buckets and domains will remain.")) return;
    await runAction("teardown", async () => {
      await startTeardown(caller);
      await refreshLifecycle();
    });
  };

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#"><span className="brand-mark">C</span><span>Cloudflare Manager<small>Deploy Commander</small></span></a>
      <div className="topbar-actions"><span className={`status-pill ${auth === "signed-in" ? "status-live" : "status-neutral"}`}>{auth === "signed-in" ? "Cloudflare connected" : "Cloudflare sign-in needed"}</span><button className="text-button text-danger" disabled={teardownActive || installActive || teardownHistory?.run.status === 2 && !(installRun && installRun.queued_at > teardownHistory.run.queued_at)} onClick={teardown}>Tear down</button></div>
    </header>

    {reloadBlocked && <div className="page-error" role="alert"><span>Commander did not reload automatically.</span><button className="button button-secondary" onClick={() => window.parent.location.reload()}>Reload Commander</button></div>}

    <section className="hero">
      <div className="hero-copy"><div className="eyebrow">OBJECT STORAGE · EDGE DELIVERY</div><h1>R2 storage, under control.</h1><p>Manage Cloudflare buckets, connect custom domains, and issue scoped credentials for the applications that use them.</p></div>
      <div className="hero-stat"><span>YOUR ACCESS</span><strong>{auth === "signed-in" ? "Ready" : "Sign-in required"}</strong><small>OAuth stays with the signed-in user.</small></div>
    </section>

    <section className="panel oauth-settings" aria-labelledby="oauth-settings-title">
      <div className="panel-heading"><div><h2 id="oauth-settings-title">Cloudflare OAuth</h2><p>Set the public client ID used when connecting a Cloudflare account.</p></div></div>
      <div className="oauth-setup" aria-label="Cloudflare OAuth client configuration">
        <p>In Cloudflare, create an OAuth client with these settings:</p>
        <dl>
          <div><dt>Client name</dt><dd>Cloudflare Manager</dd></div>
          <div><dt>Response type</dt><dd>Code</dd></div>
          <div><dt>Grant type</dt><dd>Authorization Code</dd></div>
          <div><dt>Token authentication method</dt><dd>None (PKCE)</dd></div>
          <div><dt>Redirect URLs</dt><dd><code>{window.location.origin}/auth/callback</code></dd></div>
          <div><dt>Required scopes</dt><dd>Account Read, Zone Read, Workers R2 Storage Read, Workers R2 Storage Write, Account API Tokens Read, and Account API Tokens Write</dd></div>
        </dl>
        <p>Copy the client ID Cloudflare gives you into the field below. This PKCE client does not use a client secret.</p>
        <p className="oauth-setup-note">New clients are private to their owning account. To allow users from other Cloudflare accounts to sign in, set Client URL to <code>{window.location.origin}</code>, add a logo, verify the domain, then make the client public.</p>
      </div>
      <form className="oauth-settings-form" onSubmit={(event) => void saveClient(event)}>
        <label htmlFor="cloudflare-client-id">OAuth client ID</label><input id="cloudflare-client-id" value={clientID} onChange={(event) => setClientID(event.target.value)} autoComplete="off" />
        <div className="oauth-settings-actions"><button className="button button-secondary" disabled={savingClientID}>{savingClientID ? "Saving…" : "Save client ID"}</button><a className="button button-quiet" href="https://dash.cloudflare.com/?to=/:account/oauth-clients" target="_blank" rel="noopener noreferrer">Create or get a client ID ↗</a></div>
      </form>
    </section>

    {teardownHistory && <section className="run-summary" aria-label="teardown run status"><div><span className="muted-label">Latest teardown run</span><strong className={`run-status run-status-${teardownHistory.run.status}`}>{runStatus(teardownHistory.run.status)}</strong><span className="run-id">{teardownHistory.run.id}</span></div><div className="run-messages"><p>{teardownHistory.lastEvent?.message ?? "Run updates will appear here."}</p></div></section>}

    {auth !== "signed-in" ? <section className="panel auth-panel">
      <div className="panel-kicker">CLOUDFLARE AUTHORIZATION</div>
      <h2>{auth === "unavailable" ? "Manager service is unavailable" : "Connect your Cloudflare account"}</h2>
      <p>{auth === "unavailable" ? "The manager API did not respond. Check the configured same-site route and service health." : "Sign in to Cloudflare to see your accounts. Access is personal to your Cloudflare user and is not shared with application credentials."}</p>
      {authError && <p className="inline-error" role="alert">{authError}</p>}
      {auth === "blocked" && <div className="cookie-help"><strong>Authorization finished, but this frame cannot read its session.</strong><p>Route the manager and Deploy Commander through the same HTTPS site. The Go API must allow the exact Commander origin, and the browser must accept the manager's host-only cookie in this embedded flow. Try opening the manager in a top-level tab if your browser blocks third-party cookies.</p></div>}
      {auth !== "unavailable" && <button className="button button-primary" onClick={signIn} disabled={!clientID.trim()}>Sign in with Cloudflare</button>}
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
function runStatus(status: number): string { return ["Queued", "Running", "Done", "Failed"][status] ?? "Unknown"; }
function statusOf(error: unknown): number | undefined { return isRecord(error) && typeof error.status === "number" ? error.status : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function accountName(accounts: Account[], id: string): string { return accounts.find((account) => account.id === id)?.name ?? id; }
function s3Endpoint(accountId: string, jurisdiction: string): string { return `https://${accountId}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com`; }
function apiOrigin(value: string): string { try { return new URL(value || window.location.origin, window.location.origin).origin; } catch { return window.location.origin; } }
