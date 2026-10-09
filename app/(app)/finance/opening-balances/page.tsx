/**
 * Finance → Opening balances.
 *
 * The register of what families owed before they joined SCOLAIRA. It is a finance
 * surface rather than an onboarding-only screen because the need does not end when
 * setup ends: a school that onboarded last term can discover a missed carry-in
 * next term, and the same rules must apply then.
 *
 * WHAT THE PAGE KNOWS
 *   Everything on it is read from the server, derived from the database: the
 *   figures, which term a carry-in may be booked against, and whether the viewer
 *   may record, review, post or reverse. Progress is never stored as a flag, so a
 *   school cannot be told it is done when the register says otherwise.
 *
 * FINANCIAL POSITION
 *   Recording a figure writes nothing that affects a balance. Only "Post" moves
 *   money, and only for a historical balance, and only as a real invoice on a past
 *   term — see `lib/db/repo/opening-balances.ts` and migration 0052. The page says
 *   so where the action is, not only in the docs.
 *
 * AUTHORIZATION
 *   Read is `invoice.read`. The buttons a role may not press are not rendered, so
 *   a school is never invited to click something that will refuse it; the API
 *   remains the enforcement point either way.
 */
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import OpeningBalancesPanel, {
  type BalanceRow,
  type BalanceSummary,
  type CategoryOption,
  type TermOption,
} from './opening-balances-panel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RegisterResponse {
  rows: BalanceRow[];
  summary: BalanceSummary;
  categories: CategoryOption[];
  priorTerms: TermOption[];
  currentTerm: TermOption | null;
}

interface StudentsResponse {
  students?: Array<{ id: string; name: string; studentId?: string | null }>;
}

async function json<T>(path: string): Promise<T | null> {
  try {
    const cookie = await requestCookieHeader();
    const base = await internalBaseUrl();
    if (!base) return null;
    const res = await fetch(`${base}${path}`, { cache: 'no-store', headers: { cookie } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default async function OpeningBalancesPage() {
  const read = await checkPermission('invoice.read');
  if (!read.allowed) {
    return (
      <AccessDenied
        surface="Opening balances"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  }

  const [canCreate, canIssue, canVoid] = await Promise.all([
    checkPermission('invoice.create'),
    checkPermission('invoice.issue'),
    checkPermission('invoice.void'),
  ]);

  const [register, roster] = await Promise.all([
    json<RegisterResponse>('/api/opening-balances'),
    json<StudentsResponse>('/api/students?limit=200'),
  ]);

  if (!register) {
    return (
      <PageContainer width="standard">
        <PageHeader title="Opening balances" lede="What families owed before they joined." />
        <div
          className="rounded-sm border px-4 py-6 text-center"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            The register could not be loaded.
          </p>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--color-text-faint)' }}>
            Reload the page to try again. Nothing has been changed.
          </p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Opening balances"
        lede="Carry in what was owed before SCOLAIRA, with the paper it came from. Nothing here becomes a charge until you post it, and only past-term debt can be posted."
      />
      <OpeningBalancesPanel
        rows={register.rows}
        summary={register.summary}
        categories={register.categories}
        priorTerms={register.priorTerms}
        currentTerm={register.currentTerm}
        students={(roster?.students ?? []).map((s) => ({
          id: s.id,
          // `name` is what /api/students returns — the same field the students
          // list and the invoice form read. Composing it here from parts that do
          // not exist produced "undefined undefined" on the picker, which is only
          // visible on the rendered page.
          name: s.name,
          number: s.studentId ?? null,
        }))}
        canCreate={canCreate.allowed}
        canIssue={canIssue.allowed}
        canVoid={canVoid.allowed}
      />
    </PageContainer>
  );
}
