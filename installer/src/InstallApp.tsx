import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RunItem } from "@ezenki/deploy-commander-installer-interface";
import { inspectCommanderConnection, resolveCommanderConnection, type CommanderConnection } from "./commanderConnection";
import { installationState, startInstall, type InstallInput, type InstallationState } from "./installer";
import type { CommanderBridge } from "./commander";
import { reloadCommanderHost } from "./hostNavigation";
import { loadLatestInstall, loadLatestTeardown } from "./runHistory";
import { loadClientID, saveClientID } from "./settings";

interface InstallAppProps {
  bridge: CommanderBridge;
  defaults: InstallInput;
  reloadHost?: typeof reloadCommanderHost;
}

type InstallerUIState = InstallationState | "unavailable";
type ConnectionUIState = "checking" | "missing" | "ready" | "error";

export function InstallApp({ bridge, defaults, reloadHost = reloadCommanderHost }: InstallAppProps) {
  const { caller } = bridge;
  const [clientID, setClientID] = useState("");
  const [commanderConnection, setCommanderConnection] = useState<CommanderConnection | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionUIState>("checking");
  const [connectingCommander, setConnectingCommander] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [state, setState] = useState<InstallerUIState>("ready");
  const [installRun, setInstallRun] = useState<RunItem | null>(null);
  const [teardownRun, setTeardownRun] = useState<RunItem | null>(null);
  const [lastEvent, setLastEvent] = useState<{ seq: number; message: string } | null>(null);
  const [teardownEvent, setTeardownEvent] = useState<{ seq: number; message: string } | null>(null);
  const [reloadBlocked, setReloadBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingClientID, setSavingClientID] = useState(false);
  const [error, setError] = useState("");
  const currentRunId = useRef<string | null>(null);
  const locallyActiveRun = useRef<RunItem | null>(null);
  const latestEventSeq = useRef(-1);
  const latestTeardownEventSeq = useRef(-1);
  const teardownRunId = useRef<string | null>(null);
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [snapshot, teardownSnapshot] = await Promise.all([
      loadLatestInstall(caller),
      loadLatestTeardown(caller),
    ]);
    if (version !== refreshVersion.current) return;
    const teardown = teardownSnapshot?.run ?? null;
    teardownRunId.current = teardown?.id ?? null;
    setTeardownRun(teardown);
    if (locallyActiveRun.current && isActive(locallyActiveRun.current.status) && snapshot?.run.id !== locallyActiveRun.current.id) {
      if (isActive(teardown?.status)) {
        setInstallRun(snapshot?.run ?? locallyActiveRun.current);
        setState("tearing-down");
      } else {
        setInstallRun(locallyActiveRun.current);
        setState("installing");
      }
      return;
    }
    if (snapshot?.run.id === locallyActiveRun.current?.id || (locallyActiveRun.current && !isActive(locallyActiveRun.current.status))) locallyActiveRun.current = null;
    currentRunId.current = snapshot?.run.id ?? null;
    setInstallRun(snapshot?.run ?? null);
    const lifecycleState = installationState(snapshot?.run ?? null, teardown);
    setState(lifecycleState);
    if (snapshot?.lastEvent && snapshot.lastEvent.seq >= latestEventSeq.current) {
      latestEventSeq.current = snapshot.lastEvent.seq;
      if (snapshot.lastEvent.message.trim()) setLastEvent(snapshot.lastEvent);
    }
    if (teardownSnapshot?.lastEvent && teardownSnapshot.lastEvent.seq >= latestTeardownEventSeq.current) {
      latestTeardownEventSeq.current = teardownSnapshot.lastEvent.seq;
      if (teardownSnapshot.lastEvent.message.trim()) setTeardownEvent(teardownSnapshot.lastEvent);
    }
    if (snapshot?.run.status === 2 && lifecycleState === "installed") {
      const managerId = await caller.getManager().catch(() => "");
      if (managerId && !reloadHost(managerId, "install", snapshot.run.id)) setReloadBlocked(true);
    }
  }, [caller, reloadHost]);

  useEffect(() => {
    let alive = true;
    void refresh().catch((cause) => { if (alive) { setError(message(cause)); setState("unavailable"); } }).finally(() => { if (alive) setLoading(false); });
    void caller.getManager().then((managerId) => inspectCommanderConnection(caller, managerId)).then((connection) => {
      if (alive) { setCommanderConnection(connection); setConnectionState(connection ? "ready" : "missing"); }
    }).catch((cause) => { if (alive) { setConnectionError(message(cause)); setConnectionState("error"); } });
    void loadClientID(caller).then((value) => { if (alive) setClientID(value); }).catch((cause) => { if (alive) setError(message(cause)); });
    const unsubscribe = bridge.onEvent((event) => {
      if (event.eventType === "run-start" && event.data.action === "install") {
        const queuedAt = event.data.created ?? new Date().toISOString();
        locallyActiveRun.current = { id: event.data.id, action: "install", status: 0, queued_at: queuedAt, created_at: queuedAt, updated_at: queuedAt };
        if (event.data.id !== currentRunId.current) {
          currentRunId.current = event.data.id;
          latestEventSeq.current = -1;
          setLastEvent(null);
        }
        setInstallRun(locallyActiveRun.current);
        setState("installing");
        void refresh().catch((cause) => setError(message(cause)));
        return;
      }
      if (event.eventType === "run-start" && event.data.action === "teardown") {
        const queuedAt = event.data.created ?? new Date().toISOString();
        teardownRunId.current = event.data.id;
        setTeardownRun({ id: event.data.id, action: "teardown", status: 0, queued_at: queuedAt, created_at: queuedAt, updated_at: queuedAt });
        latestTeardownEventSeq.current = -1;
        setTeardownEvent(null);
        setState("tearing-down");
        void refresh().catch((cause) => setError(message(cause)));
        return;
      }
      if (event.eventType !== "run-update") return;
      const runId = event.data.payload.run_id;
      const isInstallUpdate = runId === currentRunId.current;
      const isTeardownUpdate = runId === teardownRunId.current;
      if (!isInstallUpdate && !isTeardownUpdate) return;
      if (event.data.type === "event") {
        if (isTeardownUpdate) applyLiveEvent(event.data.payload, latestTeardownEventSeq, setTeardownEvent);
        else applyLiveEvent(event.data.payload, latestEventSeq, setLastEvent);
      }
      void refresh().catch((cause) => setError(message(cause)));
    });
    return () => { alive = false; refreshVersion.current += 1; unsubscribe(); bridge.wire.end(); };
  }, [bridge, refresh]);

  useEffect(() => { teardownRunId.current = teardownRun?.id ?? null; }, [teardownRun?.id]);

  useEffect(() => {
    if (!isActive(installRun?.status) && !isActive(teardownRun?.status) && !isActive(locallyActiveRun.current?.status)) return;
    const poll = () => { void refresh().catch((cause) => setError(message(cause))); };
    const timer = window.setInterval(poll, 3000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [installRun?.status, teardownRun?.status, refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!commanderConnection) return;
    setBusy(true);
    setError("");
    try {
      const started = await startInstall(caller, defaults, commanderConnection);
      const run: RunItem = { action: "install", status: started.status, id: started.id, queued_at: started.queued_at, created_at: started.queued_at, updated_at: started.queued_at };
      locallyActiveRun.current = run;
      currentRunId.current = run.id;
      latestEventSeq.current = -1;
      setLastEvent(null);
      setInstallRun(run);
      setState("installing");
      await refresh();
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof Error && /Create a Commander connection|approved Commander connection changed/i.test(cause.message)) {
        setCommanderConnection(null);
        setConnectionState("missing");
        setConnectionError(cause.message);
      }
    }
    finally { setBusy(false); }
  };

  const createCommanderConnection = async () => {
    setConnectingCommander(true);
    setConnectionError("");
    setConnectionState("checking");
    try {
      const managerId = await caller.getManager();
      const connection = await resolveCommanderConnection(caller, bridge.wire, managerId);
      setCommanderConnection(connection);
      setConnectionState("ready");
    } catch (cause) {
      setCommanderConnection(null);
      setConnectionError(message(cause));
      setConnectionState("missing");
    } finally { setConnectingCommander(false); }
  };

  const saveClient = async (event: FormEvent) => {
    event.preventDefault(); setSavingClientID(true); setError("");
    try { await saveClientID(caller, clientID); setClientID(clientID.trim()); }
    catch (cause) { setError(message(cause)); }
    finally { setSavingClientID(false); }
  };

  return <main className="install-shell">
    <header className="brand"><span className="brand-mark">C</span><span>Cloudflare Manager<small>Deploy Commander installer</small></span></header>
    <section className="hero"><div className="eyebrow">OBJECT STORAGE · EDGE DELIVERY</div><h1>Install Cloudflare Manager</h1><p>Deploy the manager service once. After it is healthy, Deploy Commander opens the management interface.</p></section>
    <section className="panel commander-connection-panel" aria-labelledby="commander-connection-title">
      <div className="panel-heading"><div><h2 id="commander-connection-title">Deploy Commander connection</h2><p>Approve access to the reserved Commander resource before installing.</p></div><span className={`status-pill status-${connectionState === "ready" ? "installed" : connectionState === "error" ? "unavailable" : "neutral"}`}>{connectionState === "checking" ? "Checking" : connectionState === "ready" ? "Connected" : connectionState === "error" ? "Check failed" : "Required"}</span></div>
      {connectionState === "ready" ? <p className="connection-ready">Commander connection ready</p> : <>
        {connectionState === "missing" && <p className="connection-help">Create the connection and approve it in Deploy Commander. Installation stays unavailable until approval completes.</p>}
        {connectionError && <p className="inline-error" role="alert">{connectionError}</p>}
        <button className="button button-secondary" type="button" onClick={() => void createCommanderConnection()} disabled={connectingCommander || connectionState === "checking"}>{connectingCommander ? "Waiting for approval…" : connectionState === "error" ? "Retry Commander connection" : "Create Commander connection"}</button>
      </>}
    </section>
    <section className="panel" aria-labelledby="install-title">
      <div className="panel-heading"><div><h2 id="install-title">Manager service</h2><p>Install the full stack manager in Deploy Commander.</p></div><span className={`status-pill status-${state}`}>{loading ? "Loading status" : stateLabel(state)}</span></div>
      {installRun && <div className="run-summary" aria-label="install run status"><strong>{statusLabel(installRun.status)}</strong><span>Run {installRun.id}</span><p aria-live="polite">{lastEvent?.message || "Waiting for the first install event…"}</p></div>}
      {teardownRun && <div className="run-summary" aria-label="teardown run status"><strong>{statusLabel(teardownRun.status)}</strong><span>Teardown run {teardownRun.id}</span><p aria-live="polite">{teardownEvent?.message || "Waiting for the first teardown event…"}</p></div>}
      {reloadBlocked && <p role="alert" className="inline-error">Commander did not reload automatically. <button className="button button-secondary" type="button" onClick={() => window.parent.location.reload()}>Reload Commander</button></p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <form className="install-form" onSubmit={(event) => void submit(event)}>
        <button className="button" disabled={loading || busy || state !== "ready" || connectionState !== "ready" || !commanderConnection} type="submit">{busy ? "Starting install…" : state === "ready" ? "Install" : stateLabel(state)}</button>
      </form>
    </section>
    <section className="panel oauth-panel" aria-labelledby="oauth-title">
      <div className="panel-heading"><div><h2 id="oauth-title">Cloudflare OAuth</h2><p>Optional setup. Add a client ID now or later in the manager settings.</p></div></div>
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
      <form className="settings-form" onSubmit={(event) => void saveClient(event)}>
        <label htmlFor="client-id">OAuth client ID</label>
        <input id="client-id" value={clientID} onChange={(event) => setClientID(event.target.value)} autoComplete="off" />
        <div className="settings-actions"><button className="button button-secondary" type="submit" disabled={savingClientID}>{savingClientID ? "Saving…" : "Save client ID"}</button><a className="button button-link" href="https://dash.cloudflare.com/?to=/:account/oauth-clients" target="_blank" rel="noopener noreferrer">Create or get a client ID ↗</a></div>
      </form>
    </section>
    <footer>Cloudflare Manager · Published through Deploy Commander</footer>
  </main>;
}

function applyLiveEvent(event: { run_id: string; seq?: number; message?: string }, latestSeq: { current: number }, setEvent: (event: { seq: number; message: string }) => void): void {
  if (typeof event.seq !== "number" || event.seq <= latestSeq.current || !event.message?.trim()) return;
  latestSeq.current = event.seq;
  setEvent({ seq: event.seq, message: event.message });
}

function stateLabel(state: InstallerUIState): string {
  return ({ ready: "Not installed", installing: "Install run active", installed: "Installed", "tearing-down": "Teardown active", unavailable: "Status unavailable" })[state];
}

function statusLabel(status: number): string {
  return (["Queued", "Running", "Done", "Failed"][status] ?? "Unknown");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Installer request failed";
}

function isActive(status: number | undefined): boolean {
  return status === 0 || status === 1;
}
