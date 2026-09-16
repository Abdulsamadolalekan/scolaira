import { NextResponse } from 'next/server';
import { logout, clearContext } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await logout();
    // If the request accepts HTML (form submit), redirect to login.
    const accept = request.headers.get('accept') ?? '';
    if (accept.includes('text/html')) {
      const url = new URL('/login', request.url);
      return NextResponse.redirect(url, 303);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('logout error', e?.code, e?.message);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, { status: 500 });
  } finally {
    await clearContext();
  }
}
