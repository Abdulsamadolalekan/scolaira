/**
 * Student import planning — the rules a school's spreadsheet is read by.
 *
 * This module is PURE. It takes a parsed CSV plus the school's existing data
 * (classes, existing admission numbers, existing names) and produces a PLAN:
 * what would be created, what is wrong, and what the school should look at. It
 * writes nothing. That is deliberate — the dry run and the real commit run the
 * SAME function, so the preview a bursar approves is produced by the code that
 * later performs the work, not by a cheaper approximation of it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE GOVERNING RULE: NEVER INVENT DATA
 * ════════════════════════════════════════════════════════════════════════════
 * Every ambiguity below is resolved by an EXPLICIT, DOCUMENTED decision. Where
 * a value cannot be interpreted with confidence, the row is refused rather than
 * guessed at, because a school's records are the basis of what it later bills
 * and a silently invented value is indistinguishable from a real one.
 *
 * Each decision is marked DECISION-n so the tests can pin it and the evidence
 * file can list it.
 *
 * ── DECISION-1: unrecognised columns are reported, never ignored silently ──
 *    A column the importer does not understand is named in a warning. It is not
 *    an error (schools legitimately carry extra columns), but the school is told
 *    exactly which of its columns were not used, so nothing is dropped quietly.
 *
 * ── DECISION-2: blank rows are counted, not imported ──
 *    A fully blank row is skipped and reported in the summary. The count is
 *    always visible so "I uploaded 400 and it said 397" is explainable.
 *
 * ── DECISION-3: required fields are admission number, first name, last name ──
 *    Missing any of these fails the ROW, with the row number and the column.
 *
 * ── DECISION-4: dates are read day-first, and ambiguity is declared ──
 *    `2020-01-15` (ISO) is unambiguous. `15/01/2020` and `15-01-2020` are read
 *    as day/month/year, the Nigerian convention. When BOTH leading components
 *    are ≤ 12 (e.g. `03/04/2020`) the value is genuinely ambiguous; it is read
 *    day-first AND a warning states the interpretation, so a school that meant
 *    March 4th is told that it was read as 3 April and can correct the file.
 *    Nothing is silently swapped.
 *
 * ── DECISION-5: gender accepts M/F/OTHER and explicit "not stated" markers ──
 *    `M`, `male`, `boy` → `M`; `F`, `female`, `girl` → `F`; `other` → `OTHER`.
 *    An explicit absence marker (`-`, `n/a`, `none`, `unknown`) means NOT
 *    SUPPLIED, and is recorded as absent. Any other token fails the row: the
 *    column exists, so its contents must mean something.
 *
 * ── DECISION-6: a phone number that cannot be a Nigerian number is not stored ──
 *    Numbers are normalised (`0803 555 0142` → `08035550142`,
 *    `+234 803 555 0142` → `+2348035550142`). A value that cannot be a phone
 *    number is NOT imported and NOT invented — the guardian simply has no phone,
 *    a warning names the rejected value, and the school can fix it. Silence here
 *    would be the worst outcome: a reminder aimed at `call mama` fails at send
 *    time, months later, in front of a parent.
 *
 * ── DECISION-7: a guardian contact with no guardian name fails the row ──
 *    A phone or email with no name cannot become a guardian (a guardian is a
 *    named contact), and discarding a parent's number without asking is quiet
 *    data loss. The row is refused so the SCHOOL decides: type the name, or
 *    remove the number.
 *
 * ── DECISION-8: an admission number that already exists fails the row ──
 *    Existing students are never silently skipped and never overwritten. The
 *    message names the student who already holds the number.
 *
 * ── DECISION-9: an admission number repeated inside the file fails the row ──
 *    The message names the earlier row, so a school can see which one to delete.
 *
 * ── DECISION-10: a possible duplicate by name is a WARNING, not a failure ──
 *    Same name and same date of birth as an existing student, or as an earlier
 *    row, is reported but does not block. Names repeat in real schools and
 *    birthdays are often recorded as 1 January; refusing on a match would block
 *    legitimate admissions. The school decides, having been told.
 *
 * ── DECISION-11: an unknown class name fails the row, after a lenient match ──
 *    Class names are matched case-insensitively and ignoring internal spacing
 *    (`ss1` and `SS 1` find `SS1`), because that is a typing difference, not a
 *    difference of meaning. A name that still matches nothing fails the row and
 *    the message says so — classes are academic structure that the school
 *    creates deliberately in the previous step, not something a CSV may invent.
 *
 * ── DECISION-12: the enrollment date defaults to the term start, announced ──
 *    An explicit `admission_date` / `enrolled_on` column wins. Otherwise the
 *    enrolment is dated to the term's start and the plan SAYS SO, so the default
 *    is visible before the school approves it.
 *
 * ── DECISION-13: rows above the cap are refused before any work is done ──
 *    A cap keeps the commit transaction bounded. The school is told the number
 *    and the limit rather than receiving a truncated import.
 */

