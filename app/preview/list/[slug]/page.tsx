'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ListPage, type ListColumn } from '@/components/template/list-page';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/template/detail-page';
import { Button } from '@/components/ui/button';

type Row = {
  id: string;
  col1: string;
  col2: string;
  col3: string;
  col4?: number;
  status: 'paid' | 'pending' | 'overdue' | 'draft' | 'sent' | 'partial' | 'reconciled';
};

const STUDENTS: Row[] = [
  {
    id: 'STU-001',
    col1: 'Adeyemi, Bolarinwa',
    col2: 'SS3 West House',
    col3: '3 invoices · ₦450,000 overdue',
    status: 'overdue',
  },
  {
    id: 'STU-002',
    col1: 'Okafor, Chinedu',
    col2: 'JSS 2B',
    col3: '2 invoices · ₦150,000 paid today',
    status: 'paid',
  },
  {
    id: 'STU-003',
    col1: 'Bello, Amina',
    col2: 'Primary 4A',
    col3: '1 invoice · ₦43,400 sent',
    status: 'sent',
  },
  {
    id: 'STU-004',
    col1: 'Danladi, Yusuf',
    col2: 'SS1 East House',
    col3: 'All invoices paid',
    status: 'paid',
  },
  {
    id: 'STU-005',
    col1: 'Eze, Kamsiyochukwu',
    col2: 'JSS 1A',
    col3: '1 invoice pending',
    status: 'pending',
  },
  {
    id: 'STU-006',
    col1: 'Garba, Fatima',
    col2: 'Primary 6B',
    col3: 'Partially paid (₦80,000 of ₦145,000)',
    status: 'partial',
  },
  {
    id: 'STU-007',
    col1: 'Nwosu, Chiamaka',
    col2: 'SS2 North',
    col3: '2 invoices — cleared',
    status: 'reconciled',
  },
];

const INVOICES: Row[] = [
  {
    id: 'INV-1042',
    col1: 'INV-1042',
    col2: 'Adeyemi, Bolarinwa',
    col3: 'Third term tuition · Due 01 Jun',
    col4: 450_000 * 100,
    status: 'overdue',
  },
  {
    id: 'INV-1041',
    col1: 'INV-1041',
    col2: 'Okafor, Chinedu',
    col3: 'Third term tuition · Paid 14 Jun',
    col4: 150_000 * 100,
    status: 'paid',
  },
  {
    id: 'INV-1040',
    col1: 'INV-1040',
    col2: 'Bello, Amina',
    col3: 'Third term tuition · Sent 13 Jun',
    col4: 43_400 * 100,
    status: 'sent',
  },
  {
    id: 'INV-1039',
    col1: 'INV-1039',
    col2: 'Garba, Fatima',
    col3: 'Third term tuition · Partial',
    col4: 145_000 * 100,
    status: 'partial',
  },
  {
    id: 'INV-1038',
    col1: 'INV-1038',
    col2: 'Nwosu, Chiamaka',
    col3: 'Third term tuition · Reconciled',
    col4: 145_000 * 100,
    status: 'reconciled',
  },
  {
    id: 'INV-1037',
    col1: 'INV-1037',
    col2: 'Eze, Kamsiyochukwu',
    col3: 'Third term tuition · Draft',
    col4: 145_000 * 100,
    status: 'draft',
  },
];

const PAYMENTS: Row[] = [
  {
    id: 'PAY-2044',
    col1: '₦150,000.00',
    col2: 'Okafor, Chinedu',
    col3: 'Bank transfer · Today 09:42',
    col4: 150_000 * 100,
    status: 'reconciled',
  },
  {
    id: 'PAY-2043',
    col1: '₦250,000.00',
    col2: 'Unmatched',
    col3: 'GTB transfer · Today 09:42',
    col4: 250_000 * 100,
    status: 'pending',
  },
  {
    id: 'PAY-2042',
    col1: '₦80,000.00',
    col2: 'Garba, Fatima',
    col3: 'Paystack · 13 Jun',
    col4: 80_000 * 100,
    status: 'paid',
  },
  {
    id: 'PAY-2041',
    col1: '₦65,000.00',
    col2: 'Danladi, Yusuf',
    col3: 'Cash · 12 Jun',
    col4: 65_000 * 100,
    status: 'paid',
  },
];

const RECEIPTS = INVOICES.slice(0, 5).map((r, i) => ({
  ...r,
  id: `RCP-${3010 + i}`,
  col1: `RCP-${3010 + i}`,
}));

