/**
 * GET /api/classes — list classes for the current organization.
 *
 * Thin read endpoint for dropdowns (invoice creation, fee assignments).
 * Write endpoints for class management are deferred until a Class CRUD page
 * is in scope; the M6 scope only requires listing.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { classes } from '@/lib/db/schema';

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'class.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    // Order by sort_order then name so that "JSS 1", "JSS 2", "SSS 1" line up.
    const rows = await db
      .select({
        id: classes.id,
        name: classes.name,
        arm: classes.arm,
        sortOrder: classes.sortOrder,
      })
      .from(classes)
      .where(eq(classes.organizationId, ctx.organizationId))
      .orderBy(classes.sortOrder, classes.name);

    return NextResponse.json({
      classes: rows.map(r => ({
        id: r.id,
        name: r.name,
        arm: r.arm,
        label: r.arm ? `${r.name} ${r.arm}` : r.name,
      })),
    });
  },
);
