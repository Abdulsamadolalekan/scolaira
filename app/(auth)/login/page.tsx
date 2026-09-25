import { Suspense } from 'react';
import LoginPageInner from './login-inner';
export const dynamic = 'force-dynamic';
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading…</div>}>
      <LoginPageInner />
    </Suspense>
  );
}
