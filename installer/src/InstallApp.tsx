import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RunItem } from "@ezenki/deploy-commander-installer-interface";
import { installationState, startInstall, type InstallInput, type InstallationState } from "./installer";
import type { CommanderBridge } from "./commander";
import { loadLatestInstall } from "./runHistory";
import { loadClientID, saveClientID } from "./settings";

interface InstallAppProps {
  bridge: CommanderBridge;
  defaults: InstallInput;
}

type InstallerUIState = InstallationState | "unavailable";

export function InstallApp({ bridge, defaults }: InstallAppProps) {
  const { caller } = bridge;
  const [clientID, setClientID] = useState("");
  const [state, setState] = useState<InstallerUIState>("ready");
  const [installRun, setInstallRun] = useState<RunItem | null>(null);
  const [lastEvent, setLastEvent] = useState<{ seq: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingClientID, setSavingClientID] = useState(false);
  const [error, setError] = useState("");
  const currentRunId = useRef<string | null>(null);
  const locallyActiveRun = useRef<RunItem | null>(null);
  const latestEventSeq = useRef(-1);
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [snapshot, teardown] = await Promise.all([
      loadLatestInstall(caller),
      caller.getLatestRun({ action: "teardown" }),
    ]);
    if (version !== refreshVersion.current) return;
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
    setState(installationState(snapshot?.run ?? null, teardown));
    if (snapshot?.lastEvent && snapshot.lastEvent.seq >= latestEventSeq.current) {
      latestEventSeq.current = snapshot.lastEvent.seq;
      if (snapshot.lastEvent.message.trim()) setLastEvent(snapshot.lastEvent);
    }
  }, [caller]);

  useEffect(() => {
    let alive = true;
    void refresh().catch((cause) => { if (alive) { setError(message(cause)); setState("unavailable"); } }).finally(() => { if (alive) setLoading(false); });
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
      if (event.eventType !== "run-update" || event.data.payload.run_id !== currentRunId.current) return;
      if (event.data.type === "event") applyLiveEvent(event.data.payload, latestEventSeq, setLastEvent);
      void refresh().catch((cause) => setError(message(cause)));
    });
    return () => { alive = false; refreshVersion.current += 1; unsubscribe(); bridge.wire.end(); };
  }, [bridge, refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const started = await startInstall(caller, bridge.wire, defaults);
      const run: RunItem = { action: "install", status: started.status, id: started.id, queued_at: started.queued_at, created_at: started.queued_at, updated_at: started.queued_at };
      locallyActiveRun.current = run;
      currentRunId.current = run.id;
      latestEventSeq.current = -1;
      setLastEvent(null);
      setInstallRun(run);
      setState("installing");
      await refresh();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
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
    <section className="panel" aria-labelledby="install-title">
      <div className="panel-heading"><div><h2 id="install-title">Manager service</h2><p>Install the full stack manager in Deploy Commander.</p></div><span className={`status-pill status-${state}`}>{loading ? "Loading status" : stateLabel(state)}</span></div>
      {installRun && <div className="run-summary" aria-label="install run status"><strong>{statusLabel(installRun.status)}</strong><span>Run {installRun.id}</span><p aria-live="polite">{lastEvent?.message || "Waiting for the first install event…"}</p></div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <form className="install-form" onSubmit={(event) => void submit(event)}>
        <button className="button" disabled={loading || busy || state !== "ready"} type="submit">{busy ? "Starting install…" : state === "ready" ? "Install" : stateLabel(state)}</button>
      </form>
    </section>
    <section className="panel oauth-panel" aria-labelledby="oauth-title">
      <div className="panel-heading"><div><h2 id="oauth-title">Cloudflare OAuth</h2><p>Optional setup. Add a client ID now or later in the manager settings.</p></div></div>
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