import type { CsvRow, Delimiter, ParsedCsv } from './csv';

// ══════════════════════ Types ══════════════════════

export type Severity = 'ERROR' | 'WARNING';

export interface RowIssue {
  severity: Severity;
  /** The CSV column this concerns, when the issue is about one column. */
  column?: string;
  /** 1-based line in the source file. */
  line: number;
  /** Machine-readable reason, so tests and the UI do not parse prose. */
  code: string;
  message: string;
}

export interface PlannedGuardian {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  relationship: GuardianRelationship;
  isPrimary: boolean;
}

export interface PlannedStudent {
  line: number;
  studentId: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  gender: 'M' | 'F' | 'OTHER' | null;
  dateOfBirth: string | null;
  admissionDate: string | null;
  /** Resolved class id, or null when the row carried no class. */
  classId: string | null;
  className: string | null;
  enrolledOn: string | null;
  guardian: PlannedGuardian | null;
}

export interface ImportPlan {
  rows: PlannedStudent[];
  issues: RowIssue[];
  summary: {
    totalRows: number;
    blankRows: number;
    importable: number;
    rowsWithErrors: number;
    rowsWithWarnings: number;
    guardiansToCreate: number;
    enrollmentsToCreate: number;
    studentsWithoutClass: number;
    unrecognisedColumns: string[];
    matchedColumns: Record<string, string>;
    delimiter: Delimiter;
    /** Fingerprint of the reviewed plan; the commit refuses a different one. */
    planHash: string;
    /** Human-readable notes about defaults applied to the whole file. */
    notes: string[];
  };
}

export type GuardianRelationship = 'PARENT' | 'GUARDIAN' | 'SPONSOR' | 'OTHER';

/** The school-side reference data the planner validates against. */
export interface ImportReference {
  classes: Array<{ id: string; name: string; arm: string | null; label: string }>;
  /** Admission numbers that already exist, mapped to the student holding them. */
  existingStudents: Map<string, { name: string; status: string }>;
  /** Existing students by "first|last|dob" for the possible-duplicate warning. */
  existingByNameDob: Map<string, string>;
  term: { id: string; name: string; startsOn: string; status: string } | null;
}

export const IMPORT_LIMITS = {
  /** Maximum data rows in one import. */
  maxRows: 1000,
  /** Maximum characters of CSV accepted (roughly 1,000 rows at 400 bytes). */
  maxBytes: 2_000_000,
  maxColumns: 64,
} as const;

// ══════════════════════ Header mapping ══════════════════════

/**
 * Accepted header names, per field.
 *
 * Written as normalised keys: lower-cased, with runs of non-alphanumeric
 * characters collapsed to a single space. So `Admission No.`, `admission_no` and
 * `ADMISSION  NUMBER` all arrive as `admission no`, `admission no` and
 * `admission number` — and all three are listed.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  studentId: [
    'student id',
    'studentid',
    'student number',
    'admission no',
    'admission number',
    'admission no.',
    'adm no',
    'adm',
    'reg no',
    'registration number',
    'registration no',
    'id',
    'pupil id',
    'student code',
  ],
  firstName: ['first name', 'firstname', 'given name', 'given names', 'forename'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'second name'],
  middleName: ['middle name', 'middlename', 'other name', 'other names', 'othername'],
  gender: ['gender', 'sex'],
  dateOfBirth: [
    'date of birth',
    'dob',
    'd o b',
    'birth date',
    'birthday',
    'date of birth yyyy mm dd',
  ],
  admissionDate: [
    'admission date',
    'date admitted',
    'admitted on',
    'enrolled on',
    'enrollment date',
    'enrolment date',
  ],
  className: ['class', 'class name', 'grade', 'form', 'level', 'class level', 'arm', 'section'],
  guardianName: [
    'guardian name',
    'parent name',
    'guardian',
    'parent',
    'guardian full name',
    'parent full name',
  ],
  guardianFirstName: [
    'guardian first name',
    'parent first name',
    'guardian firstname',
    'parent firstname',
  ],
  guardianLastName: [
    'guardian last name',
    'parent last name',
    'guardian surname',
    'parent surname',
    'guardian lastname',
  ],
  guardianPhone: [
    'guardian phone',
    'guardian phone number',
    'parent phone',
    'parent phone number',
    'phone',
    'phone number',
    'mobile',
    'mobile number',
    'telephone',
    'tel',
    'contact',
    'contact number',
    'guardian mobile',
    'parent mobile',
  ],
  guardianEmail: [
    'guardian email',
    'parent email',
    'email',
    'email address',
    'guardian e mail',
    'e mail',
  ],
  relationship: [
    'relationship',
    'relationship to student',
    'relation',
    'guardian relationship',
    'parent relationship',
  ],
  primary: [
    'primary',
    'is primary',
    'primary guardian',
    'primary contact',
    'main contact',
    'is primary guardian',
  ],
};

/** Normalise a header cell for alias comparison. */
export function normaliseHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface HeaderMapping {
  /** field → column index. A field present in `ambiguous` maps to no column. */
  index: Record<string, number>;
  /** Normalised headers that matched no known field (DECISION-1). */
  unrecognised: string[];
  /** Fields that appeared in more than one column — refused rather than guessed. */
  ambiguous: Array<{ field: string; columns: string[] }>;
  /** Original header text, for messages. */
  headers: string[];
}

