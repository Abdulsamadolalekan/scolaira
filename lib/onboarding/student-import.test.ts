/**
 * Import planner tests.
 *
 * The planner is where a school's ambiguities are resolved, so these tests pin
 * each decision. The ones that matter most are the refusals: a value the importer
 * cannot interpret confidently must fail the ROW, not be guessed at, because a
 * silently invented date or phone number is indistinguishable from a real one in
 * the school's records and in the bill that follows.
 */
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import {
  hashPlan,
  humanDate,
  issuesToCsv,
  mapHeaders,
  normaliseEmail,
  normalisePhone,
  parseBoolean,
  parseGender,
  parseRelationship,
  parseSchoolDate,
  planImport,
  splitPersonName,
  type ImportReference,
} from './student-import';

const CLASSES = [
  { id: 'c-jss1', name: 'JSS1', arm: null, label: 'JSS1' },
  { id: 'c-ss1', name: 'SS1', arm: 'A', label: 'SS1 A' },
];

function reference(overrides: Partial<ImportReference> = {}): ImportReference {
  return {
    classes: CLASSES,
    existingStudents: new Map(),
    existingByNameDob: new Map(),
    term: { id: 'term-1', name: 'First Term', startsOn: '2026-09-08', status: 'ACTIVE' },
    ...overrides,
  };
}

function plan(csv: string, overrides: Partial<ImportReference> = {}, options = {}) {
  return planImport(parseCsv(csv), reference(overrides), options);
}

describe('header mapping', () => {
  it('accepts the names schools actually write', () => {
    const mapping = mapHeaders([
      'Admission No.',
      'Surname',
      'First Name',
      'Sex',
      'DOB',
      'Class',
      'Parent Name',
      'Parent Phone',
      'Guardian Email',
      'Relationship',
      'Primary',
    ]);
    expect(mapping.index.studentId).toBe(0);
    expect(mapping.index.lastName).toBe(1);
    expect(mapping.index.firstName).toBe(2);
    expect(mapping.index.gender).toBe(3);
    expect(mapping.index.dateOfBirth).toBe(4);
    expect(mapping.index.className).toBe(5);
    expect(mapping.index.guardianName).toBe(6);
    expect(mapping.index.guardianPhone).toBe(7);
    expect(mapping.index.guardianEmail).toBe(8);
    expect(mapping.index.relationship).toBe(9);
    expect(mapping.index.primary).toBe(10);
    expect(mapping.unrecognised).toEqual([]);
  });

  it('is tolerant of punctuation and case in headers', () => {
    const mapping = mapHeaders(['ADMISSION_NO', 'first-name', 'LAST  NAME']);
    expect(mapping.index.studentId).toBe(0);
    expect(mapping.index.firstName).toBe(1);
    expect(mapping.index.lastName).toBe(2);
  });

  it('DECISION-1: names unrecognised columns instead of ignoring them', () => {
    const mapping = mapHeaders(['Admission No', 'First Name', 'Last Name', 'House Colour']);
    expect(mapping.unrecognised).toEqual(['House Colour']);
  });

  it('DECISION-14: refuses to choose between two columns claiming the same field', () => {
    const mapping = mapHeaders(['Adm No', 'First Name', 'Last Name', 'Phone', 'Guardian Phone']);
    expect(mapping.ambiguous).toHaveLength(1);
    expect(mapping.ambiguous[0]!.field).toBe('guardianPhone');
    expect(mapping.index.guardianPhone).toBeUndefined();
  });
});

