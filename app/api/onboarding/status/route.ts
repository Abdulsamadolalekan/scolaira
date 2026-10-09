/**
 * GET /api/onboarding/status — what is set up for this school, so far.
 *
 * WHY THIS EXISTS
 *   A new school needs to know what is done and what is next. Every value here
 *   is DERIVED from the real tables — sessions, terms, classes, students — and
 *   never from a flag someone has to remember to set. A completion flag can
 *   disagree with reality; a count cannot. If a school deletes its last class,
 *   the step correctly goes back to incomplete.
 *
 * AUTHORIZATION
 *   `roster.read`, the same permission the academic workspace uses, because this
 *   tells the caller about the school's academic data. Writes are gated
 *   separately on the step's own permission, so a finance officer who may read
 *   the roster is not told they can create a session.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';
import { authorize } from '@/lib/authz/permissions';
import { students } from '@/lib/db/schema';
import * as Org from '@/lib/db/repo/organizations';
import * as sessionRepo from '@/lib/db/repo/academic-sessions';
import * as termRepo from '@/lib/db/repo/terms';
import * as classRepo from '@/lib/db/repo/classes';
import * as openingRepo from '@/lib/db/repo/opening-balances';
import { formatKoboDisplay } from '@/lib/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthorizedRoute(
  { action: 'roster.read', method: 'GET' },
  async (_req, { db, ctx, authz }) => {
    const organization = await Org.get(db, ctx);
    const [sessions, terms, classes] = await Promise.all([
      sessionRepo.listForOrg(db, ctx),
      termRepo.listForOrg(db, ctx),
      classRepo.listForOrg(db, ctx),
    ]);
    const currentTerm = terms.find((t) => t.isCurrent) ?? null;

    const studentCountRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(students)
      .where(and(eq(students.organizationId, ctx.organizationId), isNull(students.deletedAt)));
    const studentCount = Number(studentCountRows[0]?.n ?? 0);

    const activeClasses = classes.filter((c) => !c.deletedAt);

    /*
     * Carry-in balances are a financial figure, and this endpoint is readable by
     * any role with `roster.read`. So the step is only computed — and only
     * returned — for a caller who may already read invoices. A role that cannot
     * see a balance does not learn that one exists. That is why this is a
     * permission check rather than a filter on the payload.
     */
    const mayReadFinancials = authorize(authz, 'invoice.read').allowed;
    const balances = mayReadFinancials ? await openingRepo.summary(db, ctx) : null;

    // Each step reports `done` from the database alone. `blocked` states whether
    // the step can be acted on now, so the interface can show the ONE next
    // action rather than a wall of equally-weighted buttons.
    const steps = [
      {
        key: 'school',
        label: 'School',
        done: Boolean(organization?.name),
        detail: organization ? organization.name : 'Name your school',
      },
      {
        key: 'session',
        label: 'Academic session',
        done: sessions.length > 0,
        detail:
          sessions.length > 0
            ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
            : 'Add the session you are billing in',
      },
      {
        key: 'term',
        label: 'Term',
        done: currentTerm !== null,
        detail: currentTerm
          ? `${currentTerm.name} · ${currentTerm.status.toLowerCase()}`
          : terms.length > 0
            ? `${terms.length} term${terms.length === 1 ? '' : 's'}, none current`
            : 'Add the term you are billing in',
      },
      {
        key: 'classes',
        label: 'Classes',
        done: activeClasses.length > 0,
        detail:
          activeClasses.length > 0
            ? `${activeClasses.length} class${activeClasses.length === 1 ? '' : 'es'}`
            : 'Add the classes you bill by',
      },
      {
        key: 'students',
        label: 'Students',
        done: studentCount > 0,
        detail: studentCount > 0 ? `${studentCount} on roll` : 'Import or add your students',
      },
      // Phase 2 — present only to a role that may read invoices, and `done` only
      // when the register holds nothing that still needs a decision. A school that
      // has carried in nothing is NOT shown as done: an empty register is how a
      // missed balance looks, and telling them they are finished would hide it.
      ...(balances
        ? [
            {
              key: 'balances',
              label: 'Carry in what is owed',
              // Nothing is called finished while a figure is still APPROVED and
              // unposted — including a figure the ledger cannot take yet because the
              // school has no past term to post into. `pendingPostCount` is the subset
              // that could go in today, so it alone would let such a row read as done.
              done:
                balances.count > 0 &&
                balances.pendingReviewCount === 0 &&
                balances.approvedNotPostedCount === 0,
              detail:
                balances.count === 0
                  ? 'Nothing carried in yet — if any family owed money before today, write it down'
                  : balances.pendingReviewCount > 0
                    ? `${balances.pendingReviewCount} figure${balances.pendingReviewCount === 1 ? '' : 's'} waiting to be approved`
                    : balances.pendingPostCount > 0
                      ? `${balances.pendingPostCount} approved figure${balances.pendingPostCount === 1 ? '' : 's'} not yet posted`
                      : balances.approvedNotPostedCount > 0
                        ? `${balances.approvedNotPostedCount} approved figure${balances.approvedNotPostedCount === 1 ? '' : 's'} not yet posted — the term it belongs to has to be set before the ledger can take it`
                        : `${balances.postedKobo > 0 ? `${formatKoboDisplay(balances.outstandingKobo)} still outstanding from before` : 'Register reviewed and posted'}`,
            },
          ]
        : []),
    ];

    // The guide highlights ONE next action, and the carry-in step is deliberately not
    // eligible to be it. It is advice about money that predates the software, not a
    // prerequisite for billing: a school with an active term, classes and pupils on
    // roll can bill today. Making a bursar go and find a debt they may not have
    // before the finish line appears would push them to invent a figure to get out of
    // the guide — the one outcome an opening-balance feature must never cause. The
    // step itself still reports the truth on the rail, and still refuses to call an
    // empty register finished, so nothing here hides a missed balance.
    const firstIncomplete = steps.find((s) => !s.done && s.key !== 'balances');

    return NextResponse.json({
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            address: organization.address,
            phone: organization.phone,
            email: organization.email,
            currency: organization.currency,
          }
        : null,
      counts: {
        sessions: sessions.length,
        terms: terms.length,
        classes: activeClasses.length,
        students: studentCount,
      },
      /**
       * Omitted entirely (not zeroed) when the caller may not read invoices, so a
       * client cannot render a financial figure it has no business showing.
       */
      openingBalances: balances
        ? {
            count: balances.count,
            pendingReviewCount: balances.pendingReviewCount,
            pendingPostCount: balances.pendingPostCount,
            approvedNotPostedCount: balances.approvedNotPostedCount,
            outstandingKobo: balances.outstandingKobo,
            hasPriorTerm: balances.hasPriorTerm,
          }
        : null,
      // The session a new term should belong to. Newest first, because a school
      // setting up today wants the year it is in, not the oldest on file.
      sessions: sessions
        .map((s) => ({
          id: s.id,
          name: s.name,
          startsOn: String(s.startsOn),
          isCurrent: s.isCurrent,
        }))
        .sort((a, b) => String(b.startsOn).localeCompare(String(a.startsOn))),
      currentTerm: currentTerm
        ? {
            id: currentTerm.id,
            name: currentTerm.name,
            label: currentTerm.label,
            status: currentTerm.status,
            startsOn: currentTerm.startsOn,
            sessionId: currentTerm.sessionId,
          }
        : null,
      steps,
      /** The single next thing to do — what the guide highlights. */
      nextStep: firstIncomplete?.key ?? 'ready',
      readyToBill: Boolean(
        currentTerm &&
        currentTerm.status === 'ACTIVE' &&
        activeClasses.length > 0 &&
        studentCount > 0,
      ),
    });
  },
);
