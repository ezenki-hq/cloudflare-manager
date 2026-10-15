import { useState } from "react";
import type { Bucket, Domain, Zone } from "../api";

interface BucketDetailProps {
  bucket: Bucket;
  domains: Domain[];
  zones: Zone[];
  tracked: boolean;
  onTrack(): void;
  onAttach(domain: string, zoneId: string): void;
  onDetach(domain: string): void;
  onPrimary(domain?: string): void;
  onDelete(): void;
}

export function BucketDetail({ bucket, domains, zones, tracked, onTrack, onAttach, onDetach, onPrimary, onDelete }: BucketDetailProps) {
  return <section className="panel" aria-labelledby="bucket-detail-title">
    <div className="panel-kicker">BUCKET DETAILS</div>
    <div className="panel-heading">
      <div><h2 id="bucket-detail-title">{bucket.name}</h2><p>{bucket.jurisdiction ?? "default"} jurisdiction · Cloudflare is the source of truth</p></div>
      <button className="button button-danger-quiet" onClick={onDelete}>Delete bucket</button>
    </div>
    {!tracked && <div className="track-callout"><span>This bucket is not registered as a Deploy Commander resource.</span><button className="button button-secondary" onClick={onTrack}>Track bucket</button></div>}
    <div className="section-rule" />
    <div className="subheading-row"><div><h3>Custom CDN domains</h3><p>Attach a hostname from an accessible Cloudflare zone.</p></div></div>
    {domains.length ? <ul className="domain-list">{domains.map((domain) => {
      const status = isRecord(domain.status) ? domain.status : {};
      return <li key={domain.domain}>
        <div className="domain-main"><strong>{domain.domain}</strong><span className={domain.enabled ? "status-live" : "status-neutral"}>{domain.enabled ? "Enabled" : "Disabled"}</span></div>
        <div className="domain-status">Ownership: {label(status.ownership)} <span>·</span> TLS: {label(status.ssl)}</div>
        <div className="domain-actions"><button className="text-button" onClick={() => onPrimary(domain.domain)}>Set primary</button><button className="text-button text-danger" onClick={() => onDetach(domain.domain)}>Detach</button></div>
      </li>;
    })}</ul> : <div className="empty-row">No custom domains are attached.</div>}
    <DomainForm zones={zones} onAttach={onAttach} />
    {tracked && <p className="form-hint">Primary CDN domain is stored as nonsecret resource metadata.</p>}
  </section>;
}

function DomainForm({ zones, onAttach }: { zones: Zone[]; onAttach(domain: string, zoneId: string): void }) {
  const [domain, setDomain] = useState("");
  const [zone, setZone] = useState(zones[0]?.id ?? "");
  return <form className="domain-form" onSubmit={(event) => { event.preventDefault(); if (domain.trim() && zone) { onAttach(domain.trim(), zone); setDomain(""); } }}>
    <label>Custom hostname<input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="cdn.example.com" /></label>
    <label>Cloudflare zone<select value={zone} onChange={(event) => setZone(event.target.value)} disabled={!zones.length}><option value="">Select a zone</option>{zones.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <button className="button button-secondary" type="submit" disabled={!domain.trim() || !zone}>Attach domain</button>
  </form>;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function label(value: unknown): string { return typeof value === "string" ? value : "Pending"; }
