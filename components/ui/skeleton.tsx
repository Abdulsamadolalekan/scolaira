import { cn } from '@/lib/utils/cn';

/**
 * Skeleton loading placeholders — mimic the shape of the incoming content
 * instead of a full-page spinner. Background pulse for perceived speed.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-sm bg-ink-faint', className)}
      aria-busy="true"
      aria-live="polite"
      {...props}
    />
  );
}

/** KPI card skeleton */
export function KpiSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-xs">
      <Skeleton className="mb-3 h-3 w-24" />
      <Skeleton className="mb-2 h-8 w-32" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

/** Table rows skeleton (n rows × m columns) */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-border">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-3 py-3 align-middle">
              <Skeleton
                className={cn('h-3', c === cols - 1 ? 'w-12' : c === 0 ? 'w-28' : 'w-20')}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Section/block skeleton with title + body */
export function BlockSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      <Skeleton className="mb-3 h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${60 + ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