describe('parseSchoolDate — DECISION-4', () => {
  it('reads ISO dates directly', () => {
    expect(parseSchoolDate('2013-09-02')).toEqual({
      ok: true,
      value: '2013-09-02',
      ambiguous: false,
    });
  });

  it('reads DD/MM/YYYY as day-first, the Nigerian convention', () => {
    expect(parseSchoolDate('15/01/2020')).toEqual({
      ok: true,
      value: '2020-01-15',
      ambiguous: false,
    });
    expect(parseSchoolDate('15-01-2020')).toEqual({
      ok: true,
      value: '2020-01-15',
      ambiguous: false,
    });
  });

  it('FLAGS a genuinely ambiguous date rather than guessing silently', () => {
    const result = parseSchoolDate('03/04/2020');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('2020-04-03'); // day-first
    expect(result.ok && result.ambiguous).toBe(true);
  });

  it('does not flag a date whose first component exceeds 12', () => {
    const result = parseSchoolDate('25/12/2019');
    expect(result.ok && result.ambiguous).toBe(false);
  });

  it('maps two-digit years with a stated pivot', () => {
    expect(
      parseSchoolDate('02/09/13').ok && (parseSchoolDate('02/09/13') as { value: string }).value,
    ).toBe('2013-09-02');
    expect(
      parseSchoolDate('02/09/85').ok && (parseSchoolDate('02/09/85') as { value: string }).value,
    ).toBe('1985-09-02');
  });

  it('reads a textual month', () => {
    expect(
      parseSchoolDate('2 September 2013').ok &&
        (parseSchoolDate('2 September 2013') as { value: string }).value,
    ).toBe('2013-09-02');
    expect(
      parseSchoolDate('2-Sep-2013').ok &&
        (parseSchoolDate('2-Sep-2013') as { value: string }).value,
    ).toBe('2013-09-02');
  });

  it('rejects a day that does not exist in that month', () => {
    expect(parseSchoolDate('31/02/2020').ok).toBe(false);
    expect(parseSchoolDate('2020-02-31').ok).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(parseSchoolDate('next tuesday').ok).toBe(false);
    expect(parseSchoolDate('').ok).toBe(false);
    expect(parseSchoolDate('n/a').ok).toBe(false);
  });
});

describe('normalisePhone — DECISION-6', () => {
  it('strips the punctuation phones are written with', () => {
    expect(normalisePhone('0803 555 0142')).toEqual({ ok: true, value: '08035550142' });
    expect(normalisePhone('(0803)-555-0142')).toEqual({ ok: true, value: '08035550142' });
    expect(normalisePhone('0803.555.0142')).toEqual({ ok: true, value: '08035550142' });
  });

  it('keeps an international prefix', () => {
    expect(normalisePhone('+234 803 555 0142')).toEqual({ ok: true, value: '+2348035550142' });
  });

  it('REFUSES a value that cannot be dialled rather than storing it', () => {
    expect(normalisePhone('call mama').ok).toBe(false);
    expect(normalisePhone('0803-CALL').ok).toBe(false);
    expect(normalisePhone('12345').ok).toBe(false); // too short
    expect(normalisePhone('+1234567890123456789').ok).toBe(false); // too long
    expect(normalisePhone('0803555014299999').ok).toBe(false);
  });

  it('treats an explicit absence marker as absent, not as a bad number', () => {
    expect(normalisePhone('n/a').ok).toBe(false);
    expect((normalisePhone('n/a') as { reason: string }).reason).toBe('absent');
  });
});

describe('other field parsing', () => {
  it('accepts M/F/OTHER and words a school writes', () => {
    expect(parseGender('M')).toEqual({ ok: true, value: 'M' });
    expect(parseGender('male')).toEqual({ ok: true, value: 'M' });
    expect(parseGender('Boy')).toEqual({ ok: true, value: 'M' });
    expect(parseGender('f')).toEqual({ ok: true, value: 'F' });
    expect(parseGender('girl')).toEqual({ ok: true, value: 'F' });
    expect(parseGender('other')).toEqual({ ok: true, value: 'OTHER' });
  });

  it('treats a blank or absence marker as not supplied', () => {
    expect(parseGender('')).toEqual({ ok: true, value: null });
    expect(parseGender('-')).toEqual({ ok: true, value: null });
    expect(parseGender('n/a')).toEqual({ ok: true, value: null });
  });

  it('DECISION-5: refuses an unrecognised gender rather than guessing', () => {
    expect(parseGender('yes').ok).toBe(false);
    expect(parseGender('M/F').ok).toBe(false);
  });

  it('maps relationships onto the four the schema allows', () => {
    expect(parseRelationship('Mother')).toBe('PARENT');
    expect(parseRelationship('Father')).toBe('PARENT');
    expect(parseRelationship('Uncle')).toBe('GUARDIAN');
    expect(parseRelationship('Sponsor')).toBe('SPONSOR');
    expect(parseRelationship('NGO')).toBe('SPONSOR');
    expect(parseRelationship('other')).toBe('OTHER');
    // An unrecognised relationship falls back to PARENT, the commonest case,
    // because a relationship is descriptive and never financial.
    expect(parseRelationship('godparent')).toBe('PARENT');
  });

  it('reads a yes in the shapes a spreadsheet produces', () => {
    for (const yes of ['1', 'y', 'Y', 'yes', 'TRUE', 'primary'])
      expect(parseBoolean(yes)).toBe(true);
    for (const no of ['', '0', 'no', 'n', '-']) expect(parseBoolean(no)).toBe(false);
  });

  it('lowercases and validates email, treating bad input as absent', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toEqual({ ok: true, value: 'ada@example.com' });
    expect(normaliseEmail('')).toEqual({ ok: true, value: null });
    expect(normaliseEmail('not an email')).toEqual({ ok: false, value: null });
    expect(normaliseEmail('a@b')).toEqual({ ok: false, value: null });
  });

  it('splits a single guardian name cell explicitly', () => {
    expect(splitPersonName('Ada Ngozi Eze')).toEqual({ firstName: 'Ada', lastName: 'Ngozi Eze' });
    expect(splitPersonName('  Ada   Eze ')).toEqual({ firstName: 'Ada', lastName: 'Eze' });
    expect(splitPersonName('Ada')).toEqual({ firstName: 'Ada', lastName: '' });
    expect(splitPersonName('   ')).toBeNull();
  });
});