const TERMS: Row[] = [
  {
    id: 'T-2025-3',
    col1: '2025/26 · Third Term',
    col2: '28 Apr — 25 Jul 2025',
    col3: 'Active · Closes in 5 days',
    col4: 43_400_000 * 100,
    status: 'sent',
  },
  {
    id: 'T-2025-2',
    col1: '2025/26 · Second Term',
    col2: '08 Jan — 28 Mar 2025',
    col3: 'Reconciled · Closed',
    col4: 41_900_000 * 100,
    status: 'reconciled',
  },
  {
    id: 'T-2025-1',
    col1: '2025/26 · First Term',
    col2: '18 Sep — 13 Dec 2024',
    col3: 'Reconciled · Closed',
    col4: 39_750_000 * 100,
    status: 'reconciled',
  },
];

const LINKS: Row[] = [
  {
    id: 'PL-5f2a',
    col1: 'PL-5f2a9c',
    col2: 'Adeyemi, Bolarinwa',
    col3: 'Opened 4 times · Expires 21 Jun',
    col4: 450_000 * 100,
    status: 'pending',
  },
  {
    id: 'PL-9d1e',
    col1: 'PL-9d1eb2',
    col2: 'Bello, Amina',
    col3: 'Opened 2 times · Expires 25 Jun',
    col4: 43_400 * 100,
    status: 'sent',
  },
];

const CONFIGS: Record<
  string,
  {
    title: string;
    desc: string;
    data: Row[];
    cols: ListColumn<Row>[];
    tabs?: { value: string; label: string; count?: number }[];
    primaryLabel: string;
  }
> = {
  students: {
    title: 'Students',
    desc: 'All enrolled students and their financial status this term.',
    data: STUDENTS,
    primaryLabel: 'Add student',
    tabs: [
      { value: 'all', label: 'All', count: STUDENTS.length },
      { value: 'owing', label: 'Owing', count: 4 },
      { value: 'cleared', label: 'Cleared', count: 3 },
    ],
    cols: [
      {
        key: 'name',
        header: 'Student',
        cell: (r) => <span className="font-medium text-ink-primary">{r.col1}</span>,
        sortable: true,
      },
      { key: 'class', header: 'Class', cell: (r) => r.col2 },
      { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
      {
        key: 'notes',
        header: 'Notes',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col3}</span>,
      },
      {
        key: 'actions',
        header: '',
        cell: () => <span className="text-xs font-medium text-forest-primary">View</span>,
        width: '60px',
      },
    ],
  },
  invoices: {
    title: 'Invoices',
    desc: 'All invoices issued for this and previous terms.',
    data: INVOICES,
    primaryLabel: 'New invoice',
    tabs: [
      { value: 'all', label: 'All', count: INVOICES.length },
      { value: 'open', label: 'Open', count: 4 },
      { value: 'overdue', label: 'Overdue', count: 1 },
      { value: 'paid', label: 'Paid', count: 2 },
    ],
    cols: [
      {
        key: 'id',
        header: 'Invoice',
        cell: (r) => <span className="font-mono text-xs text-ink-secondary">{r.col1}</span>,
        sortable: true,
      },
      {
        key: 'student',
        header: 'Student',
        cell: (r) => <span className="font-medium text-ink-primary">{r.col2}</span>,
      },
      {
        key: 'desc',
        header: 'Description',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col3}</span>,
      },
      { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
      {
        key: 'amount',
        header: 'Amount',
        cell: (r) => (r.col4 !== undefined ? <Money kobo={r.col4} /> : '—'),
        numeric: true,
        sortable: true,
      },
    ],
  },
  payments: {
    title: 'Payments',
    desc: 'All recorded payments: cash, bank transfer, card, Paystack.',
    data: PAYMENTS,
    primaryLabel: 'Record payment',
    tabs: [
      { value: 'all', label: 'All', count: PAYMENTS.length },
      { value: 'unreconciled', label: 'Unreconciled', count: 1 },
      { value: 'matched', label: 'Matched', count: 3 },
    ],
    cols: [
      {
        key: 'amount',
        header: 'Amount',
        cell: (r) =>
          r.col4 !== undefined ? (
            <Money kobo={r.col4} variant={r.status === 'pending' ? 'muted' : 'default'} />
          ) : (
            '—'
          ),
        numeric: true,
        sortable: true,
      },
      {
        key: 'student',
        header: 'Payer / Student',
        cell: (r) => <span className="font-medium text-ink-primary">{r.col2}</span>,
      },
      {
        key: 'method',
        header: 'Method',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col3}</span>,
      },
      { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
      {
        key: 'id',
        header: 'Ref',
        cell: (r) => <span className="font-mono text-xs text-ink-secondary">{r.id}</span>,
        width: '100px',
      },
    ],
  },
  receipts: {
    title: 'Receipts',
    desc: 'Issued receipts — one per completed and reconciled payment.',
    data: RECEIPTS,
    primaryLabel: 'Issue receipt',
    cols: [
      {
        key: 'id',
        header: 'Receipt #',
        cell: (r) => <span className="font-mono text-xs text-ink-secondary">{r.col1}</span>,
      },
      {
        key: 'student',
        header: 'Student',
        cell: (r) => <span className="font-medium text-ink-primary">{r.col2}</span>,
      },
      {
        key: 'desc',
        header: 'Description',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col3}</span>,
      },
      { key: 'status', header: 'Status', cell: () => <Badge variant="success">Issued</Badge> },
      {
        key: 'amount',
        header: 'Amount',
        cell: (r) => (r.col4 !== undefined ? <Money kobo={r.col4} /> : '—'),
        numeric: true,
      },
    ],
  },
  terms: {
    title: 'Terms',
    desc: 'Academic terms and their reconciliation state.',
    data: TERMS,
    primaryLabel: 'New term',
    cols: [
      {
        key: 'name',
        header: 'Term',
        cell: (r) => <span className="font-medium text-ink-primary">{r.col1}</span>,
      },
      {
        key: 'dates',
        header: 'Dates',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col2}</span>,
      },
      {
        key: 'state',
        header: 'State',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col3}</span>,
      },
      {
        key: 'billed',
        header: 'Billed',
        cell: (r) => (r.col4 !== undefined ? <Money kobo={r.col4} compact /> : '—'),
        numeric: true,
      },
    ],
  },
  links: {
    title: 'Payment Links',
    desc: 'Active parent payment links (shared via SMS / WhatsApp).',
    data: LINKS,
    primaryLabel: 'New link',
    cols: [
      {
        key: 'id',
        header: 'Link',
        cell: (r) => <span className="font-mono text-xs text-forest-primary">{r.col1}</span>,
      },
      {
        key: 'student',
        header: 'Student',
        cell: (r) => <span className="font-medium text-ink-primary">{r.col2}</span>,
      },
      {
        key: 'activity',
        header: 'Activity',
        cell: (r) => <span className="text-sm text-ink-muted">{r.col3}</span>,
      },
      {
        key: 'amount',
        header: 'Amount',
        cell: (r) => (r.col4 !== undefined ? <Money kobo={r.col4} /> : '—'),
        numeric: true,
      },
    ],
  },
};

