/**
 * Setup guide — School → Academic setup → Import students → Review → Ready.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *   It is a guide, not a second implementation. Every step reuses the endpoints
 *   and rules that already exist: sessions, terms and classes are created through
 *   the same APIs the Academic roster uses, with the same permissions and the
 *   same validation. The importer is the only new machinery, and it is new
 *   because nothing existed to reuse.
 *
 *   Progress is DERIVED, never stored. Each step is complete when the database
 *   says so (`/api/onboarding/status` counts real rows), so a school that removes
 *   its last class correctly sees that step reopen. A stored "onboarding done"
 *   flag would be able to disagree with reality; a count cannot.
 *
 * FINANCIAL POSITION
 *   Nothing on this page touches a financial table. Setup stops at students and
 *   class enrollments. Billing is a deliberate, separate act taken later by
 *   someone who can see the fee structure and the amounts.
 */
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';
import { PageContainer, PageHeader } from '@/components/ui/page-header';
import { internalBaseUrl, requestCookieHeader } from '@/lib/http/internal-origin';
import type { GuideStep } from './step-rail';
import OnboardingGuide from './onboarding-guide';

export const runtime = 'nodejs';

interface StatusResponse {
  organization: { id: string; name: string } | null;
  counts: { sessions: number; terms: number; classes: number; students: number };
  sessions: Array<{ id: string; name: string; startsOn: string; isCurrent: boolean }>;
  currentTerm: { id: string; name: string; label: string; status: string; startsOn: string } | null;
  steps: GuideStep[];
  nextStep: string;
  readyToBill: boolean;
  /** Financial; the API omits it for a role that may not read invoices. */
  openingBalances?: {
    count: number;
    pendingReviewCount: number;
    pendingPostCount: number;
    /** Approved rows the ledger has not taken yet, postable or not. */
    approvedNotPostedCount: number;
    outstandingKobo: number;
    hasPriorTerm: boolean;
  } | null;
}

async function load(): Promise<StatusResponse | null> {
  try {
    const cookie = await requestCookieHeader();
    const base = await internalBaseUrl();
    if (!base) return null;
    const res = await fetch(`${base}/api/onboarding/status`, {
      cache: 'no-store',
      headers: { cookie },
    });
    if (!res.ok) return null;
    return (await res.json()) as StatusResponse;
  } catch {
    return null;
  }
}

async function loadTerms(): Promise<
  Array<{ id: string; name: string; label: string; status: string; startsOn: string }>
> {
  try {
    const cookie = await requestCookieHeader();
    const base = await internalBaseUrl();
    if (!base) return [];
    const res = await fetch(`${base}/api/terms`, { cache: 'no-store', headers: { cookie } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      terms?: Array<{ id: string; name: string; label: string; status: string; startsOn: string }>;
    };
    return data.terms ?? [];
  } catch {
    return [];
  }
}

export default async function OnboardingPage() {
  const read = await checkPermission('roster.read');
  if (!read.allowed) {
    return (
      <AccessDenied
        surface="Setup guide"
        requiredRole="Proprietor, Administrator, or Finance Officer"
      />
    );
  }

  const canManageAcademic = (await checkPermission('academic_session.manage')).allowed;
  const canManageStudents = (await checkPermission('student.create')).allowed;

  const [status, terms] = await Promise.all([load(), loadTerms()]);

  if (!status) {
    return (
      <PageContainer width="standard">
        <PageHeader title="Set up SCOLAIRA" lede="Get your school ready to bill." />
        <div
          className="rounded-sm border px-4 py-6 text-center"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Your setup progress could not be loaded.
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
        title="Set up SCOLAIRA"
        lede="From an empty workspace to a school that can be billed — including what families owed before they joined."
      />
      <OnboardingGuide
        status={status}
        terms={terms}
        canManageAcademic={canManageAcademic}
        canManageStudents={canManageStudents}
      />
    </PageContainer>
  );
}
