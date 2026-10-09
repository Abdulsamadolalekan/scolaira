'use client';
/**
 * Guardians panel — the write path the audit found missing.
 *
 * A school could previously SEE that a child had no guardian (the debtors
 * register rendered '—') and had no way to record one. This panel is where a
 * bursar records the person actually responsible for a child: name, phone,
 * relationship, and who to ring first.
 *
 * DESIGN NOTES (restrained, per the existing visual direction):
 *   - no new visual language: Card, Badge, Button, Input, Select are the
 *     existing primitives; the radius ladder (2/3/6) and the border/palette
 *     tokens are unchanged;
 *   - state is never conveyed by colour alone — "Primary" is a labelled badge,
 *     and an unreachable contact is stated in words, not implied by a tint;
 *   - gold is not used as a button or background (standing rule).
 *
 * FAILURE BEHAVIOUR (Phase 9 discipline):
 *   - the submit button disables while in flight, so a double-tap cannot create
 *     two guardians; an Idempotency-Key is sent so that even a retried request
 *     replays rather than duplicating;
 *   - an error is shown in place, with the server's own message, and the typed
 *     values are NOT cleared, so the user never has to re-enter a phone number
 *     because the network blipped.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { csrfHeaders } from '@/lib/ui/csrf';

export type GuardianRow = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  relationship: string;
  isPrimary: boolean;
};

const RELATIONSHIPS = ['PARENT', 'GUARDIAN', 'SPONSOR', 'OTHER'] as const;

function relationshipLabel(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function reachable(g: { phone: string | null; email: string | null }): boolean {
  return Boolean(g.phone?.trim() || g.email?.trim());
}

type Draft = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  relationship: string;
};

const EMPTY_DRAFT: Draft = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  relationship: 'PARENT',
};

export default function GuardiansPanel({
  studentId,
  initial,
  canManage,
}: {
  studentId: string;
  initial: GuardianRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<GuardianRow[]>(initial);
  const [adding, setAdding] = useState(initial.length === 0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);

  async function send(
    url: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    who: string,
  ): Promise<{ ok: boolean; data: unknown }> {
    setBusy(who);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          // Financial-grade mutation hygiene: a retry must replay, not duplicate.
          'Idempotency-Key': crypto.randomUUID(),
          ...csrfHeaders(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (data as { error?: { message?: string } })?.error?.message ??
            'That change could not be saved. Nothing was altered.',
        );
        return { ok: false, data };
      }
      return { ok: true, data };
    } catch {
      setError('Network error. Nothing was saved — check your connection and try again.');
      return { ok: false, data: null };
    } finally {
      setBusy(null);
    }
  }

  function applyGuardians(data: unknown) {
    const next = (data as { guardians?: GuardianRow[] })?.guardians;
    if (Array.isArray(next)) setRows(next);
    router.refresh();
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      setError('A guardian needs at least a first and last name.');
      return;
    }
    const payload: Record<string, string> = {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      relationship: draft.relationship,
    };
    if (draft.phone.trim()) payload.phone = draft.phone.trim();
    if (draft.email.trim()) payload.email = draft.email.trim();

    const { ok, data } = await send(`/api/students/${studentId}/guardians`, 'POST', payload, 'add');
    if (ok) {
      applyGuardians(data);
      setDraft(EMPTY_DRAFT);
      setAdding(false);
    }
  }

  async function onMakePrimary(guardianId: string) {
    const { ok, data } = await send(
      `/api/students/${studentId}/guardians/${guardianId}`,
      'PATCH',
      { isPrimary: true },
      `primary-${guardianId}`,
    );
    if (ok) applyGuardians(data);
  }

  async function onSaveEdit(guardianId: string) {
    if (!editDraft.firstName.trim() || !editDraft.lastName.trim()) {
      setError('A guardian needs at least a first and last name.');
      return;
    }
    const { ok, data } = await send(
      `/api/guardians/${guardianId}`,
      'PATCH',
      {
        firstName: editDraft.firstName.trim(),
        lastName: editDraft.lastName.trim(),
        // Explicit nulls clear a field the school no longer has.
        phone: editDraft.phone.trim() || null,
        email: editDraft.email.trim() || null,
      },
      `edit-${guardianId}`,
    );
    if (ok) {
      const updated = (data as { guardian?: GuardianRow })?.guardian;
      if (updated) {
        setRows((prev) =>
          prev.map((r) =>
            r.id === guardianId
              ? {
                  ...r,
                  firstName: updated.firstName,
                  lastName: updated.lastName,
                  phone: updated.phone,
                  email: updated.email,
                }
              : r,
          ),
        );
      }
      setEditing(null);
      router.refresh();
    }
  }

  async function onUnlink(guardianId: string) {
    const { ok, data } = await send(
      `/api/students/${studentId}/guardians/${guardianId}`,
      'DELETE',
      undefined,
      `unlink-${guardianId}`,
    );
    if (ok) applyGuardians(data);
  }

  const hasReachable = rows.some(reachable);

  return (
    <div>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-sm border px-3 py-2 text-[12px]"
          style={{
            borderColor: 'rgba(168,42,28,.28)',
            backgroundColor: 'rgba(168,42,28,.06)',
            color: 'var(--color-danger,#a82a1c)',
          }}
        >
          {error}
        </div>
      )}

      {/* Shown whenever there is nobody to ring — including while the form is
          open, so the reason the form appeared is never lost. */}
      {rows.length === 0 && (
        <div className="px-4 pt-5 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            No guardian is recorded for this student.
          </p>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
            Collections cannot reach anyone until one is added.
          </p>
          {canManage && !adding && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => setAdding(true)}
            >
              Add guardian
            </Button>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <>
          {!hasReachable && (
            <div
              className="mb-3 rounded-sm border px-3 py-2 text-[12px]"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'var(--color-bg-page)',
                color: 'var(--color-text-secondary)',
              }}
            >
              No phone number or email is recorded for any guardian, so this student cannot be
              contacted about fees yet.
            </div>
          )}
          <ul>
            {rows.map((g) => (
              <li
                key={g.id}
                className="px-4 py-3"
                style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
              >
                {editing === g.id ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label htmlFor={`fn-${g.id}`}>First name</Label>
                        <Input
                          id={`fn-${g.id}`}
                          value={editDraft.firstName}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, firstName: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor={`ln-${g.id}`}>Last name</Label>
                        <Input
                          id={`ln-${g.id}`}
                          value={editDraft.lastName}
                          onChange={(e) => setEditDraft({ ...editDraft, lastName: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor={`ph-${g.id}`}>Phone</Label>
                        <Input
                          id={`ph-${g.id}`}
                          inputMode="tel"
                          value={editDraft.phone}
                          onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor={`em-${g.id}`}>Email</Label>
                        <Input
                          id={`em-${g.id}`}
                          type="email"
                          value={editDraft.email}
                          onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={busy === `edit-${g.id}`}
                        onClick={() => onSaveEdit(g.id)}
                      >
                        {busy === `edit-${g.id}` ? 'Saving…' : 'Save'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[13px] font-medium"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {g.firstName} {g.lastName}
                        </span>
                        {g.isPrimary && <Badge variant="forest">Primary</Badge>}
                      </div>
                      <div
                        className="mt-0.5 text-[12px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {relationshipLabel(g.relationship)}
                        {g.phone ? ` · ${g.phone}` : ''}
                        {g.email ? ` · ${g.email}` : ''}
                      </div>
                      {!reachable(g) && (
                        <div
                          className="mt-0.5 text-[11px]"
                          style={{ color: 'var(--color-text-faint)' }}
                        >
                          No phone or email — add one to enable fee reminders.
                        </div>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        {!g.isPrimary && rows.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => onMakePrimary(g.id)}
                          >
                            {busy === `primary-${g.id}` ? 'Setting…' : 'Make primary'}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(g.id);
                            setEditDraft({
                              firstName: g.firstName,
                              lastName: g.lastName,
                              phone: g.phone ?? '',
                              email: g.email ?? '',
                              relationship: g.relationship,
                            });
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => onUnlink(g.id)}
                        >
                          {busy === `unlink-${g.id}` ? 'Removing…' : 'Remove'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {canManage && rows.length > 0 && !adding && (
        <div className="px-4 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add another guardian
          </Button>
        </div>
      )}

      {canManage && adding && (
        <form
          onSubmit={onAdd}
          className="space-y-3 px-4 py-4"
          style={{
            borderTop: rows.length > 0 ? '1px solid var(--color-border-subtle)' : undefined,
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="g-first">First name</Label>
              <Input
                id="g-first"
                value={draft.firstName}
                onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="g-last">Last name</Label>
              <Input
                id="g-last"
                value={draft.lastName}
                onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="g-phone">Phone</Label>
              <Input
                id="g-phone"
                inputMode="tel"
                placeholder="0803 000 0000"
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="g-email">Email (optional)</Label>
              <Input
                id="g-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                autoComplete="off"
              />
            </div>
          </div>
          <div className="max-w-[200px]">
            <Label htmlFor="g-rel">Relationship</Label>
            <Select
              id="g-rel"
              value={draft.relationship}
              onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}
            >
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {relationshipLabel(r)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={busy === 'add'}>
              {busy === 'add' ? 'Saving…' : 'Save guardian'}
            </Button>
            {rows.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setDraft(EMPTY_DRAFT);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
