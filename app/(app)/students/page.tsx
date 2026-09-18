/**
 * Students directory — operational view with per-student balance.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty';
import { Money } from '@/components/ui/money';
import { Users, Plus, ChevronRight } from '@/components/ui/icons';
import { checkPermission } from '@/components/permission-guard';
import { AccessDenied } from '@/components/access-denied';

export const runtime = 'nodejs';

type StudentRow = {
  id: string; studentId: string; name: string; gender: string | null; status: string;
  billedKobo: number; paidKobo: number; outstandingKobo: number;
};

async function loadStudents(): Promise<StudentRow[]> {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const cookie = h.get('cookie') ?? '';
  if (!host) return [];
  const res = await fetch(`${proto}://${host}/api/students`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) return [];
  return (await res.json()).students as StudentRow[];
}

export default async function StudentsPage() {
  const read = await checkPermission('student.read');
  if (!read.allowed) {
    return <AccessDenied surface="Students" requiredRole="Proprietor, Administrator, or Finance Officer" />;
  }
  const create = await checkPermission('student.create');
  const rows = await loadStudents();
  const totals = rows.reduce(
    (acc, r) => ({ billed: acc.billed + r.billedKobo, paid: acc.paid + r.paidKobo, out: acc.out + r.outstandingKobo, active: acc.active + (r.status === 'ACTIVE' ? 1 : 0), debtors: acc.debtors + (r.outstandingKobo > 0 ? 1 : 0) }),
    { billed: 0, paid: 0, out: 0, active: 0, debtors: 0 },
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] sm:text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--color-forest-deepest)', fontFamily: 'var(--font-serif)' }}>Students</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Each student and the balance on their account. Balances are computed from invoices and confirmed payments — not editable here.
          </p>
        </div>
        {create.allowed && (
          <Link href="/students/new"
                className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-forest)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[color:var(--color-forest-deep)]">
            <Plus size={14} /> New student
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StripCell label="Active students" value={String(totals.active)} />
        <StripCell label="Total billed" value={<Money kobo={totals.billed} />} />
        <StripCell label="Collected" value={<Money kobo={totals.paid} />} tone="positive" />
        <StripCell label="Outstanding" value={<Money kobo={totals.out} />} tone={totals.out > 0 ? 'warning' : 'muted'} />
      </div>

      <Card className="mt-4">
        <CardHeader title={rows.length === 0 ? 'No students yet' : 'Student directory'}
                   description={rows.length === 0 ? 'Add a student to begin invoicing.' : `${rows.length} student${rows.length === 1 ? '' : 's'} · ${totals.debtors} with outstanding balance`} />
        {rows.length === 0 ? (
          <div className="p-6"><EmptyState icon={<Users size={22} />} title="No students yet" description="Add your first student to begin raising invoices and recording payments." /></div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <Th>Student</Th><Th>ID</Th><Th className="text-right">Billed</Th><Th className="text-right">Paid</Th><Th className="text-right">Outstanding</Th>
                    <th className="px-4 py-2.5 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => <DesktopRow key={r.id} r={r} />)}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              {rows.map(r => <MobileRow key={r.id} r={r} />)}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function DesktopRow({ r }: { r: StudentRow }) {
  return (
    <tr className="hover:bg-[color:var(--color-forest-tint)] transition-colors" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <td className="px-4 py-3 align-top">
        <Link href={`/students/${r.id}`} className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{r.name}</Link>
        <div className="mt-0.5"><StatusBadge status={r.status} /></div>
      </td>
      <td className="px-3 py-3 align-top tabular-nums text-[12px]" style={{ color: 'var(--color-text-faint)' }}>{r.studentId}</td>
      <td className="px-3 py-3 text-right tabular-nums align-top" style={{ color: 'var(--color-text-secondary)' }}><Money kobo={r.billedKobo} size="sm" /></td>
      <td className="px-3 py-3 text-right tabular-nums align-top" style={{ color: 'var(--color-forest-deep)' }}><Money kobo={r.paidKobo} size="sm" /></td>
      <td className="px-3 py-3 text-right tabular-nums align-top font-medium"
          style={{ color: r.outstandingKobo > 0 ? 'var(--color-gold-dark,#8a6b11)' : 'var(--color-text-faint)' }}>
        {r.outstandingKobo === 0 ? '—' : <Money kobo={r.outstandingKobo} size="sm" />}
      </td>
      <td className="px-3 py-3 pr-4 align-top text-right"><ChevronRight size={14} className="inline opacity-40" /></td>
    </tr>
  );
}

function MobileRow({ r }: { r: StudentRow }) {
  return (
    <li>
      <Link href={`/students/${r.id}`} className="block px-4 py-4 active:bg-[color:var(--color-forest-tint)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-[14px]" style={{ color: 'var(--color-text-primary)' }}>{r.name}</div>
            <div className="text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--color-text-faint)' }}>{r.studentId}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[13px] font-semibold tabular-nums" style={{ color: r.outstandingKobo > 0 ? 'var(--color-gold-dark,#8a6b11)' : 'var(--color-text-faint)' }}>
              {r.outstandingKobo === 0 ? 'Clear' : <Money kobo={r.outstandingKobo} size="sm" hideDecimals />}
            </div>
            <div className="text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--color-text-faint)' }}>
              of <Money kobo={r.billedKobo} size="sm" hideDecimals />
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

function StripCell({ label, value, tone='default' }: { label:string; value:React.ReactNode; tone?:'default'|'positive'|'warning'|'danger'|'muted' }) {
  const colors = { default:'var(--color-text-primary)', positive:'var(--color-forest-deep)', warning:'var(--color-gold-dark,#8a6b11)', danger:'var(--color-danger,#a82a1c)', muted:'var(--color-text-faint)' } as const;
  return (
    <div className="rounded-md border px-3 py-3" style={{ borderColor:'var(--color-border-subtle)', backgroundColor:'var(--color-bg-page)' }}>
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color:'var(--color-text-faint)' }}>{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums" style={{ color: colors[tone] }}>{value}</div>
    </div>
  );
}

function Th({ children, className='' }: { children?:React.ReactNode; className?:string }) {
  return <th className={`px-3 py-2.5 text-left text-[11px] uppercase tracking-wider font-medium ${className}`} style={{ color:'var(--color-text-faint)' }}>{children}</th>;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'ACTIVE') return <Badge variant="success">Active</Badge>;
  if (status === 'ARCHIVED' || status === 'WITHDRAWN' || status === 'GRADUATED') return <Badge variant="neutral">{status[0]+status.slice(1).toLowerCase()}</Badge>;
  return <Badge variant="info">{status}</Badge>;
}
