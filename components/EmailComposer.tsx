"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type {
  EmailRecipient,
  EmailSendResult,
} from "@/lib/types";
import type { EmailTemplate } from "@/lib/emailTemplates";

// Task 5 — compose + send a templated email to the client and/or caregivers.
// Server-side send, visibility-gated. Deliverability is domain-gated (see the
// caveat banner): sends may land in spam until SPF/DKIM/DMARC are set up.
export default function EmailComposer({
  opportunityId,
  ssoBlob,
  context,
  onClose,
}: {
  opportunityId: string;
  ssoBlob: string | null;
  context: { clientFirst: string; clientLast: string; office: string; stage: string };
  onClose: () => void;
}) {
  const [recipients, setRecipients] = useState<EmailRecipient[] | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesSource, setTemplatesSource] = useState<"ghl" | "config">(
    "config",
  );
  const [loadErr, setLoadErr] = useState<unknown>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cc, setCc] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<EmailSendResult[] | null>(null);
  const [sendErr, setSendErr] = useState<unknown>(null);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (ssoBlob) h["x-ghl-sso-key"] = ssoBlob;
    return h;
  }, [ssoBlob]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/opportunities/${opportunityId}/email`, {
      headers: headers(),
      cache: "no-store",
    })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(res, j);
        if (cancelled) return;
        const recs: EmailRecipient[] = j.recipients || [];
        setRecipients(recs);
        setTemplates(j.templates || []);
        setTemplatesSource(j.templatesSource === "ghl" ? "ghl" : "config");
        // Pre-select the client by default.
        setSelected(
          new Set(recs.filter((r) => r.role === "client").map((r) => r.contactId)),
        );
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e);
      });
    return () => {
      cancelled = true;
    };
  }, [opportunityId, headers]);

  const firstCaregiver = useMemo(
    () => (recipients || []).find((r) => r.role === "caregiver")?.name || "",
    [recipients],
  );

  const fillTokens = useCallback(
    (s: string) =>
      s
        .replace(/\{\{clientFirst\}\}/g, context.clientFirst || "")
        .replace(/\{\{clientLast\}\}/g, context.clientLast || "")
        .replace(
          /\{\{clientName\}\}/g,
          `${context.clientFirst} ${context.clientLast}`.trim(),
        )
        .replace(/\{\{caregiverName\}\}/g, firstCaregiver)
        .replace(/\{\{office\}\}/g, context.office || "")
        .replace(/\{\{stage\}\}/g, context.stage || ""),
    [context, firstCaregiver],
  );

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setSubject(fillTokens(t.subject));
      setBody(fillTokens(t.body));
    }
  };

  const toggle = (contactId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });

  const selectedRecipients = (recipients || []).filter((r) =>
    selected.has(r.contactId),
  );
  const ccList = cc
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const canSend =
    selectedRecipients.length > 0 && subject.trim() && body.trim() && !sending;

  const send = async () => {
    setSending(true);
    setSendErr(null);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/email`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          recipientContactIds: [...selected],
          subject,
          html: body,
          cc: ccList,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setResults(j.results || []);
    } catch (e) {
      setSendErr(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="emailbox" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Send Email</span>
          <button
            className="x"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="emailbody">
          <div className="emailcaveat">
            ⚠️ Deliverability depends on the Miracle Makers sending domain being
            authenticated (SPF/DKIM/DMARC). Until then, messages may land in spam.
            Avoid bulk test sends to real addresses.
          </div>

          {loadErr ? (
            <ErrorMessage error={loadErr} className="savemsg err" />
          ) : recipients === null ? (
            <div className="cgmuted">Loading recipients…</div>
          ) : results ? (
            <div className="emailresults">
              <div className="istep">Results</div>
              <ul className="cglist">
                {results.map((r) => (
                  <li key={r.contactId} className="cgitem">
                    <span className="cgname" style={{ color: "var(--ink)" }}>
                      {r.name}
                    </span>
                    {r.ok ? (
                      <span className="ok" style={{ fontWeight: 700 }}>
                        ✓ sent
                      </span>
                    ) : (
                      <span className="bad" title={r.error} style={{ fontWeight: 700 }}>
                        ✗ failed
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {results.some((r) => !r.ok) ? (
                <div className="imeta">
                  Failures often mean the domain isn&apos;t authenticated yet, or the
                  PIT lacks the email-send scope.
                </div>
              ) : null}
              <button className="ireset" type="button" onClick={onClose}>
                Close
              </button>
            </div>
          ) : confirming ? (
            <div className="emailconfirm">
              <div className="istep">Confirm send</div>
              <div className="imeta" style={{ marginBottom: 8 }}>
                To:{" "}
                <b>
                  {selectedRecipients.map((r) => r.name).join(", ") || "—"}
                </b>
                {ccList.length ? ` · cc: ${ccList.join(", ")}` : ""}
              </div>
              <div className="emailpreview">
                <div className="epsub">{subject}</div>
                {/^\s*<[a-z][\s\S]*>/i.test(body) ? (
                  <div
                    className="epbody ephtml"
                    // Template HTML comes from GHL's builder / our config — trusted, internal use.
                    dangerouslySetInnerHTML={{ __html: body }}
                  />
                ) : (
                  <div className="epbody">{body}</div>
                )}
              </div>
              {sendErr ? <ErrorMessage error={sendErr} className="savemsg err" /> : null}
              <div className="inav">
                <button
                  type="button"
                  className="ighost"
                  disabled={sending}
                  onClick={() => setConfirming(false)}
                >
                  ← Edit
                </button>
                <button
                  type="button"
                  className="ibtn"
                  disabled={sending}
                  onClick={send}
                >
                  {sending ? "Sending…" : `Send to ${selectedRecipients.length}`}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* recipients */}
              <div className="istep">Recipients</div>
              <div className="emailrecips">
                {recipients.length === 0 ? (
                  <div className="cgmuted">No contacts found for this record.</div>
                ) : (
                  recipients.map((r) => (
                    <label key={r.contactId} className="emailrecip">
                      <input
                        type="checkbox"
                        checked={selected.has(r.contactId)}
                        onChange={() => toggle(r.contactId)}
                      />
                      <span className="errole">{r.role}</span>
                      <span className="ername">{r.name}</span>
                      <span className="eremail">
                        {r.email || "no email on file"}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <label className="emaillbl">Also cc (comma-separated emails)</label>
              <input
                className="cgsearch"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="relative@example.com, …"
              />

              {/* template + message */}
              <div className="istep" style={{ marginTop: 14 }}>
                Message
                <span className="tplsrc">
                  {templatesSource === "ghl"
                    ? "live from GoHighLevel"
                    : "config fallback"}
                </span>
              </div>
              <select
                className="emailtpl"
                value={templateId}
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">Choose a template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                className="cgsearch"
                style={{ marginTop: 8 }}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
              />
              <textarea
                className="emailta"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your message…"
                rows={9}
              />

              <div className="inav">
                <button type="button" className="ighost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="ibtn"
                  disabled={!canSend}
                  onClick={() => {
                    setSendErr(null);
                    setConfirming(true);
                  }}
                >
                  Review &amp; send →
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
