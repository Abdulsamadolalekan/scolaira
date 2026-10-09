import { Suspense } from 'react';
import RegisterPageInner from './register-inner';

export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading…</div>}>
      <RegisterPageInner />
    </Suspense>
  );
}
