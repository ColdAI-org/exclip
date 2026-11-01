/** The pieces of tokenised stocks the Stocks screen and the trade sheet share: the badge, the disclaimer, where the
 * visitor stands, and the eligibility form (the disclosures and the four statements). The wording is in
 * @exclip/config/stocks, so the app, the wallet window and the server say the same thing. */
import { useRef, useState, type FormEvent } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  STOCK_BADGE, STOCK_REFUSALS, STOCK_STATEMENTS, STOCKS_ATTESTATION_DAYS, stocksDisclaimer, stocksDisclosures,
  type StockStatementId,
} from "@exclip/config/stocks";
import { ApiError } from "../lib/api";
import { BRAND } from "../lib/brand";
import { confirmStatements, countryName, type StockEligibility } from "../lib/stocks";
import { Sheet } from "./Sheet";

/** Who runs this deployment, as the disclaimer names it: brand.operator, else the brand's name. */
const operatorName = () => BRAND.operator || BRAND.name;

const day = (iso: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
};

export function StockBadge() {
  return <span className="x-stock-tag">{STOCK_BADGE}</span>;
}

export function StockDisclaimer() {
  return <p className="x-banner x-banner-warn x-stock-note" role="note">{stocksDisclaimer(operatorName())}</p>;
}

/** Whether the visitor may trade stocks, from the server's answer, with the one thing they can do about it. */
export function StockAccess({ eligibility, onConfirm }: { eligibility: UseQueryResult<StockEligibility, Error>; onConfirm: () => void }) {
  const { data, error, isLoading, refetch } = eligibility;
  if (isLoading) return <p className="x-muted" role="status">Checking whether you can trade tokenised stocks…</p>;
  if (!data) {
    return (
      <div className="x-banner x-banner-warn x-banner-action" role="alert">
        <p>{error?.message || "Couldn't check whether you can trade tokenised stocks."}</p>
        <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={() => void refetch()}>Try again</button>
      </div>
    );
  }
  if (data.eligible) {
    const until = day(data.expiresAt);
    return (
      <div className="x-banner x-banner-action" role="status">
        <p>You've confirmed the statements{data.country ? ` for ${countryName(data.country)}` : ""}{until ? `, until ${until}` : ""}.</p>
        <button type="button" className="x-btn x-btn-ghost x-btn-sm" onClick={onConfirm}>Read them again</button>
      </div>
    );
  }
  if (data.code === "SELF_CERT_REQUIRED") {
    return (
      <div className="x-banner x-banner-action" role="status">
        <p>{STOCK_REFUSALS.SELF_CERT_REQUIRED}</p>
        <button type="button" className="x-btn x-btn-primary x-btn-sm" onClick={onConfirm}>Read and confirm</button>
      </div>
    );
  }
  return <p className="x-banner x-banner-warn" role="status">{STOCK_REFUSALS[data.code ?? "STOCKS_DISABLED"]}</p>;
}

/** The disclosures, then the statements, each ticked by the user. Confirming sends the ticked ids and the terms version
 * shown; the server signs an attestation only when all are there and the terms are still current. */
export function EligibilityForm({ termsVersion, onDone }: { termsVersion: string | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [ticked, setTicked] = useState<ReadonlySet<StockStatementId>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxes = useRef(new Map<StockStatementId, HTMLInputElement>());

  const tick = (id: StockStatementId, on: boolean) => setTicked(prev => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const missing = STOCK_STATEMENTS.find(s => !ticked.has(s.id));
    if (missing) {
      setError("Confirm every statement to continue.");
      boxes.current.get(missing.id)?.focus();
      return;
    }
    if (!termsVersion) { setError(STOCK_REFUSALS.STOCKS_DISABLED); return; }
    setBusy(true);
    setError(null);
    try {
      await confirmStatements(termsVersion, STOCK_STATEMENTS.map(s => s.id).filter(id => ticked.has(id)));
      onDone();
    } catch (err) {
      // New terms since this page loaded: fetch them, so the version confirmed next is the one in force.
      if (err instanceof ApiError && err.code === "TERMS_CHANGED") void queryClient.invalidateQueries({ queryKey: ["exclip", "config"] });
      setError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="x-stock-form" onSubmit={submit} noValidate>
      <div className="x-stock-disclosures">
        {stocksDisclosures(operatorName()).map(text => <p key={text}>{text}</p>)}
      </div>
      <fieldset className="x-stock-statements">
        <legend className="x-strong">Confirm each statement</legend>
        {STOCK_STATEMENTS.map(s => (
          <label key={s.id} className="x-check">
            <input
              type="checkbox"
              ref={el => { if (el) boxes.current.set(s.id, el); else boxes.current.delete(s.id); }}
              checked={ticked.has(s.id)}
              onChange={e => tick(s.id, e.target.checked)}
            />
            <span>{s.text}</span>
          </label>
        ))}
      </fieldset>
      <p className="x-muted x-small">
        Your confirmation is kept in this browser for {STOCKS_ATTESTATION_DAYS} days, for the country you're in now.
        {termsVersion ? ` Terms version ${termsVersion}.` : ""}
      </p>
      {error ? <p className="x-banner x-banner-warn" role="alert">{error}</p> : null}
      <button type="submit" className="x-btn x-btn-primary x-btn-block x-btn-lg" disabled={busy}>
        {busy ? <><Loader2 className="x-spin" size={18} aria-hidden="true" /> Confirming…</> : "Confirm"}
      </button>
    </form>
  );
}

export const ELIGIBILITY_TITLE = "Before you trade tokenised stocks";

export function EligibilitySheet({ open, termsVersion, onClose, onDone }: { open: boolean; termsVersion: string | null; onClose: () => void; onDone: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={ELIGIBILITY_TITLE}>
      {open ? <EligibilityForm termsVersion={termsVersion} onDone={onDone} /> : null}
    </Sheet>
  );
}