describe('planImport — the happy path', () => {
  const CSV = [
    'Admission No,Surname,First Name,Middle Name,Sex,DOB,Class,Parent Name,Parent Phone,Relationship,Primary',
    'ADM-001,Eze,Ada,Ngozi,F,2013-09-02,JSS1,Chidi Eze,0803 555 0142,Mother,yes',
    'ADM-002,Danjuma,Musa,,M,2012-04-11,SS1 A,Aisha Danjuma,+234 803 555 0200,Father,no',
  ].join('\n');

  it('plans every row with no errors and no warnings', () => {
    const p = plan(CSV);
    expect(p.summary.importable).toBe(2);
    expect(p.summary.rowsWithErrors).toBe(0);
    expect(p.summary.rowsWithWarnings).toBe(0);
    expect(p.issues).toEqual([]);
  });

  it('carries the parsed values through', () => {
    const p = plan(CSV);
    const [first, second] = p.rows;
    expect(first).toMatchObject({
      studentId: 'ADM-001',
      firstName: 'Ada',
      lastName: 'Eze',
      middleName: 'Ngozi',
      gender: 'F',
      dateOfBirth: '2013-09-02',
      className: 'JSS1',
      classId: 'c-jss1',
    });
    expect(first!.guardian).toMatchObject({
      firstName: 'Chidi',
      lastName: 'Eze',
      phone: '08035550142',
      relationship: 'PARENT',
      isPrimary: true,
    });
    expect(second!.className).toBe('SS1 A');
    expect(second!.guardian!.phone).toBe('+2348035550200');
    expect(second!.guardian!.isPrimary).toBe(false);
  });

  it('DECISION-12: dates enrolments to the term start and says it did', () => {
    const p = plan(CSV);
    expect(p.rows[0]!.enrolledOn).toBe('2026-09-08');
    expect(p.summary.notes.some((n) => n.includes('First Term') && n.includes('2026-09-08'))).toBe(
      true,
    );
  });

  it('lets an explicit admission date win over the term start', () => {
    const p = plan(
      ['Adm No,First Name,Last Name,Class,Admission Date', 'A1,Ada,Eze,JSS1,2026-09-15'].join('\n'),
    );
    expect(p.rows[0]!.enrolledOn).toBe('2026-09-15');
  });

  it('counts what it will create', () => {
    const p = plan(CSV);
    expect(p.summary.guardiansToCreate).toBe(2);
    expect(p.summary.enrollmentsToCreate).toBe(2);
    expect(p.summary.blankRows).toBe(0);
    expect(p.summary.studentsWithoutClass).toBe(0);
  });

  it('matches class names case-insensitively and ignoring spacing — DECISION-11', () => {
    const p = plan(['Adm No,First Name,Last Name,Class', 'A1,Ada,Eze,ss1a'].join('\n'));
    // "ss1a" does not match "SS1 A" (no space), so this is a real refusal.
    expect(p.summary.importable).toBe(0);
    expect(p.issues[0]!.code).toBe('UNKNOWN_CLASS');

    const p2 = plan(['Adm No,First Name,Last Name,Class', 'A1,Ada,Eze,ss1 a'].join('\n'));
    expect(p2.summary.importable).toBe(1);
    expect(p2.rows[0]!.className).toBe('SS1 A');
  });
});

