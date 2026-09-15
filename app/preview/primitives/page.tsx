'use client';

import * as React from 'react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, Label, Select, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox, RadioGroup, RadioItem, Switch } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparatorEl,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SegmentedControl, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty';
import { BlockSkeleton, KpiSkeleton, TableSkeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { ConfirmDialog, ConfirmDialogContent, ConfirmDialogTrigger } from '@/components/ui/confirm';
import { Money } from '@/components/ui/money';
import { KpiCard } from '@/components/ui/kpi-card';
import { Card, CardHeader, PageContainer, PageHeader } from '@/components/ui/nav-shell';
import { AlertTriangle, Check, ChevronDown, Info, Naira, Plus, Trash } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

export default function PrimitivesPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Design System · Primitives"
        description="M1 visual validation page. All 19 primitives, tokens, and states rendered in one place for QA."
        actions={<Badge variant="gold">Interim palette</Badge>}
      />

      <Tabs defaultValue="tokens">
        <TabsList className="mb-4 w-full overflow-x-auto">
          <TabsTrigger value="tokens">Tokens</TabsTrigger>
          <TabsTrigger value="buttons">Buttons</TabsTrigger>
          <TabsTrigger value="forms">Forms</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="overlay">Overlays</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="money">Money</TabsTrigger>
        </TabsList>

        <TabsContent value="tokens">
          <div className="grid gap-4">
            <Card>
              <CardHeader
                title="Brand primitives"
                description="Interim palette from founder references. Components never consume these directly."
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                {[
                  ['forest-deepest', '#0B3D2E', 'text-white'],
                  ['forest-deep', '#1B4332', 'text-white'],
                  ['forest-primary', '#046A38', 'text-white'],
                  ['forest-accent', '#2F8F5C', 'text-white'],
                  ['forest-tint', '#EAF4EE', 'text-ink-deepest'],
                  ['gold-rich', '#C9A227', 'text-ink-deepest'],
                  ['gold-tint', '#F5EEDC', 'text-ink-deepest'],
                  ['ivory', '#FDFBF6', 'text-ink-deepest border border-border'],
                  ['white', '#FFFFFF', 'text-ink-deepest border border-border'],
                  ['ink-deepest', '#17201C', 'text-white'],
                ].map(([name, hex, fg]) => (
                  <div
                    key={name}
                    className={`flex h-24 flex-col justify-between rounded p-3 ${fg}`}
                    style={{ background: hex }}
                  >
                    <span className="font-mono text-xs">{name}</span>
                    <span className="font-mono text-xs opacity-80">{hex}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Semantic status colors"
                description="Status is never color-only — always paired with a label."
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
                <Swatch label="Success" bg="bg-success-bg" fg="text-success-fg" />
                <Swatch label="Warning" bg="bg-warning-bg" fg="text-warning-fg" />
                <Swatch label="Danger" bg="bg-danger-bg" fg="text-danger-fg" />
                <Swatch label="Info" bg="bg-info-bg" fg="text-info-fg" />
                <Swatch label="Neutral" bg="bg-neutral-bg" fg="text-neutral-fg" />
                <Swatch label="Gold (accent)" bg="bg-gold-tint" fg="text-gold-rich" />
              </div>
            </Card>

            <Card>
              <CardHeader title="Typography scale" />
              <div className="space-y-4">
                <TypeSample
                  sizeClass="text-5xl"
                  label="text-5xl · Hero amount / pay page"
                  sample="₦43,400,000.00"
                  numeric
                />
                <TypeSample
                  sizeClass="text-4xl"
                  label="text-4xl · KPI primary"
                  sample="₦43.4M collected"
                  numeric
                />
                <TypeSample
                  sizeClass="text-3xl"
                  label="text-3xl · KPI small"
                  sample="1,248 students"
                  numeric
                />
                <TypeSample
                  sizeClass="text-2xl"
                  label="text-2xl · Page title (desktop)"
                  sample="Command Center"
                />
                <TypeSample
                  sizeClass="text-xl"
                  label="text-xl · Page title (mobile)"
                  sample="Invoices"
                />
                <TypeSample
                  sizeClass="text-lg"
                  label="text-lg · Section heading"
                  sample="Outstanding balances"
                />
                <TypeSample
                  sizeClass="text-md"
                  label="text-md · Section body"
                  sample="12 payments await reconciliation this morning."
                />
                <TypeSample
                  sizeClass="text-base"
                  label="text-base · Body"
                  sample="Every term, fully funded. SCOLAIRA is the financial operating system for Nigerian private schools."
                />
                <TypeSample
                  sizeClass="text-sm"
                  label="text-sm · Table text, small body"
                  sample="Chinedu Okafor · JSS 2B · Paid today 09:42"
                />
                <TypeSample
                  sizeClass="text-xs"
                  label="text-xs · Captions, labels"
                  sample="THIRD TERM · ISSUED 12 MAY 2025"
                />
              </div>
            </Card>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader title="Spacing (4px grid)" />
                <div className="space-y-2">
                  {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((s) => (
                    <div key={s} className="flex items-center gap-2">
                      <span className="w-12 font-mono text-xs text-ink-muted">space-{s}</span>
                      <div
                        className="h-4 bg-forest-tint"
                        style={{ width: `calc(var(--space-${s}))` }}
                      />
                      <span className="text-xs text-ink-muted">{s * 4}px</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card>
                <CardHeader title="Radii (restrained)" />
                <div className="space-y-2">
                  {(['sm', 'md', 'lg', 'xl'] as const).map((r) => (
                    <div key={r} className="flex items-center gap-3">
                      <span className="w-16 font-mono text-xs text-ink-muted">radius-{r}</span>
                      <div
                        className={`h-10 w-24 border border-border-strong bg-white rounded-${r}`}
                      />
                    </div>
                  ))}
                  <p className="mt-3 text-xs text-ink-muted">No pill radii. No 16px+ buttons.</p>
                </div>
              </Card>
              <Card>
                <CardHeader title="Shadows (xs → lg)" />
                <div className="space-y-3">
                  {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
                    <div
                      key={s}
                      className={`h-14 rounded-lg bg-white shadow-${s} flex items-center px-4 text-xs text-ink-muted`}
                    >
                      shadow-{s}
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="buttons">
          <Card>
            <CardHeader
              title="Button variants × sizes × states"
              description="One primary per section. Gold reserved for premium accents (payment CTA)."
            />
            <div className="space-y-6">
              {(['sm', 'md', 'lg'] as const).map((size) => (
                <div key={size} className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-ink-muted">size={size}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size={size} variant="primary">
                      Primary
                    </Button>
                    <Button size={size} variant="secondary">
                      Secondary
                    </Button>
                    <Button size={size} variant="tertiary">
                      Tertiary
                    </Button>
                    <Button size={size} variant="ghost">
                      Ghost
                    </Button>
                    <Button size={size} variant="gold">
                      Pay now
                    </Button>
                    <Button size={size} variant="destructive" iconLeft={<Trash size={14} />}>
                      Delete
                    </Button>
                    <Button size={size} variant="primary" iconLeft={<Plus size={14} />}>
                      With icon
                    </Button>
                    <Button size={size} variant="primary" loading>
                      Loading
                    </Button>
                    <Button size={size} variant="primary" disabled>
                      Disabled
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="forms">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader title="Inputs" />
              <div className="space-y-4">
                <Field label="Student name" htmlFor="f-name" required>
                  <Input id="f-name" placeholder="e.g. Adeyemi, Bolarinwa" />
                </Field>
                <Field
                  label="Amount (₦)"
                  htmlFor="f-amount"
                  hint="Use kobo internally; display naira"
                >
                  <Input
                    id="f-amount"
                    placeholder="0.00"
                    prefix={<Naira size={14} />}
                    type="text"
                    inputMode="decimal"
                  />
                </Field>
                <Field label="Class" htmlFor="f-class" required error="Please select a class.">
                  <Select id="f-class" defaultValue="">
                    <option value="" disabled>
                      Select class…
                    </option>
                    <option>JSS 1A</option>
                    <option>JSS 2B</option>
                    <option>SS3 West House</option>
                  </Select>
                </Field>
                <Field
                  label="Notes"
                  htmlFor="f-notes"
                  hint="Internal note; not visible to parents."
                >
                  <Textarea id="f-notes" rows={3} placeholder="Reason for adjustment, if any…" />
                </Field>
                <Field label="Disabled example">
                  <Input value="DATABASE_URL not configured in M1" disabled />
                </Field>
              </div>
            </Card>
            <Card>
              <CardHeader title="Checkbox, Radio, Switch" />
              <div className="space-y-5">
                <Checkbox
                  label="Send SMS reminder to parent"
                  description="Standard rate applies; message queued for next send window."
                  defaultChecked
                />
                <Checkbox
                  label="Mark as reconciled immediately"
                  description="Only use if you have confirmed bank settlement."
                />
                <div>
                  <Label className="mb-2 block">Payment method</Label>
                  <RadioGroup name="pm" defaultValue="bank">
                    <RadioItem
                      value="bank"
                      label="Bank transfer"
                      description="Manual matching required"
                    />
                    <RadioItem
                      value="cash"
                      label="Cash"
                      description="Collected at bursary; issue receipt"
                    />
                    <RadioItem
                      value="card"
                      label="Card / Paystack"
                      description="Auto-reconciled via webhook"
                    />
                  </RadioGroup>
                </div>
                <Switch
                  label="Enable payment link"
                  description="Parents can pay online after SMS."
                  defaultChecked
                />
                <Switch
                  label="Send receipt by email"
                  description="Only if parent email is on file."
                />
              </div>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="feedback">
          <div className="grid gap-4">
            <Card>
              <CardHeader
                title="Badges / status chips"
                description="Always paired with a label; never color-only status."
              />
              <div className="flex flex-wrap gap-2">
                <Badge variant="success">Paid</Badge>
                <Badge variant="warning">Pending</Badge>
                <Badge variant="warning">Partially paid</Badge>
                <Badge variant="danger">Overdue</Badge>
                <Badge variant="danger">Reversed</Badge>
                <Badge variant="neutral">Draft</Badge>
                <Badge variant="info">Sent</Badge>
                <Badge variant="forest">Reconciled</Badge>
                <Badge variant="gold">Flagship term</Badge>
              </div>
            </Card>

            <Card>
              <CardHeader title="Alerts / inline messages" />
              <div className="space-y-3">
                <Alert variant="info" title="12 payments pending reconciliation">
                  Bank settlement files arrived this morning. Please match before end of day.
                </Alert>
                <Alert variant="success" title="Payment recorded">
                  ₦150,000 applied to invoice INV-1041. Receipt RCP-3011 issued.
                </Alert>
                <Alert variant="warning" title="End-of-term reconciliation in 5 days">
                  Finalize outstanding items before term close.
                </Alert>
                <Alert variant="danger" title="Could not load bank statement" dismissible>
                  Database is not configured in M1. This is an error-state demo.
                </Alert>
                <Alert variant="neutral" title="Demonstration mode">
                  Screens use placeholder data. No real values are displayed.
                </Alert>
              </div>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader title="Empty state" />
                <EmptyState
                  title="No invoices yet"
                  description="When invoices have been issued for this term, they will appear here."
                  actionLabel="Create your first invoice"
                  isDemo
                />
              </Card>
              <Card>
                <CardHeader title="Error state" />
                <ErrorState
                  title="Couldn’t load invoices"
                  message="Database is not configured in M1. Retry will fail intentionally in demo."
                  onRetry={() => {}}
                />
              </Card>
            </div>

            <Card>
              <CardHeader
                title="Skeleton loading"
                description="Content-shaped placeholders (not a single global spinner)."
              />
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <KpiSkeleton />
                  <KpiSkeleton />
                  <KpiSkeleton />
                  <KpiSkeleton />
                </div>
                <div className="rounded border border-border">
                  <table className="w-full">
                    <TableBody>
                      <TableSkeleton rows={4} cols={4} />
                    </TableBody>
                  </table>
                </div>
                <BlockSkeleton lines={4} />
              </div>
            </Card>

            <ToastPlayground />
          </div>
        </TabsContent>

        <TabsContent value="overlay">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader title="Dialog" />
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Issue invoice</DialogTitle>
                    <DialogDescription>
                      Invoices will be delivered to parents via SMS and the parent portal. Demo only
                      in M1.
                    </DialogDescription>
                  </DialogHeader>
                  <p className="text-sm text-ink-secondary">
                    Dialog body content lives here. Dialogs enforce focus trapping and
                    Escape-to-close.
                  </p>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="secondary">Cancel</Button>
                    </DialogClose>
                    <Button>Send invoice</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </Card>

            <Card>
              <CardHeader title="Drawer" />
              <Drawer>
                <DrawerTrigger asChild>
                  <Button variant="secondary">Open drawer</Button>
                </DrawerTrigger>
                <DrawerContent>
                  <DrawerHeader>
                    <DrawerTitle>Filters</DrawerTitle>
                    <p className="text-sm text-ink-muted">
                      Narrow the list by status, class, or date range.
                    </p>
                  </DrawerHeader>
                  <DrawerBody>
                    <div className="space-y-4">
                      <Field label="Status">
                        <Select defaultValue="">
                          <option value="" disabled>
                            Any status
                          </option>
                          <option>Paid</option>
                          <option>Overdue</option>
                        </Select>
                      </Field>
                      <Field label="Class">
                        <Select defaultValue="">
                          <option value="" disabled>
                            Any class
                          </option>
                          <option>SS3 West</option>
                        </Select>
                      </Field>
                    </div>
                  </DrawerBody>
                  <DrawerFooter>
                    <DrawerClose asChild>
                      <Button variant="secondary">Reset</Button>
                    </DrawerClose>
                    <Button>Apply filters</Button>
                  </DrawerFooter>
                </DrawerContent>
              </Drawer>
            </Card>

            <Card>
              <CardHeader title="Confirm destructive" />
              <ConfirmDialog>
                <ConfirmDialogTrigger asChild>
                  <Button variant="destructive" iconLeft={<Trash size={14} />}>
                    Reverse payment
                  </Button>
                </ConfirmDialogTrigger>
                <ConfirmDialogContent
                  destructive
                  requireReason
                  title="Reverse this payment?"
                  description="Reversing a payment removes it from the settled ledger, re-opens the invoice, and records the reversal in the audit trail. This cannot be undone silently."
                  confirmLabel="Reverse payment"
                  reasonPlaceholder="Reason for reversal (required for audit)"
                  onConfirm={() => new Promise((r) => setTimeout(r, 600))}
                />
              </ConfirmDialog>
            </Card>

            <Card>
              <CardHeader title="Dropdown menu" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" iconRight={<ChevronDown size={14} />}>
                    Row actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                  <DropdownMenuItem>View details</DropdownMenuItem>
                  <DropdownMenuItem>Send reminder</DropdownMenuItem>
                  <DropdownMenuItem>Download PDF</DropdownMenuItem>
                  <DropdownMenuSeparatorEl />
                  <DropdownMenuItem destructive icon={<Trash size={14} />}>
                    Void invoice
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Card>

            <Card>
              <CardHeader title="Tooltip & Popover" />
              <div className="flex items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm">
                      Hover for tooltip
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Tooltips provide clarifying information on hover/focus.
                  </TooltipContent>
                </Tooltip>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="secondary" size="sm">
                      Open popover
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <p className="mb-1 text-sm font-semibold text-ink-primary">Payment status</p>
                    <p className="text-sm text-ink-secondary">
                      Popovers carry richer contextual information than tooltips and are
                      interactive.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="data">
          <div className="grid gap-4">
            <Card>
              <CardHeader title="Segmented control" />
              <SegmentedDemo />
            </Card>
            <Card padded={false}>
              <div className="border-b border-border p-4">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Table</p>
              </div>
              <Table>
                <TableHeader>
                  <tr>
                    <TableHead onSort={() => {}} sortDir={false}>
                      Invoice
                    </TableHead>
                    <TableHead onSort={() => {}} sortDir={false}>
                      Student
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead numeric onSort={() => {}} sortDir={false}>
                      Amount
                    </TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  <TableRow clickable>
                    <TableCell>
                      <span className="font-mono text-xs text-ink-secondary">INV-1042</span>
                    </TableCell>
                    <TableCell>Adeyemi, Bolarinwa</TableCell>
                    <TableCell>
                      <Badge variant="danger">Overdue</Badge>
                    </TableCell>
                    <TableCell numeric>
                      <Money kobo={450_000 * 100} variant="overdue" />
                    </TableCell>
                  </TableRow>
                  <TableRow clickable>
                    <TableCell>
                      <span className="font-mono text-xs text-ink-secondary">INV-1041</span>
                    </TableCell>
                    <TableCell>Okafor, Chinedu</TableCell>
                    <TableCell>
                      <Badge variant="success">Paid</Badge>
                    </TableCell>
                    <TableCell numeric>
                      <Money kobo={150_000 * 100} variant="positive" />
                    </TableCell>
                  </TableRow>
                  <TableRow clickable>
                    <TableCell>
                      <span className="font-mono text-xs text-ink-secondary">INV-1040</span>
                    </TableCell>
                    <TableCell>Bello, Amina</TableCell>
                    <TableCell>
                      <Badge variant="info">Sent</Badge>
                    </TableCell>
                    <TableCell numeric>
                      <Money kobo={43_400 * 100} />
                    </TableCell>
                  </TableRow>
                  <TableRow clickable>
                    <TableCell>
                      <span className="font-mono text-xs text-ink-secondary">INV-1039</span>
                    </TableCell>
                    <TableCell>Garba, Fatima</TableCell>
                    <TableCell>
                      <Badge variant="warning">Partially paid</Badge>
                    </TableCell>
                    <TableCell numeric>
                      <Money kobo={145_000 * 100} />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Card>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <KpiCard label="Billed" value={43_400_000 * 100} valueIsMoney compact isDemo />
              <KpiCard
                label="Collected"
                value={31_200_000 * 100}
                valueIsMoney
                compact
                delta="71.9%"
                deltaDirection="up"
                deltaTone="positive"
                isDemo
              />
              <KpiCard
                label="Outstanding"
                value={12_200_000 * 100}
                valueIsMoney
                compact
                delta="28.1%"
                deltaDirection="down"
                deltaTone="warning"
                isDemo
              />
              <KpiCard
                label="Overdue"
                value={4_860_000 * 100}
                valueIsMoney
                compact
                delta="₦1.2M"
                deltaDirection="up"
                deltaTone="negative"
                isDemo
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="money">
          <Card>
            <CardHeader
              title="Financial number formatter"
              description="All money values are integer kobo internally; rendered with tabular-nums alignment. Compact notation shows ₦43.4M with tooltip for full amount."
            />
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-ink-muted">
                  Full precision (default)
                </p>
                <div className="space-y-2">
                  <MoneyRow label="Zero" kobo={0} />
                  <MoneyRow label="Small" kobo={4_340 * 100} />
                  <MoneyRow label="Typical invoice" kobo={150_000 * 100} />
                  <MoneyRow label="Term billed" kobo={43_400_000 * 100} />
                  <MoneyRow
                    label="Outstanding (danger)"
                    kobo={12_200_000 * 100}
                    variant="overdue"
                  />
                  <MoneyRow
                    label="Collected (positive)"
                    kobo={31_200_000 * 100}
                    variant="positive"
                  />
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-ink-muted">Compact (KPI)</p>
                <div className="space-y-2">
                  <MoneyRow label="43,400 naira" kobo={43_400 * 100} compact />
                  <MoneyRow label="150,000 naira" kobo={150_000 * 100} compact />
                  <MoneyRow label="1.2M naira" kobo={1_200_000 * 100} compact />
                  <MoneyRow label="43.4M naira" kobo={43_400_000 * 100} compact />
                  <MoneyRow label="1.2B naira (future)" kobo={1_200_000_000 * 100} compact />
                </div>
                <p className="mt-4 text-xs text-ink-muted">
                  Hover / focus compact amounts to see the full value in a tooltip.
                </p>
              </div>
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function Swatch({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <div className={`rounded ${bg} ${fg} border border-transparent px-3 py-4`}>
      <p className="text-xs font-semibold">{label}</p>
    </div>
  );
}

function TypeSample({
  sizeClass,
  label,
  sample,
  numeric,
}: {
  sizeClass: string;
  label: string;
  sample: string;
  numeric?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-4 border-b border-border pb-3 last:border-b-0">
      <span className="w-40 shrink-0 font-mono text-xs text-ink-muted">{sizeClass}</span>
      <span
        className={cn(sizeClass, numeric && 'font-feature-tnum tabular-nums', 'text-ink-deepest')}
      >
        {sample}
      </span>
      <span className="ml-auto hidden text-xs text-ink-muted sm:block">{label}</span>
    </div>
  );
}

function MoneyRow({
  label,
  kobo,
  variant,
  compact,
}: {
  label: string;
  kobo: number;
  variant?: React.ComponentProps<typeof Money>['variant'];
  compact?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border py-1 last:border-b-0">
      <span className="text-sm text-ink-muted">{label}</span>
      <Money kobo={kobo} variant={variant} compact={compact} size="md" />
    </div>
  );
}

function SegmentedDemo() {
  const [v, setV] = React.useState('all');
  return (
    <div className="space-y-2">
      <SegmentedControl
        value={v}
        onChange={setV}
        options={[
          { value: 'all', label: 'All', count: 248 },
          { value: 'open', label: 'Open', count: 62 },
          { value: 'overdue', label: 'Overdue', count: 14 },
          { value: 'flagged', label: 'Flagged', count: 3 },
        ]}
      />
      <p className="text-sm text-ink-muted">Selected: {v}</p>
    </div>
  );
}

function ToastPlayground() {
  const { toast } = useToast();
  const [toasts, setToasts] = React.useState<
    Array<{
      id: number;
      variant: 'success' | 'error' | 'warning' | 'info';
      title: string;
      desc: string;
    }>
  >([]);
  const push = (variant: 'success' | 'error' | 'warning' | 'info', title: string, desc: string) => {
    setToasts((t) => [...t, { id: Date.now(), variant, title, desc }]);
    toast({ variant, title, description: desc });
  };
  return (
    <Card>
      <CardHeader
        title="Toasts"
        description="Transient feedback — success/error/warning/info. Auto-dismiss."
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => push('success', 'Payment recorded', '₦150,000 applied to INV-1041.')}
          iconLeft={<Check size={14} />}
        >
          Success
        </Button>
        <Button
          variant="secondary"
          onClick={() => push('error', 'Could not reach bank', 'Check network and retry.')}
          iconLeft={<AlertTriangle size={14} />}
        >
          Error
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            push('warning', 'End of term in 5 days', 'Please finalize reconciliation.')
          }
        >
          Warning
        </Button>
        <Button
          variant="secondary"
          onClick={() => push('info', 'Reminders queued', '248 SMS reminders scheduled for 08:00.')}
          iconLeft={<Info size={14} />}
        >
          Info
        </Button>
      </div>
      <div className="mt-4 max-w-md space-y-2">
        {toasts.slice(-3).map((t) => (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2 rounded-lg border border-border bg-white p-3 text-sm shadow-sm',
            )}
          >
            <span
              className={cn(
                'mt-0.5',
                t.variant === 'success' && 'text-success-fg',
                t.variant === 'error' && 'text-danger-fg',
                t.variant === 'warning' && 'text-warning-fg',
                t.variant === 'info' && 'text-info-fg',
              )}
            >
              {t.variant === 'success' && <Check size={16} />}
              {t.variant === 'error' && <AlertTriangle size={16} />}
              {t.variant === 'warning' && <AlertTriangle size={16} />}
              {t.variant === 'info' && <Info size={16} />}
            </span>
            <div className="flex-1">
              <p className="font-medium text-ink-primary">{t.title}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{t.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
