'use client';

/**
 * "Send reminder" client control. Posts to /api/debtors/[id]/remind and, on
 * PRINT, opens the returned statement document in a new print-ready window.
 *
 * Server-side cooldown prevents duplicate sends; we also debounce locally to
 * block double-clicks. CSRF uses the double-submit cookie (sc_csrf).
 */
import { useState } from 'react';
import { csrfHeaders } from '@/lib/ui/csrf';

export default function RemindButton({ studentId, invoiceId }: { studentId: string; invoiceId?: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    if (state !== 'idle') return;
    setState('sending'); setErr(null);
    try {
      const res = await fetch(`/api/debtors/${studentId}/remind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        credentials: 'same-origin',
        body: JSON.stringify({ channel: 'PRINT', invoiceId: invoiceId ?? undefined, includeAll: !invoiceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data?.error?.message ?? 'Failed to send reminder');
        setState('idle');
        return;
      }
      // Open print window with the rendered document.
      openPrint(data.document);
      setState('sent');
      setTimeout(() => setState('idle'), 3000);
    } catch (e: any) {
      setErr(e?.message ?? 'Network error');
      setState('idle');
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={state !== 'idle'}
        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium disabled:opacity-60"
        style={{ backgroundColor: 'var(--color-gold-tint,#fbf1d1)', color: 'var(--color-gold-dark,#8a6b11)', border: '1px solid var(--color-gold,#c2922d)' }}
        title="Print a payment reminder for this account"
      >
        {state === 'sending' ? 'Preparing…' : state === 'sent' ? 'Sent' : 'Print reminder'}
      </button>
      {err && <span className="text-[11px]" style={{ color: 'var(--color-danger,#a82a1c)' }}>{err}</span>}
    </span>
  );
}

function openPrint(doc: { orgName: string; studentName: string; subject: string; body: string;
  invoices: Array<{invoiceNumber: string; dueDate: string|null; remainingKobo: number; daysOverdue: number}>;
  totalKobo: number; generatedAt: string }) {
  const w = window.open('', '_blank', 'width=720,height=900');
  if (!w) return;
  const rows = doc.invoices.map(i => `<tr><td>${escapeHtml(i.invoiceNumber)}</td><td>${escapeHtml(i.dueDate ?? '—')}</td><td>${i.daysOverdue>0?`${i.daysOverdue} days`:''}</td><td style="text-align:right">${fmt(i.remainingKobo)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.subject)}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; color:#111; padding:40px; max-width:720px; margin:0 auto; }
      h1 { font-size:20px; margin:0 0 4px 0; }
      h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:#666; margin:24px 0 8px; font-weight:600; }
      .muted { color:#666; font-size:12px; }
      table { width:100%; border-collapse:collapse; margin-top:8px; }
      th, td { padding:8px 6px; border-bottom:1px solid #e5e5e5; font-size:13px; text-align:left; }
      th { background:#f6f2e7; font-weight:600; }
      td.r, th.r { text-align:right; }
      .total { font-weight:700; font-size:16px; }
      pre { white-space:pre-wrap; font-family:inherit; font-size:13px; line-height:1.55; background:#faf7ee; padding:16px; border:1px solid #e8e1c5; border-radius:4px; }
      @media print { body { padding:24px; } button { display:none; } }
    </style></head><body>
    <div class="muted">${escapeHtml(doc.orgName)} · Bursary</div>
    <h1>Payment Reminder</h1>
    <div class="muted">Student: <strong>${escapeHtml(doc.studentName)}</strong> &nbsp;·&nbsp; Generated ${new Date(doc.generatedAt).toLocaleString()}</div>
    <h2>Outstanding Invoices</h2>
    <table><thead><tr><th>Invoice</th><th>Due</th><th>Overdue</th><th class="r">Balance</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3" class="r total">Total outstanding</td><td class="r total">${fmt(doc.totalKobo)}</td></tr></tfoot>
    </table>
    <h2>Message to parent/guardian</h2>
    <pre>${escapeHtml(doc.body)}</pre>
    <div style="margin-top:32px" class="muted">This reminder is logged in SCOLAIRA for audit.</div>
    <div style="margin-top:16px"><button onclick="window.print()" style="padding:8px 16px;background:#2f4f3b;color:#fff;border:0;border-radius:4px;cursor:pointer">Print</button></div>
  </body></html>`);
  w.document.close();
}

function fmt(k: number) {
  return '₦' + (k/100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
}