describe('planImport — refusals', () => {
  it('DECISION-3: fails a row missing its admission number', () => {
    const p = plan(['Adm No,First Name,Last Name', ',Ada,Eze'].join('\n'));
    expect(p.summary.importable).toBe(0);
    expect(p.issues[0]).toMatchObject({
      line: 2,
      code: 'MISSING_ADMISSION_NUMBER',
      severity: 'ERROR',
    });
  });

  it('DECISION-3: fails a row missing a first or last name', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,,Eze', 'A2,Musa,'].join('\n'));
    const codes = p.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_FIRST_NAME');
    expect(codes).toContain('MISSING_LAST_NAME');
    expect(p.summary.importable).toBe(0);
  });

  it('reports the exact line of each bad row', () => {
    const p = plan(
      ['Adm No,First Name,Last Name', 'A1,Ada,Eze', 'A2,,Danjuma', 'A3,Musa,Bello'].join('\n'),
    );
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]!.line).toBe(3);
    expect(p.summary.importable).toBe(2);
  });

  it('DECISION-8: refuses an admission number that already exists, and names the holder', () => {
    const p = plan(['Adm No,First Name,Last Name', 'ADM-001,Ada,Eze'].join('\n'), {
      existingStudents: new Map([['ADM-001', { name: 'Ada Eze', status: 'ACTIVE' }]]),
    });
    expect(p.summary.importable).toBe(0);
    const issue = p.issues.find((i) => i.code === 'DUPLICATE_ADMISSION_NUMBER')!;
    expect(issue.message).toContain('Ada Eze');
    expect(issue.message).toContain('active');
  });

  it('matches the existing admission number regardless of case', () => {
    const p = plan(['Adm No,First Name,Last Name', 'adm-001,Ada,Eze'].join('\n'), {
      existingStudents: new Map([['ADM-001', { name: 'Ada Eze', status: 'ACTIVE' }]]),
    });
    expect(p.summary.importable).toBe(0);
  });

  it('DECISION-9: refuses an admission number repeated inside the file, naming the earlier line', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze', 'A1,Musa,Bello'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'REPEATED_IN_FILE')!;
    expect(issue.line).toBe(3);
    expect(issue.message).toContain('line 2');
    expect(p.summary.importable).toBe(1);
  });

  it('DECISION-9: the same child twice with a different guardian is sent to the student page', () => {
    const p = plan(
      [
        'Adm No,First Name,Last Name,DOB,Parent Name,Parent Phone,Relationship',
        'A1,Ada,Eze,2013-09-02,Chidi Eze,08035550142,Father',
        'A1,Ada,Eze,2013-09-02,Adaeze Eze,08035550143,Mother',
      ].join('\n'),
    );
    const issue = p.issues.find((i) => i.code === 'REPEATED_IN_FILE')!;
    expect(issue.line).toBe(3);
    expect(issue.message).toContain('the same child, with a different guardian');
    expect(issue.message).toContain("student's page");
    // Still blocked. One row is still one guardian, and nothing is merged behind
    // the school's back — but the remedy must not read like "delete a guardian".
    expect(p.summary.importable).toBe(1);
    expect(p.rows[0]?.guardian?.firstName).toBe('Chidi');
  });

  it('DECISION-9: two different children on one admission number keep the blunt remedy', () => {
    const p = plan(
      ['Adm No,First Name,Last Name,DOB', 'A1,Ada,Eze,2013-09-02', 'A1,Musa,Bello,2012-04-11'].join(
        '\n',
      ),
    );
    const issue = p.issues.find((i) => i.code === 'REPEATED_IN_FILE')!;
    expect(issue.message).toBe(
      'Admission number A1 also appears on line 2. Remove one of the two rows.',
    );
  });

  it('DECISION-11: refuses an unknown class and lists the ones that exist', () => {
    const p = plan(['Adm No,First Name,Last Name,Class', 'A1,Ada,Eze,Primary 9'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'UNKNOWN_CLASS')!;
    expect(issue.message).toContain('Primary 9');
    expect(issue.message).toContain('JSS1');
  });

  it('says so plainly when the file names a class but no classes exist yet', () => {
    const p = plan(['Adm No,First Name,Last Name,Class', 'A1,Ada,Eze,JSS1'].join('\n'), {
      classes: [],
    });
    expect(p.issues[0]!.code).toBe('NO_CLASSES_DEFINED');
  });

  it('DECISION-7: refuses a guardian contact with no guardian name', () => {
    const p = plan(
      ['Adm No,First Name,Last Name,Guardian Phone', 'A1,Ada,Eze,08035550142'].join('\n'),
    );
    const issue = p.issues.find((i) => i.code === 'GUARDIAN_CONTACT_WITHOUT_NAME')!;
    expect(issue).toBeTruthy();
    expect(p.summary.importable).toBe(0);
  });

  it('refuses a one-word guardian name rather than inventing a surname', () => {
    const p = plan(['Adm No,First Name,Last Name,Parent Name', 'A1,Ada,Eze,Mama'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'INCOMPLETE_GUARDIAN_NAME')!;
    expect(issue.message).toContain('surname');
  });

  it('refuses a malformed gender', () => {
    const p = plan(['Adm No,First Name,Last Name,Sex', 'A1,Ada,Eze,maybe'].join('\n'));
    expect(p.issues.find((i) => i.code === 'UNRECOGNISED_GENDER')).toBeTruthy();
  });

  it('refuses an unreadable date and says what to write instead', () => {
    const p = plan(['Adm No,First Name,Last Name,DOB', 'A1,Ada,Eze,next tuesday'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'UNREADABLE_DATE')!;
    expect(issue.message).toContain('YYYY-MM-DD');
  });

  it('refuses a future date of birth', () => {
    // A realistic future date. An absurd year (2999) is refused earlier and more
    // precisely as an unreadable year — that path is covered below.
    const nextYear = new Date().getFullYear() + 1;
    const p = plan(['Adm No,First Name,Last Name,DOB', `A1,Ada,Eze,${nextYear}-01-15`].join('\n'));
    expect(p.issues.find((i) => i.code === 'DATE_IN_FUTURE')).toBeTruthy();
  });

  it('refuses an impossible year as unreadable rather than as a future date', () => {
    const p = plan(['Adm No,First Name,Last Name,DOB', 'A1,Ada,Eze,2999-01-01'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'UNREADABLE_DATE')!;
    expect(issue).toBeTruthy();
    expect(issue.message).toContain('2999-01-01');
  });

  it('refuses a ragged row rather than shifting its columns', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,Ada'].join('\n'));
    expect(p.issues.find((i) => i.code === 'RAGGED_ROW')).toBeTruthy();
    expect(p.summary.importable).toBe(0);
  });

  it('refuses an enrolment into a term that is not active', () => {
    const p = plan(['Adm No,First Name,Last Name,Class', 'A1,Ada,Eze,JSS1'].join('\n'), {
      term: { id: 't', name: 'First Term', startsOn: '2026-09-08', status: 'PLANNED' },
    });
    const issue = p.issues.find((i) => i.code === 'TERM_NOT_ACTIVE')!;
    expect(issue.message).toContain('First Term');
  });

  it('refuses an enrolment into a closed term', () => {
    const p = plan(['Adm No,First Name,Last Name,Class', 'A1,Ada,Eze,JSS1'].join('\n'), {
      term: { id: 't', name: 'First Term', startsOn: '2026-09-08', status: 'CLOSED' },
    });
    expect(p.issues.find((i) => i.code === 'TERM_CLOSED')).toBeTruthy();
  });

  it('refuses the whole file when required columns are missing', () => {
    const p = plan(['Surname,First Name', 'Eze,Ada'].join('\n'));
    const codes = p.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_COLUMN');
    expect(p.summary.importable).toBe(0);
  });

  it('refuses the file, not the rows, when two columns claim one field', () => {
    const p = plan(
      ['Adm No,First Name,Last Name,Phone,Guardian Phone', 'A1,Ada,Eze,,0803'].join('\n'),
    );
    expect(p.issues.find((i) => i.code === 'AMBIGUOUS_COLUMN')).toBeTruthy();
  });

  it('refuses a file above the row cap, and says how many rows it found', () => {
    const lines = ['Adm No,First Name,Last Name'];
    for (let i = 0; i < 1001; i += 1) lines.push(`A${i},First${i},Last${i}`);
    const p = plan(lines.join('\n'));
    const issue = p.issues.find((i) => i.code === 'TOO_MANY_ROWS')!;
    expect(issue).toBeTruthy();
    expect(issue.message).toContain('1001');
  });
});

describe('planImport — warnings that do not block', () => {
  it('warns about a genuinely ambiguous date and states the reading', () => {
    const p = plan(['Adm No,First Name,Last Name,DOB', 'A1,Ada,Eze,03/04/2020'].join('\n'));
    expect(p.summary.importable).toBe(1);
    const issue = p.issues.find((i) => i.code === 'AMBIGUOUS_DATE')!;
    expect(issue.severity).toBe('WARNING');
    expect(issue.message).toContain('3 April 2020');
    expect(issue.message).toContain('day first');
  });

  it('DECISION-6: warns that a bad phone number was NOT imported', () => {
    const p = plan(
      [
        'Adm No,First Name,Last Name,Parent Name,Parent Phone',
        'A1,Ada,Eze,Chidi Eze,call mama',
      ].join('\n'),
    );
    expect(p.summary.importable).toBe(1);
    const issue = p.issues.find((i) => i.code === 'PHONE_NOT_IMPORTED')!;
    expect(issue.message).toContain('call mama');
    expect(issue.message).toContain('NOT imported');
    // The guardian is still created — the number is dropped, not invented.
    expect(p.rows[0]!.guardian!.phone).toBeNull();
  });

  it('warns about a bad email without dropping the guardian', () => {
    const p = plan(
      ['Adm No,First Name,Last Name,Parent Name,Guardian Email', 'A1,Ada,Eze,Chidi Eze,nope'].join(
        '\n',
      ),
    );
    expect(p.rows[0]!.guardian!.email).toBeNull();
    expect(p.issues.find((i) => i.code === 'EMAIL_NOT_IMPORTED')!.severity).toBe('WARNING');
  });

  it('warns when a guardian has no way of being contacted', () => {
    const p = plan(['Adm No,First Name,Last Name,Parent Name', 'A1,Ada,Eze,Chidi Eze'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'GUARDIAN_WITHOUT_CONTACT')!;
    expect(issue.message).toContain('cannot be contacted about fees');
  });

  it('DECISION-10: warns about a possible duplicate with an existing student, and does NOT block', () => {
    const p = plan(['Adm No,First Name,Last Name,DOB', 'A9,Ada,Eze,2013-09-02'].join('\n'), {
      existingByNameDob: new Map([['ada|eze|2013-09-02', 'Ada Eze']]),
    });
    expect(p.summary.importable).toBe(1);
    const issue = p.issues.find((i) => i.code === 'POSSIBLE_DUPLICATE_EXISTING')!;
    expect(issue.severity).toBe('WARNING');
    expect(issue.message).toContain('Ada Eze');
  });

  it('DECISION-10: warns about a possible duplicate inside the file', () => {
    const p = plan(
      ['Adm No,First Name,Last Name,DOB', 'A1,Ada,Eze,2013-09-02', 'A2,Ada,Eze,2013-09-02'].join(
        '\n',
      ),
    );
    const issue = p.issues.find((i) => i.code === 'POSSIBLE_DUPLICATE_IN_FILE')!;
    expect(issue.message).toContain('line 2');
    // Different admission numbers, so both are imported — the school decides.
    expect(p.summary.importable).toBe(2);
  });

  it('DECISION-2: counts a blank row in the middle of the file and reports it', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze', '', 'A2,Musa,Bello'].join('\n'));
    expect(p.summary.blankRows).toBe(1);
    expect(p.summary.importable).toBe(2);
    expect(p.summary.notes.some((n) => n.includes('blank row'))).toBe(true);
  });

  it('DECISION-2: counts a delimited blank row at the end, which a person left behind', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze', ',,'].join('\n'));
    expect(p.summary.blankRows).toBe(1);
    expect(p.summary.importable).toBe(1);
  });

  it('does not count a trailing empty line, which every text editor adds', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze', '', ''].join('\n'));
    expect(p.summary.blankRows).toBe(0);
    expect(p.summary.importable).toBe(1);
  });

  it('DECISION-1: warns about columns it did not use', () => {
    const p = plan(['Adm No,First Name,Last Name,House Colour', 'A1,Ada,Eze,Blue'].join('\n'));
    const issue = p.issues.find((i) => i.code === 'UNRECOGNISED_COLUMN')!;
    expect(issue.message).toContain('House Colour');
  });

  it('notes how many students were left without a class', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze'].join('\n'));
    expect(p.summary.studentsWithoutClass).toBe(1);
    expect(p.summary.notes.some((n) => n.includes('no class column'))).toBe(true);
  });
});

