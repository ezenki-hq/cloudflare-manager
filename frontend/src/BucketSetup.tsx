import { useEffect, useRef, useState } from "react";
import type { InterfaceResponse } from "@ezenki/deploy-commander-installer-interface";
import type { Account, BackendAPI, Zone } from "./api";
import type { CommanderBridge } from "./commander";
import { BucketSetupError, setupBucket, type BucketProgress, type BucketRequest, type BucketSelection } from "./bucketWorkflow";

interface BucketSetupProps {
  request: BucketRequest;
  api: BackendAPI;
  bridge: CommanderBridge;
  backendOrigin: string;
  onClose(response: InterfaceResponse): void;
}

type AuthState = "checking" | "signed-out" | "signed-in" | "unavailable";

export function BucketSetup({ request, api, bridge, backendOrigin, onClose }: BucketSetupProps) {
  const popupRef = useRef<Window | null>(null);
  const [manager, setManager] = useState("");
  const [auth, setAuth] = useState<AuthState>("checking");
  const [authError, setAuthError] = useState("");
  const [clientId, setClientId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [accountId, setAccountId] = useState(request.suggested?.account_id ?? "");
  const [jurisdiction, setJurisdiction] = useState(request.suggested?.jurisdiction ?? "default");
  const [bucket, setBucket] = useState(request.suggested?.bucket ?? "");
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [domain, setDomain] = useState(request.suggested?.domain ?? "");
  const [zoneId, setZoneId] = useState(request.suggested?.zone_id ?? "");
  const [progress, setProgress] = useState<BucketProgress | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void bridge.caller.getManager().then((value) => { if (live) setManager(value); }).catch(() => undefined);
    void api.clientID().then((value) => { if (live) setClientId(value); }).catch(() => undefined);
    void api.session().then((session) => { if (live) setAuth(session.authenticated ? "signed-in" : "signed-out"); }).catch((failure) => {
      if (live) { setAuth("unavailable"); setAuthError(failure instanceof Error ? failure.message : "The Cloudflare session could not be checked"); }
    });
    return () => { live = false; popupRef.current?.close(); popupRef.current = null; };
  }, [api, bridge]);

  useEffect(() => {
    if (auth !== "signed-in") return;
    let live = true;
    void api.listAccounts().then((items) => {
      if (!live) return;
      setAccounts(items);
      setAccountId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
    }).catch((failure) => setError(failure instanceof Error ? failure.message : "Cloudflare accounts could not be loaded"));
    return () => { live = false; };
  }, [api, auth]);

  useEffect(() => {
    if (auth !== "signed-in" || !accountId) { setZones([]); return; }
    let live = true;
    void api.listZones(accountId).then((items) => {
      if (!live) return;
      setZones(items);
      setZoneId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
    }).catch((failure) => { if (live) setError(failure instanceof Error ? failure.message : "Cloudflare zones could not be loaded"); });
    return () => { live = false; };
  }, [api, auth, accountId]);

  useEffect(() => {
    const expectedOrigin = originOf(backendOrigin);
    const listener = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin || event.source !== popupRef.current || event.data?.type !== "cloudflare-oauth-complete" || typeof event.data.session_handle !== "string" || !event.data.session_handle.trim()) return;
      api.setSessionHandle(event.data.session_handle);
      void api.session().then((session) => {
        if (session.authenticated) { popupRef.current = null; setAuth("signed-in"); setAuthError(""); }
        else { api.clearSessionHandle(); setAuthError("Cloudflare authorization completed, but the manager rejected the session. Try again."); }
      }).catch((failure) => {
        if (statusOf(failure) === 401) { api.clearSessionHandle(); setAuthError("Cloudflare authorization completed, but the manager rejected the session. Try again."); }
        else setAuthError(failure instanceof Error ? failure.message : "The Cloudflare session could not be checked");
      });
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [api, backendOrigin]);

  const signIn = () => {
    const popup = window.open("about:blank", "cloudflare-oauth", "popup,width=640,height=760");
    popupRef.current = popup;
    if (!popup) { setAuthError("Allow popups for this Deploy Commander site, then try again."); return; }
    setAuthError("");
    void api.startOAuth(clientId, window.location.origin, originOf(backendOrigin)).then(({ authorization_url }) => {
      if (popupRef.current === popup) popup.location.href = authorization_url;
    }).catch((failure) => {
      popup.close(); popupRef.current = null;
      setAuthError(failure instanceof Error ? failure.message : "Cloudflare sign in could not be started");
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const selection: BucketSelection = { accountId, jurisdiction, bucket, mode, ...(domain.trim() ? { domain: domain.trim(), zoneId } : {}) };
    try {
      const result = await setupBucket(bridge.caller, api, request, selection, setProgress);
      onClose({ manager: result.resource.manager, ok: true, result });
    } catch (failure) {
      if (failure instanceof BucketSetupError) {
        setProgress(failure.progress);
        setError(failure.message);
        if (failure.progress.bucketExists) setMode("existing");
      } else setError("Bucket setup could not be completed. You can retry without removing completed resources.");
    } finally { setBusy(false); }
  };

  const cancel = async () => onClose({ manager: manager || await bridge.caller.getManager().catch(() => ""), ok: false, error: { message: "Bucket setup was cancelled" } });

  return <main className="bucket-child-page">
    <section className="panel bucket-child-panel">
      <div className="panel-kicker">CLOUDFLARE MANAGER</div>
      <h1>Create an R2 bucket resource</h1>
      <p>Choose an account and bucket. Cloudflare changes start only after you confirm this form.</p>
      {auth === "checking" && <p role="status">Checking Cloudflare sign in…</p>}
      {auth === "signed-out" && <div className="bucket-child-auth"><p>Sign in to Cloudflare to choose an account and manage R2 buckets.</p><button className="button button-primary" onClick={signIn}>Sign in to Cloudflare</button>{authError && <p className="inline-error" role="alert">{authError}</p>}</div>}
      {auth === "unavailable" && <div className="bucket-child-auth"><p role="alert">The Cloudflare session could not be checked.</p><button className="button button-secondary" onClick={() => { setAuth("checking"); void api.session().then((session) => setAuth(session.authenticated ? "signed-in" : "signed-out")).catch(() => setAuth("unavailable")); }}>Try again</button>{authError && <p className="inline-error">{authError}</p>}</div>}
      {auth === "signed-in" && <form className="bucket-child-form" onSubmit={submit}>
        <label>Account<select aria-label="Account" required value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select an account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label>Jurisdiction<select aria-label="Jurisdiction" value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value)}>{["default", "eu", "us", "fedramp", "fedramp-high"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Bucket mode<select aria-label="Bucket mode" value={mode} onChange={(event) => setMode(event.target.value as "create" | "existing")}><option value="create">Create a new bucket</option><option value="existing">Use an existing bucket</option></select></label>
        <label>Bucket name<input aria-label="Bucket name" required minLength={3} maxLength={63} pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" value={bucket} onChange={(event) => setBucket(event.target.value)} /></label>
        <label>CDN hostname (optional)<input aria-label="CDN hostname (optional)" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="cdn.example.com" /></label>
        {domain.trim() && <label>Cloudflare zone<select aria-label="Cloudflare zone" required value={zoneId} onChange={(event) => setZoneId(event.target.value)}><option value="">Select a zone</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>}
        {progress && <div className="bucket-progress" role="status"><strong>Setup progress</strong><ul>{progress.bucketExists && <li>Bucket exists</li>}{progress.resourceId && <li>Bucket resource registered</li>}{progress.domainAttached && <li>CDN domain attached</li>}{progress.lastCompleted === "primary" && <li>Primary domain saved</li>}</ul></div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="bucket-child-actions"><button className="button button-quiet" type="button" onClick={cancel} disabled={busy}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || !accounts.length}>{busy ? "Setting up…" : error ? "Retry setup" : mode === "create" ? "Create bucket and resource" : "Use bucket and create resource"}</button></div>
      </form>}
    </section>
  </main>;
}

function originOf(value: string): string { try { return new URL(value || window.location.origin, window.location.origin).origin; } catch { return window.location.origin; } }
function statusOf(error: unknown): number | undefined { return isRecord(error) && typeof error.status === "number" ? error.status : undefined; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
