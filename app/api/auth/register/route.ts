import { NextResponse } from 'next/server';
import { z } from 'zod';
import { register, AuthError } from '@/lib/auth';

export const runtime = 'nodejs';

const bodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(128),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  organizationName: z.string().min(2).max(160),
  organizationSlug: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid request', details: parsed.error.flatten() } }, { status: 400 });
  }
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;
    const result = await register(parsed.data, { ip: ip ?? undefined, userAgent: userAgent ?? undefined });
    return NextResponse.json({ ok: true, organizationId: result.organizationId }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error('register error', e);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  }
}