/**
 * Map the file's columns to fields.
 *
 * DECISION-14: if two columns claim the same field (both `Phone` and
 * `Guardian Phone` are present, say) the importer does NOT pick one. Guessing
 * would silently discard the other column, so the duplicate is reported and the
 * file is refused until the school says which is which.
 */
export function mapHeaders(headers: string[]): HeaderMapping {
  const seen = new Map<string, string[]>();
  for (const header of headers) {
    const key = normaliseHeader(header);
    if (!key) continue;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key)) {
        const list = seen.get(field) ?? [];
        list.push(header);
        seen.set(field, list);
        break;
      }
    }
  }

  const index: Record<string, number> = {};
  const ambiguous: Array<{ field: string; columns: string[] }> = [];
  for (const [field, columns] of seen.entries()) {
    if (columns.length > 1) {
      ambiguous.push({ field, columns });
      continue;
    }
    index[field] = headers.indexOf(columns[0]!);
  }

  const matched = new Set(Object.values(index));
  const unrecognised = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => normaliseHeader(h) !== '' && !matched.has(i))
    // A column that matched a field but was disambiguated away is reported as
    // unrecognised too — it is in the file and it is not being used.
    .filter(({ h }) => !Object.values(seen).flat().includes(h))
    .map(({ h }) => h);

  return { index, unrecognised, ambiguous, headers };
}

// ══════════════════════ Field parsing ══════════════════════

const ABSENT_MARKERS = new Set([
  '-',
  '--',
  'n/a',
  'na',
  'n a',
  'none',
  'nil',
  'unknown',
  'not stated',
  'not provided',
  'null',
]);

const GENDERS: Record<string, 'M' | 'F' | 'OTHER'> = {
  m: 'M',
  male: 'M',
  boy: 'M',
  f: 'F',
  female: 'F',
  girl: 'F',
  other: 'OTHER',
  others: 'OTHER',
};

export type DateResult =
  { ok: true; value: string; ambiguous: boolean } | { ok: false; reason: string };

/**
 * Parse a date as day-first, per DECISION-4.
 *
 * Accepts `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` and `D/M/YY`. Two-digit years
 * are mapped into 1900–2099 by a fixed pivot: a school record is a birth date or
 * an admission date, so `85` is 1985 and `12` is 2012. The pivot is stated here
 * rather than inferred per value.
 */
