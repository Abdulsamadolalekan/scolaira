/**
 * H-5 — the rotate affordance in the invoice action bar.
 *
 * An operator can only use a control they can find, and an operator must never
 * be shown a control that will be refused. This suite pins the client half of
 * that contract:
 *
 *   - the control exists only for a viewer the server told us may rotate
 *     (`canRotate`), which the page derives from `payment_link.rotate`;
 *   - it hits the H-5 route with the link's token, sends the CSRF header the
 *     route requires, and forwards the (optional) audited reason;
 *   - the operator is warned *before* confirming that a URL already sent to
 *     parents stops working — rotation is a credential change, not a
 *     cosmetic one;
 *   - a refusal is surfaced as a message, never as a silent success (a
 *     rotated-looking UI on a refused rotation is an incident of its own).
 *
 * Authorization itself is proven in the DB/route suites (rotation is
 * OWNER-only); this file proves the UI cannot lie about it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import InvoiceActions from './invoice-actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const TOKEN = 'tok-rotate-me-0123456789';

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function renderActions(canRotate: boolean) {
  return render(
    <InvoiceActions
      invoiceId="inv-1"
      status="ISSUED"
      paidKobo={0}
      remainingKobo={50_000_00}
      canRotate={canRotate}
    />,
  );
}

const rotateButton = () => screen.queryByRole('button', { name: /rotate link/i });
/** The toggle and the form's submit share a label; the submit is the one that
 *  actually performs the rotation. */
const submitRotate = () =>
  screen
    .getAllByRole('button', { name: /^rotate link$/i })
    .find((b) => (b as HTMLButtonElement).type === 'submit')!;

beforeEach(() => {
  refresh.mockClear();
  // The double-submit CSRF token is read from this cookie by csrfHeaders().
  document.cookie = 'sc_csrf=csrf-value.sig';
});

afterEach(() => {
  cleanup();
  document.cookie = 'sc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('H-5 invoice rotate control', () => {
  it('is not offered to a viewer who may not rotate', () => {
    renderActions(false);
    expect(rotateButton()).toBeNull();
    // The rest of the action bar is unaffected.
    expect(screen.getByRole('button', { name: /copy payment link/i })).toBeTruthy();
  });

  it('warns about the operational consequence before rotating, and posts the reason with CSRF', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/payment-links') {
        return jsonResponse({
          links: [
            { id: 'link-other', invoiceId: 'inv-2', status: 'ACTIVE', token: 'other-token' },
            { id: 'link-1', invoiceId: 'inv-1', status: 'ACTIVE', token: TOKEN },
            { id: 'link-void', invoiceId: 'inv-1', status: 'REVOKED', token: 'revoked-token' },
          ],
        });
      }
      return jsonResponse({ link: { id: 'link-1', token: 'fresh', url: '/p/fresh', rotationCount: 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderActions(true);
    fireEvent.click(rotateButton()!);

    // The consequence is stated before the operator confirms.
    expect(await screen.findByText(/stops working immediately/i)).toBeTruthy();
    expect(screen.getByText(/unchanged/i)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/forwarded to a public group/i), {
      target: { value: 'URL forwarded to a public group' },
    });
    fireEvent.click(submitRotate());

    await waitFor(() => expect(calls.some((c) => c.url.includes('/rotate'))).toBe(true));
    const rotate = calls.find((c) => c.url.includes('/rotate'))!;
    // The ACTIVE link of THIS invoice, identified by its token — never the
    // revoked one, never another invoice's.
    expect(rotate.url).toBe(`/api/payment-links/${TOKEN}/rotate`);
    const init = rotate.init as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-value.sig');
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'URL forwarded to a public group' });

    // The new URL is shown, and the page data is refreshed (the old URL is dead).
    // The code block renders the absolute URL from origin + path.
    expect((await screen.findByText(/\/p\/fresh/)).textContent).toContain('/p/fresh');
    expect(refresh).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('surfaces a refusal instead of showing a rotated link', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/payment-links') {
        return jsonResponse({ links: [{ id: 'link-1', invoiceId: 'inv-1', status: 'ACTIVE', token: TOKEN }] });
      }
      return jsonResponse(
        { error: { code: 'FORBIDDEN', message: 'You do not have permission to rotate payment links.' } },
        403,
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderActions(true);
    fireEvent.click(rotateButton()!);
    fireEvent.click(await waitFor(() => submitRotate()));

    expect(await screen.findByText(/do not have permission to rotate payment links/i)).toBeTruthy();
    // No success state: nothing is copied, nothing is claimed to have changed.
    expect(screen.queryByText('New payment link')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
