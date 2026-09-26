/**
 * GET /api/org/settings  — read org settings (org.settings.read)
 * PATCH /api/org/settings — update org settings (org.settings.update)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuthorizedRoute, Org } from '@/lib/authz';

const patchSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(255).nullable().optional(),
  currency: z.string().trim().length(3).default('NGN').optional(),
  timezone: z.string().trim().max(64).optional(),
});

export const GET = withAuthorizedRoute(
  { action: 'org.settings.read', method: 'GET' },
  async (_req, { db, ctx }) => {
    const settings = await Org.getSettings(db, ctx);
    return NextResponse.json({ settings });
  },
);

export const PATCH = withAuthorizedRoute(
  { action: 'org.settings.update', method: 'PATCH', bodySchema: patchSchema },
  async (_req, { db, ctx, body }) => {
    // withAuthorizedRoute normalizes errors into JSON responses; AuthzError
    // instances propagate through its catch block automatically.
    const settings = await Org.updateSettings(db, ctx, body as Parameters<typeof Org.updateSettings>[2]);
    return NextResponse.json({ settings });
  },
);

// Route-level safety: any other method returns 405.
export async function POST() { return NextResponse.json({ error: { code: 'METHOD_NOT_ALLOWED' } }, { status: 405 }); }
export async function PUT() { return POST(); }
export async function DELETE() { return POST(); }
