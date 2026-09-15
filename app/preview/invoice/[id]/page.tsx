'use client';

import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/nav-shell';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AuditEntry,
  DetailField,
  DetailPage,
  StatusBadge,
} from '@/components/template/detail-page';
import { Printer, Send, Trash } from '@/components/ui/icons';

export default function InvoiceDetailPage() {
  const total = 450_000 * 100;
  const paid = 0;
  const outstanding = total - paid;

  return (
    <DetailPage
      title="Invoice INV-1042"
      subtitle="Adeyemi, Bolarinwa · SS3 West House"
      status={<StatusBadge status="overdue" />}
      meta={<>Due 01 Jun 2025 · Issued 12 May 2025 · Third Term 2025/26</>}
      actions={
        <>
          <Button variant="secondary" iconLeft={<Send size={14} />}>
            Send reminder
          </Button>
          <Button variant="destructive" iconLeft={<Trash size={14} />}>
            Void
          </Button>
          <Button iconLeft={<Printer size={14} />} onClick={() => window.print()}>
            Print
          </Button>
        </>
      }
      summaryItems={[
        { label: 'Total billed', value: total, money: true },
        { label: 'Paid to date', value: paid, money: true },
        { label: 'Outstanding', value: outstanding, money: true },
        { label: 'Due date', value: '01 Jun 2025' },
        {
          label: 'Status',
          value: <span className="font-semibold text-danger-fg">Overdue 14 days</span>,
        },
      ]}
      auditTrail={
        <>
          <AuditEntry
            actor="Bursar (you)"
            action="issued the invoice"
            timestamp="12 May 2025, 10:04"
            meta="Total ₦450,000 · Sent via SMS + parent portal"
          />
          <AuditEntry
            actor="System"
            action="sent first reminder"
            timestamp="04 Jun 2025, 08:00"
            meta="SMS delivered"
          />
          <AuditEntry
            actor="System"
            action="marked invoice overdue"
            timestamp="02 Jun 2025, 00:00"
            meta="Balance ₦450,000 past due date"
          />
          <AuditEntry
            actor="Bursar (you)"
            action="recorded this entry as demo placeholder"
            timestamp="Today"
            meta="Demo placeholder — no real data"
          />
        </>
      }
      tabs={[
        {
          value: 'line-items',
          label: 'Line items',
          content: (
            <Card padded={false} className="avoid-break mt-4">
              <Table>
                <TableHeader>
                  <tr>
                    <TableHead>Item</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead numeric>Qty</TableHead>
                    <TableHead numeric>Rate</TableHead>
                    <TableHead numeric>Amount</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  <LineItemRow
                    item="Tuition"
                    desc="Third term tuition fee"
                    qty={1}
                    rate={380_000}
                    amount={380_000}
                  />
                  <LineItemRow
                    item="Development levy"
                    desc="Termly development levy"
                    qty={1}
                    rate={35_000}
                    amount={35_000}
                  />
                  <LineItemRow
                    item="Examination fee"
                    desc="Mock SSCE registration"
                    qty={1}
                    rate={25_000}
                    amount={25_000}
                  />
                  <LineItemRow
                    item="Textbooks & materials"
                    desc="Recommended literature set"
                    qty={1}
                    rate={10_000}
                    amount={10_000}
                  />
                </TableBody>
              </Table>
              <div className="border-t border-border px-4 py-3">
                <dl className="flex flex-col gap-2 sm:ml-auto sm:w-80 sm:items-end">
                  <DetailField label="Subtotal" value={450_000 * 100} money />
                  <DetailField label="Discount" value={<span className="text-ink-muted">—</span>} />
                  <DetailField
                    label="Total"
                    value={
                      <span className="text-md font-semibold text-ink-deepest">
                        <Money kobo={450_000 * 100} size="lg" />
                      </span>
                    }
                  />
                  <DetailField label="Paid" value={<Money kobo={0} variant="muted" />} />
                  <DetailField
                    label="Outstanding"
                    value={
                      <span className="font-semibold text-danger-fg">
                        <Money kobo={450_000 * 100} variant="overdue" />
                      </span>
                    }
                  />
                </dl>
              </div>
            </Card>
          ),
        },
        {
          value: 'payments',
          label: 'Payments',
          count: 0,
          content: (
            <Card className="mt-6">
              <p className="text-sm text-ink-muted">No payments recorded against this invoice.</p>
            </Card>
          ),
        },
        {
          value: 'activity',
          label: 'Activity',
          content: (
            <Card className="mt-6">
              <p className="text-sm text-ink-muted">See activity & audit trail below.</p>
            </Card>
          ),
        },
      ]}
    >
      {/* Parent / student information card */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Billed to" />
          <dl className="space-y-0">
            <DetailField label="Student" value="Adeyemi, Bolarinwa" />
            <DetailField label="Class" value="SS3 West House" />
            <DetailField label="Parent" value="Mr & Mrs Adeyemi" />
            <DetailField label="Parent phone" value="+234 803 000 0000" mono />
            <DetailField label="Student ID" value="STU-001" mono />
          </dl>
        </Card>
        <Card>
          <CardHeader title="Term & delivery" />
          <dl className="space-y-0">
            <DetailField label="Term" value="Third Term 2025/26" />
            <DetailField label="Issued" value="12 May 2025" />
            <DetailField label="Due" value="01 Jun 2025" />
            <DetailField
              label="Delivery"
              value={
                <>
                  SMS · Parent portal · <Badge variant="success">Delivered</Badge>
                </>
              }
            />
            <DetailField
              label="Payment link"
              value={
                <span className="font-mono text-xs text-forest-primary">
                  scolaira.com/pay/PL-5f2a9c
                </span>
              }
            />
          </dl>
        </Card>
      </div>
    </DetailPage>
  );
}

function LineItemRow({
  item,
  desc,
  qty,
  rate,
  amount,
}: {
  item: string;
  desc: string;
  qty: number;
  rate: number;
  amount: number;
}) {
  return (
    <TableRow>
      <TableCell>
        <p className="font-medium text-ink-primary">{item}</p>
      </TableCell>
      <TableCell muted>
        <p className="text-sm text-ink-muted">{desc}</p>
      </TableCell>
      <TableCell numeric>{qty}</TableCell>
      <TableCell numeric>
        <Money kobo={rate * 100} />
      </TableCell>
      <TableCell numeric>
        <Money kobo={amount * 100} />
      </TableCell>
    </TableRow>
  );
}