describe('printers do not invent or drop anything', () => {
  it('plans a 400-row file quickly and counts every row exactly once', () => {
    const lines = ['Adm No,First Name,Last Name,Class'];
    for (let i = 0; i < 400; i += 1)
      lines.push(`BULK-${String(i).padStart(4, '0')},First${i},Last${i},JSS1`);
    const started = Date.now();
    const p = plan(lines.join('\n'));
    const elapsed = Date.now() - started;
    expect(p.summary.importable).toBe(400);
    expect(p.summary.enrollmentsToCreate).toBe(400);
    expect(p.summary.rowsWithErrors).toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });

  it('hashPlan is stable for the same plan and changes when a row changes', () => {
    const a = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze'].join('\n'));
    const b = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze'].join('\n'));
    const c = plan(['Adm No,First Name,Last Name', 'A1,Ada,Eze-Edited'].join('\n'));
    expect(a.summary.planHash).toBe(b.summary.planHash);
    expect(hashPlan(a)).toBe(a.summary.planHash);
    expect(c.summary.planHash).not.toBe(a.summary.planHash);
  });

  it('hashPlan changes when a value the school would not notice changes', () => {
    const head = 'Adm No,First Name,Last Name,Parent Name,Parent Phone';
    const a = plan([head, 'A1,Ada,Eze,Chidi Eze,08035550142'].join('\n'));
    const b = plan([head, 'A1,Ada,Eze,Chidi Eze,08035550143'].join('\n'));
    expect(a.summary.importable).toBe(1);
    expect(b.summary.importable).toBe(1);
    expect(a.summary.planHash).not.toBe(b.summary.planHash);
  });

  it('hashPlan separates two different files that both contain only errors', () => {
    // Measured weakness: with the material built from imported rows alone, two
    // entirely different broken files hashed identically because both had no
    // importable rows. Neither could be imported, but the fingerprint must still
    // distinguish them.
    const a = plan(['Adm No,First Name,Last Name', ',Ada,Eze'].join('\n'));
    const b = plan(['Adm No,First Name,Last Name', 'A1,,Eze'].join('\n'));
    expect(a.summary.importable).toBe(0);
    expect(b.summary.importable).toBe(0);
    expect(a.summary.planHash).not.toBe(b.summary.planHash);
  });

  it('formats a date the way a school reads it', () => {
    expect(humanDate('2026-09-08')).toBe('8 September 2026');
  });

  it('issuesToCsv produces a file Excel opens, with the line number first', () => {
    const p = plan(['Adm No,First Name,Last Name', 'A1,,Eze'].join('\n'));
    const csv = issuesToCsv(p.issues);
    const rows = csv.split('\r\n');
    expect(rows[0]).toBe('Line,Severity,Column,Problem,Detail');
    expect(rows[1]).toContain('2,ERROR,first name,MISSING_FIRST_NAME');
  });

  it('issuesToCsv escapes a comma inside a message', () => {
    const csv = issuesToCsv([
      { severity: 'ERROR', line: 2, code: 'X', message: 'Your classes are: JSS1, SS1, SS2.' },
    ]);
    expect(csv.split('\r\n')[1]).toContain('"Your classes are: JSS1, SS1, SS2."');
  });
});