export default function GenericListPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const cfg = CONFIGS[slug];
  const [tab, setTab] = React.useState(cfg?.tabs?.[0]?.value ?? 'all');
  const [search, setSearch] = React.useState('');
  const [sortKey, setSortKey] = React.useState<string>('col1');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');

  if (!cfg) {
    return (
      <div className="p-8">
        <p>List “{slug}” not found. Try: students, invoices, payments, receipts, terms, links.</p>
        <Link href="/preview/command-center">
          <Button className="mt-4" variant="secondary">
            Back to Command Center
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <ListPage<Row>
      title={cfg.title}
      description={cfg.desc}
      primaryActionLabel={cfg.primaryLabel}
      columns={cfg.cols}
      tabs={cfg.tabs}
      activeTab={tab}
      onTabChange={setTab}
      searchValue={search}
      onSearchChange={setSearch}
      rows={cfg.data.filter((r) => {
        if (tab === 'all') return true;
        if (tab === 'open') return ['pending', 'sent', 'partial'].includes(r.status);
        if (tab === 'overdue') return r.status === 'overdue';
        if (tab === 'paid') return ['paid', 'reconciled'].includes(r.status);
        if (tab === 'owing') return ['overdue', 'pending', 'partial'].includes(r.status);
        if (tab === 'cleared') return ['paid', 'reconciled'].includes(r.status);
        if (tab === 'unreconciled') return r.status === 'pending';
        if (tab === 'matched') return r.status !== 'pending';
        return true;
      })}
      getRowKey={(r) => r.id}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={(k) => {
        if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        else {
          setSortKey(k);
          setSortDir('asc');
        }
      }}
      isDemo
      footer={<span>{cfg.data.length} records · Demo data</span>}
    />
  );
}