export function parseSchoolDate(raw: string): DateResult {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (ABSENT_MARKERS.has(value.toLowerCase())) return { ok: false, reason: 'absent' };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), false);

  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(value);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (dmy[3]!.length === 2) year += year <= 29 ? 2000 : 1900;
    // Day-first is the Nigerian convention. When the value could equally be
    // month-first, say so rather than letting the school discover it later.
    const ambiguous = day <= 12 && month <= 12 && day !== month;
    return build(year, month, day, ambiguous);
  }

  const textual = /^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-,]*(\d{2}|\d{4})$/.exec(value);
  if (textual) {
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    const month = months.indexOf(textual[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return { ok: false, reason: 'unrecognised date' };
    let year = Number(textual[3]);
    if (textual[3]!.length === 2) year += year <= 29 ? 2000 : 1900;
    return build(year, month, Number(textual[1]), false);
  }

  return { ok: false, reason: 'unrecognised date' };
}

function build(year: number, month: number, day: number, ambiguous: boolean): DateResult {
  if (month < 1 || month > 12) return { ok: false, reason: 'month out of range' };
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return { ok: false, reason: 'day out of range' };
  if (year < 1900 || year > 2100) return { ok: false, reason: 'year out of range' };
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { ok: true, value: iso, ambiguous };
}

export type PhoneResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Normalise a phone number, per DECISION-6.
 *
 * A Nigerian number after normalisation is 7–15 digits with an optional leading
 * `+`. Deliberately permissive about presentation (spaces, dashes, brackets,
 * dots) and strict about content: a value that cannot be dialled is refused and
 * the guardian is left without a phone rather than carrying a number that will
 * fail months later.
 */
export function normalisePhone(raw: string): PhoneResult {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (ABSENT_MARKERS.has(value.toLowerCase())) return { ok: false, reason: 'absent' };
  const cleaned = value.replace(/[\s()\-.\u2013\u2014]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, reason: 'not a number' };
  const digits = cleaned.replace(/^\+/, '');
  if (digits.length < 7) return { ok: false, reason: 'too short' };
  if (digits.length > 15) return { ok: false, reason: 'too long' };
  if (!cleaned.startsWith('+') && digits.length > 11)
    return { ok: false, reason: 'too long for a local number' };
  return { ok: true, value: cleaned };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(raw: string): { ok: boolean; value: string | null } {
  const value = raw.trim().toLowerCase();
  if (!value || ABSENT_MARKERS.has(value)) return { ok: true, value: null };
  if (!EMAIL_RE.test(value)) return { ok: false, value: null };
  return { ok: true, value };
}

export function parseGender(
  raw: string,
): { ok: true; value: 'M' | 'F' | 'OTHER' | null } | { ok: false } {
  const value = raw.trim().toLowerCase();
  if (!value || ABSENT_MARKERS.has(value)) return { ok: true, value: null };
  const mapped = GENDERS[value];
  return mapped ? { ok: true, value: mapped } : { ok: false };
}

/** `1`, `y`, `yes`, `true`, `primary` all mean yes; absence means no. */
export function parseBoolean(raw: string): boolean {
  const value = normaliseHeader(raw);
  return ['1', 'y', 'yes', 'true', 'primary', 't'].includes(value);
}

export function parseRelationship(raw: string): GuardianRelationship {
  const value = normaliseHeader(raw);
  if (['mother', 'father', 'mum', 'dad', 'parent', 'parents', 'mummy', 'daddy'].includes(value))
    return 'PARENT';
  if (
    [
      'guardian',
      'caretaker',
      'carer',
      'aunt',
      'uncle',
      'grandmother',
      'grandfather',
      'grandparent',
      'sibling',
    ].includes(value)
  )
    return 'GUARDIAN';
  if (
    [
      'sponsor',
      'scholarship',
      'benefactor',
      'ngo',
      'church',
      'mosque',
      'organisation',
      'organization',
    ].includes(value)
  )
    return 'SPONSOR';
  if (value === 'other') return 'OTHER';
  return 'PARENT';
}

/** Split a single "Ada Ngozi Eze" cell into first / last, explicitly. */
export function splitPersonName(raw: string): { firstName: string; lastName: string } | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

// ══════════════════════ The planner ══════════════════════

function cell(row: CsvRow, mapping: HeaderMapping, field: string): string {
  const index = mapping.index[field];
  if (index === undefined) return '';
  return (row.cells[index] ?? '').trim();
}

function nameDobKey(first: string, last: string, dob: string | null): string {
  return `${first.toLowerCase()}|${last.toLowerCase()}|${dob ?? ''}`;
}

/**
 * Build the plan.
 *
 * `enrolledOnOverride` is the date the school chose in the UI; it is used when a
 * row carries no explicit admission/enrolment date (DECISION-12).
 */
export function planImport(
  parsed: ParsedCsv,
  reference: ImportReference,
  options: { enrolledOnOverride?: string | null } = {},
): ImportPlan {
  const mapping = mapHeaders(parsed.headers);
  const issues: RowIssue[] = [];
  const notes: string[] = [];
  const rows: PlannedStudent[] = [];

  // ── File-level checks ──────────────────────────────────────────────────
  if (parsed.headers.length > IMPORT_LIMITS.maxColumns) {
    issues.push({
      severity: 'ERROR',
      line: 1,
      code: 'TOO_MANY_COLUMNS',
      message: `The file has ${parsed.headers.length} columns; the importer accepts up to ${IMPORT_LIMITS.maxColumns}.`,
    });
  }
  for (const dup of mapping.ambiguous) {
    issues.push({
      severity: 'ERROR',
      line: 1,
      code: 'AMBIGUOUS_COLUMN',
      message:
        `${dup.columns.map((c) => `"${c}"`).join(' and ')} both look like the ${dup.field} column. ` +
        `The importer will not guess which to use — keep one and re-upload.`,
    });
  }
  if (mapping.index.firstName === undefined) {
    issues.push({
      severity: 'ERROR',
      line: 1,
      code: 'MISSING_COLUMN',
      column: 'first name',
      message: 'No first-name column was found. Accepted names: "First Name", "Given Name".',
    });
  }
  if (mapping.index.lastName === undefined) {
    issues.push({
      severity: 'ERROR',
      line: 1,
      code: 'MISSING_COLUMN',
      column: 'last name',
      message:
        'No last-name column was found. Accepted names: "Last Name", "Surname", "Family Name".',
    });
  }
  if (mapping.index.studentId === undefined) {
    issues.push({
      severity: 'ERROR',
      line: 1,
      code: 'MISSING_COLUMN',
      column: 'admission number',
      message:
        'No admission-number column was found. Accepted names: "Student ID", "Admission No", "Adm No", "Reg No". ' +
        'An admission number is how a student is identified on receipts and statements, so the importer will not invent one.',
    });
  }
  for (const column of mapping.unrecognised) {
    issues.push({
      severity: 'WARNING',
      line: 1,
      code: 'UNRECOGNISED_COLUMN',
      column,
      message: `The column "${column}" was not recognised and will not be imported.`,
    });
  }

  // A file that cannot be read at all stops here rather than producing a page of
  // identical row errors.
  const fatal = issues.some((i) => i.severity === 'ERROR');
  const headerCount = parsed.headers.length;

  // ── Per-row checks ─────────────────────────────────────────────────────
  const classIndex = new Map<string, { id: string; label: string }>();
  for (const schoolClass of reference.classes) {
    classIndex.set(normaliseHeader(schoolClass.label), {
      id: schoolClass.id,
      label: schoolClass.label,
    });
    classIndex.set(normaliseHeader(schoolClass.name), {
      id: schoolClass.id,
      label: schoolClass.label,
    });
  }

  // Admission number → the line that first claimed it, and the child it claimed.
  // The identity fields are only used to word the repeat-in-file message (see
  // DECISION-9); the duplicate check itself keys on the admission number alone.
  const seenStudentIds = new Map<string, { line: number; name: string; dob: string }>();
  const seenNameDob = new Map<string, number>();
  let blankRows = 0;
  let guardiansToCreate = 0;

  const dataRows = parsed.rows;
  const tooMany = dataRows.filter((r) => !r.blank).length > IMPORT_LIMITS.maxRows;
  if (tooMany) {
    issues.push({
      severity: 'ERROR',
      line: 1,
      code: 'TOO_MANY_ROWS',
      message: `The file has ${dataRows.filter((r) => !r.blank).length} student rows; the importer accepts up to ${IMPORT_LIMITS.maxRows} in one upload. Split the file and import it in parts.`,
    });
  }

  for (const row of dataRows) {
    if (row.blank) {
      blankRows += 1;
      continue;
    }
    if (fatal || tooMany) continue;

    if (row.ragged) {
      issues.push({
        severity: 'ERROR',
        line: row.line,
        code: 'RAGGED_ROW',
        message: `This row has ${row.cells.length} values but the header has ${headerCount}. Check for a missing or extra comma.`,
      });
      continue;
    }

    const studentId = cell(row, mapping, 'studentId');
    const firstName = cell(row, mapping, 'firstName');
    const lastName = cell(row, mapping, 'lastName');
    const middleName = cell(row, mapping, 'middleName');

    let rowFailed = false;
    const fail = (code: string, column: string, message: string) => {
      rowFailed = true;
      issues.push({ severity: 'ERROR', line: row.line, column, code, message });
    };
    const warn = (code: string, column: string, message: string) => {
      issues.push({ severity: 'WARNING', line: row.line, column, code, message });
    };

    // DECISION-3 — required fields.
    if (!studentId)
      fail('MISSING_ADMISSION_NUMBER', 'admission number', 'Admission number is required.');
    if (!firstName) fail('MISSING_FIRST_NAME', 'first name', 'First name is required.');
    if (!lastName) fail('MISSING_LAST_NAME', 'last name', 'Last name is required.');

    // DECISION-8 — already exists.
    if (studentId) {
      const existing = reference.existingStudents.get(studentId.toUpperCase());
      if (existing) {
        fail(
          'DUPLICATE_ADMISSION_NUMBER',
          'admission number',
          `Admission number ${studentId} already belongs to ${existing.name} (${existing.status.toLowerCase()}). ` +
            `Remove this row, or give the student a different admission number.`,
        );
      }
      // DECISION-9 — repeated inside the file.
      const earlier = seenStudentIds.get(studentId.toUpperCase());
      if (earlier !== undefined) {
        const previousLine = earlier.line;
        // A school that exports one row per guardian repeats the child, not the
        // mistake. Telling that person to "remove one of the two rows" invites
        // them to delete a guardian record to make the file pass, so the
        // message has to name what actually happened and where the second
        // guardian belongs. The row is still blocked: the duplicate check itself
        // is unchanged, and one row still means one guardian per student.
        const sameFullName = `${firstName} ${lastName}`.trim() === earlier.name;
        // Compared as written in the file: two rows saying "2013-09-02" and
        // "02/09/2013" are the same child to a human and to us they are two
        // different strings, and the conservative message is the blunt one.
        const sameDob = cell(row, mapping, 'dateOfBirth').trim().toLowerCase() === earlier.dob;
        const sameChildTwice = sameFullName && sameDob;
        fail(
          'REPEATED_IN_FILE',
          'admission number',
          sameChildTwice
            ? `Admission number ${studentId} also appears on line ${previousLine} — the same child, with a different guardian. ` +
                `The import records one guardian per student. Keep the first row, then add this guardian on the student's page after importing.`
            : `Admission number ${studentId} also appears on line ${previousLine}. Remove one of the two rows.`,
        );
      }
      if (studentId.length > 32) {
        fail(
          'ADMISSION_NUMBER_TOO_LONG',
          'admission number',
          `Admission number must be 32 characters or fewer (this one is ${studentId.length}).`,
        );
      }
    }
    if (firstName.length > 120)
      fail('NAME_TOO_LONG', 'first name', 'First name must be 120 characters or fewer.');
    if (lastName.length > 120)
      fail('NAME_TOO_LONG', 'last name', 'Last name must be 120 characters or fewer.');

    // Gender — DECISION-5.
    let gender: 'M' | 'F' | 'OTHER' | null = null;
    const genderCell = cell(row, mapping, 'gender');
    if (genderCell) {
      const parsedGender = parseGender(genderCell);
      if (parsedGender.ok) gender = parsedGender.value;
      else
        fail(
          'UNRECOGNISED_GENDER',
          'gender',
          `"${genderCell}" is not a recognised gender. Use M, F or Other, or leave the cell blank.`,
        );
    }

    // Dates — DECISION-4.
    let dateOfBirth: string | null = null;
    const dobCell = cell(row, mapping, 'dateOfBirth');
    if (dobCell) {
      const parsedDate = parseSchoolDate(dobCell);
      if (parsedDate.ok) {
        dateOfBirth = parsedDate.value;
        if (parsedDate.ambiguous) {
          warn(
            'AMBIGUOUS_DATE',
            'date of birth',
            `"${dobCell}" could be month-first or day-first. It was read as ${humanDate(parsedDate.value)} (day first). ` +
              `If that is wrong, write the date as ${parsedDate.value}.`,
          );
        }
        if (dateOfBirth > new Date().toISOString().slice(0, 10)) {
          fail('DATE_IN_FUTURE', 'date of birth', `Date of birth ${dateOfBirth} is in the future.`);
        }
      } else if (parsedDate.reason === 'absent') {
        dateOfBirth = null;
      } else {
        fail(
          'UNREADABLE_DATE',
          'date of birth',
          `"${dobCell}" is not a date this importer can read. Use YYYY-MM-DD (for example 2013-09-02) or DD/MM/YYYY.`,
        );
      }
    }

    // Class — DECISION-11.
    let classId: string | null = null;
    let className: string | null = null;
    const classCell = cell(row, mapping, 'className');
    if (classCell) {
      const match = classIndex.get(normaliseHeader(classCell));
      if (match) {
        classId = match.id;
        className = match.label;
      } else if (reference.classes.length === 0) {
        fail(
          'NO_CLASSES_DEFINED',
          'class',
          `This row names class "${classCell}", but no classes have been set up yet. Add your classes first, then import.`,
        );
      } else {
        fail(
          'UNKNOWN_CLASS',
          'class',
          `No class called "${classCell}" exists. Your classes are: ${reference.classes
            .slice(0, 12)
            .map((c) => c.label)
            .join(
              ', ',
            )}${reference.classes.length > 12 ? ', …' : ''}. Add the class, or correct the name.`,
        );
      }
    }

    // Enrollment date — DECISION-12.
    let enrolledOn: string | null = null;
    if (classId) {
      const explicit = cell(row, mapping, 'admissionDate');
      if (explicit) {
        const parsedDate = parseSchoolDate(explicit);
        if (parsedDate.ok) {
          enrolledOn = parsedDate.value;
          if (parsedDate.ambiguous) {
            warn(
              'AMBIGUOUS_DATE',
              'admission date',
              `"${explicit}" could be month-first or day-first. It was read as ${humanDate(parsedDate.value)} (day first).`,
            );
          }
        } else {
          fail(
            'UNREADABLE_DATE',
            'admission date',
            `"${explicit}" is not a date this importer can read. Use YYYY-MM-DD or DD/MM/YYYY.`,
          );
        }
      } else if (options.enrolledOnOverride) {
        enrolledOn = options.enrolledOnOverride;
      } else if (reference.term) {
        enrolledOn = reference.term.startsOn;
      }

      if (enrolledOn && enrolledOn > new Date().toISOString().slice(0, 10)) {
        fail('DATE_IN_FUTURE', 'admission date', `Enrolment date ${enrolledOn} is in the future.`);
      }
      if (reference.term && reference.term.status === 'PLANNED') {
        fail(
          'TERM_NOT_ACTIVE',
          'class',
          `Term "${reference.term.name}" has not been activated yet. Activate it in Academic setup, then import.`,
        );
      }
      if (reference.term && reference.term.status === 'CLOSED') {
        fail(
          'TERM_CLOSED',
          'class',
          `Term "${reference.term.name}" is closed and cannot receive enrolments.`,
        );
      }
    }

    // Guardian — DECISION-6, DECISION-7.
    let guardian: PlannedGuardian | null = null;
    const guardianSingle = cell(row, mapping, 'guardianName');
    const gFirstRaw = cell(row, mapping, 'guardianFirstName');
    const gLastRaw = cell(row, mapping, 'guardianLastName');
    const phoneRaw = cell(row, mapping, 'guardianPhone');
    const emailRaw = cell(row, mapping, 'guardianEmail');

    let gFirst = gFirstRaw;
    let gLast = gLastRaw;
    if (!gFirst && !gLast && guardianSingle) {
      const split = splitPersonName(guardianSingle);
      if (split) {
        gFirst = split.firstName;
        // A single-word guardian name is a real thing on a form. Recording it as
        // a first name with no surname would fail the guardian's own rule (a
        // guardian needs both), so the row is refused with guidance rather than
        // the importer inventing a surname.
        gLast = split.lastName;
      }
    }

    if (gFirst && !gLast) {
      fail(
        'INCOMPLETE_GUARDIAN_NAME',
        'guardian name',
        `Guardian "${gFirst}" has no surname. Write the full name (for example "${gFirst} Okonkwo") so the parent can be identified on receipts and statements.`,
      );
    }

    const phone = phoneRaw
      ? normalisePhone(phoneRaw)
      : ({ ok: false, reason: 'empty' } as PhoneResult);
    const email = emailRaw ? normaliseEmail(emailRaw) : { ok: true, value: null };

    if (phoneRaw && !phone.ok && phone.reason !== 'empty' && phone.reason !== 'absent') {
      warn(
        'PHONE_NOT_IMPORTED',
        'guardian phone',
        `"${phoneRaw}" was not recognised as a phone number (${phone.reason}) and was NOT imported. ` +
          `Correct it and re-upload to keep this number.`,
      );
    }
    if (emailRaw && !email.ok) {
      warn(
        'EMAIL_NOT_IMPORTED',
        'guardian email',
        `"${emailRaw}" is not a valid email address and was NOT imported.`,
      );
    }

    const hasContact = (phone.ok ? 1 : 0) + (email.value ? 1 : 0) > 0;
    if (hasContact && !gFirst) {
      fail(
        'GUARDIAN_CONTACT_WITHOUT_NAME',
        'guardian name',
        "A guardian phone or email was given but no guardian name. Add the guardian's name, or clear the contact — " +
          'the importer will not attach a phone number to nobody.',
      );
    }

    if (gFirst && gLast) {
      const relationship = cell(row, mapping, 'relationship');
      guardian = {
        firstName: gFirst,
        lastName: gLast,
        phone: phone.ok ? phone.value : null,
        email: email.value,
        relationship: parseRelationship(relationship),
        isPrimary: parseBoolean(cell(row, mapping, 'primary')),
      };
      if (!phone.ok && !email.value) {
        warn(
          'GUARDIAN_WITHOUT_CONTACT',
          'guardian phone',
          `Guardian ${gFirst} ${gLast} has no phone or email, so this student cannot be contacted about fees yet.`,
        );
      }
    }

    // DECISION-10 — possible duplicate by name and date of birth.
    if (!rowFailed && firstName && lastName) {
      const key = nameDobKey(firstName, lastName, dateOfBirth);
      const existingName = reference.existingByNameDob.get(key);
      if (existingName) {
        warn(
          'POSSIBLE_DUPLICATE_EXISTING',
          'first name',
          `${firstName} ${lastName} matches an existing student (${existingName}) with the same date of birth. ` +
            `If this is the same child, do not import this row.`,
        );
      }
      const earlierLine = seenNameDob.get(key);
      if (earlierLine !== undefined) {
        warn(
          'POSSIBLE_DUPLICATE_IN_FILE',
          'first name',
          `${firstName} ${lastName} also appears on line ${earlierLine} with the same date of birth.`,
        );
      }
    }

    if (studentId)
      seenStudentIds.set(studentId.toUpperCase(), {
        line: row.line,
        name: `${firstName} ${lastName}`.trim(),
        dob: cell(row, mapping, 'dateOfBirth').trim().toLowerCase(),
      });
    if (firstName && lastName)
      seenNameDob.set(nameDobKey(firstName, lastName, dateOfBirth), row.line);

    if (rowFailed) continue;

    if (guardian) guardiansToCreate += 1;
    rows.push({
      line: row.line,
      studentId,
      firstName,
      lastName,
      middleName: middleName || null,
      gender,
      dateOfBirth,
      admissionDate: cell(row, mapping, 'admissionDate') || null,
      classId,
      className,
      enrolledOn,
      guardian,
    });
  }

  // ── Whole-file notes ───────────────────────────────────────────────────
  // DECISION-12 is only worth stating if it actually applied: name the default
  // visible before the school approves the import.
  const datedToTermStart = parsed.rows.filter((row) => {
    if (row.blank) return false;
    if (mapping.index.admissionDate === undefined) return true;
    return (row.cells[mapping.index.admissionDate] ?? '').trim() === '';
  }).length;
  if (reference.term && datedToTermStart > 0 && rows.some((r) => r.classId)) {
    notes.push(
      `${datedToTermStart} enrolment${datedToTermStart === 1 ? '' : 's'} had no admission date and ${
        datedToTermStart === 1 ? 'was' : 'were'
      } dated to the start of ${reference.term.name} (${reference.term.startsOn}).`,
    );
  }
  const withoutClass = rows.filter((r) => !r.classId).length;
  if (withoutClass > 0) {
    notes.push(
      `${withoutClass} student${withoutClass === 1 ? '' : 's'} had no class and will be created without a class enrollment. ` +
        `They cannot be billed until they are enrolled.`,
    );
  }
  if (blankRows > 0) {
    notes.push(`${blankRows} blank row${blankRows === 1 ? '' : 's'} were skipped.`);
  }
  const classNameCount = mapping.index.className !== undefined;
  if (!classNameCount && rows.length > 0) {
    notes.push('The file had no class column, so no student was enrolled into a class.');
  }

  const rowsWithErrors = new Set(issues.filter((i) => i.severity === 'ERROR').map((i) => i.line))
    .size;
  const rowsWithWarnings = new Set(
    issues.filter((i) => i.severity === 'WARNING' && i.line > 1).map((i) => i.line),
  ).size;

  const summary = {
    totalRows: parsed.rows.length,
    blankRows,
    importable: rows.length,
    rowsWithErrors,
    rowsWithWarnings,
    guardiansToCreate,
    enrollmentsToCreate: rows.filter((r) => r.classId !== null).length,
    studentsWithoutClass: withoutClass,
    unrecognisedColumns: mapping.unrecognised,
    matchedColumns: Object.fromEntries(
      Object.entries(mapping.index).map(([field, idx]) => [field, parsed.headers[idx] ?? '']),
    ),
    delimiter: parsed.delimiter,
    planHash: '',
    notes,
  };

  const plan: ImportPlan = { rows, issues, summary };
  plan.summary.planHash = hashPlan(plan);
  return plan;
}

/**
 * Fingerprint of the reviewed plan.
 *
 * The commit endpoint recomputes this from the file the client submits and
 * refuses the import when it differs from the hash the school approved. That is
 * what makes "review, then confirm" a real guarantee rather than a claim: the
 * work performed is exactly the work that was previewed, or it does not happen.
 */
export function hashPlan(plan: ImportPlan): string {
  const material = plan.rows.map((r) =>
    [
      r.line,
      r.studentId,
      r.firstName,
      r.lastName,
      r.middleName ?? '',
      r.gender ?? '',
      r.dateOfBirth ?? '',
      r.classId ?? '',
      r.enrolledOn ?? '',
      r.guardian
        ? [
            r.guardian.firstName,
            r.guardian.lastName,
            r.guardian.phone ?? '',
            r.guardian.email ?? '',
            r.guardian.relationship,
            r.guardian.isPrimary ? '1' : '0',
          ].join('~')
        : '',
    ].join('|'),
  );
  // The ISSUES are part of the fingerprint, not just the importable rows.
  //
  // Measuring this caught a real weakness: two different files that each contain
  // nothing but errors produced byte-identical hashes, because the material was
  // built from an empty row set. Both files were correctly unimportable, so no
  // bad data could have been written — but a fingerprint that cannot tell two
  // different plans apart is not a fingerprint. Including the problems means any
  // change to what the school was shown changes the hash.
  const issueMaterial = plan.issues.map((i) =>
    [i.severity, String(i.line), i.code, i.column ?? '', i.message].join('|'),
  );
  const payload = [
    material.join('\n'),
    `--${plan.summary.importable}--${plan.summary.blankRows}--`,
    issueMaterial.join('\n'),
  ].join('\n');
  // A small, dependency-free FNV-1a over the material. This is a change-detector
  // for a review step, not a security control — the commit re-validates against
  // the database regardless, so a collision cannot create a duplicate student.
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${payload.length.toString(16)}`;
}

/** `2026-09-08` → `8 September 2026`, for messages a school reads. */
export function humanDate(iso: string): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const [y, m, d] = iso.split('-');
  const monthIndex = Number(m) - 1;
  if (monthIndex < 0 || monthIndex > 11) return iso;
  return `${Number(d)} ${months[monthIndex]} ${y}`;
}

/** CSV of the errors only, so a school can correct and re-upload (requirement 9). */
export function issuesToCsv(issues: RowIssue[]): string {
  const escape = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = ['Line,Severity,Column,Problem,Detail'];
  for (const issue of issues) {
    lines.push(
      [String(issue.line), issue.severity, issue.column ?? '', issue.code, issue.message]
        .map(escape)
        .join(','),
    );
  }
  return lines.join('\r\n');
}
