import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsBoolean, ValidateIf } from 'class-validator';
import { IsInt, IsString } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber, ToStrictString } from './strict-boolean';

// Mirrors the real pipe: whitelist + forbidNonWhitelisted from src/main.ts, and the
// enableImplicitConversion transform option from src/config/app-validation.ts. Leaving the
// transform option out here is what previously made a DTO spec pass while production accepted
// the opposite value.
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };
const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };

class Subject {
  @ToStrictBoolean()
  @ValidateIf((o: Subject) => o.flag !== undefined)
  @IsBoolean()
  flag?: boolean;
}

class Unguarded {
  @ValidateIf((o: Unguarded) => o.flag !== undefined)
  @IsBoolean()
  flag?: boolean;
}

async function run<T extends object>(cls: new () => T, payload: unknown) {
  const instance = plainToInstance(cls, payload as object, PIPE_TRANSFORM_OPTS);
  const errors = await validate(instance, PIPE_VALIDATOR_OPTS);
  return { instance, errors };
}

describe('ToStrictBoolean', () => {
  it('preserves real booleans', async () => {
    for (const value of [true, false]) {
      const { instance, errors } = await run(Subject, { flag: value });
      expect(instance.flag).toBe(value);
      expect(errors).toHaveLength(0);
    }
  });

  it('maps the canonical string spellings a form-encoded body produces', async () => {
    const asFalse = await run(Subject, { flag: 'false' });
    expect(asFalse.instance.flag).toBe(false);
    expect(asFalse.errors).toHaveLength(0);

    const asTrue = await run(Subject, { flag: 'true' });
    expect(asTrue.instance.flag).toBe(true);
    expect(asTrue.errors).toHaveLength(0);
  });

  it('rejects ambiguous spellings instead of guessing', async () => {
    for (const value of ['yes', 'no', '0', '1', 'FALSE', '']) {
      const { errors } = await run(Subject, { flag: value });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('leaves an absent property absent', async () => {
    const { instance, errors } = await run(Subject, {});
    expect(instance.flag).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  // Characterizes the behaviour the decorator exists to prevent. If this ever stops failing,
  // enableImplicitConversion was turned off and the decorator can be reconsidered.
  it('documents the unguarded behaviour it replaces: every non-empty string becomes true', async () => {
    for (const value of ['false', 'no', '0']) {
      const { instance, errors } = await run(Unguarded, { flag: value });
      expect(instance.flag).toBe(true);
      expect(errors).toHaveLength(0);
    }
  });
});

class NumberSubject {
  @ToStrictNumber()
  @ValidateIf((o: NumberSubject) => o.count !== undefined)
  @IsInt()
  count?: number;
}

class UnguardedNumber {
  @ValidateIf((o: UnguardedNumber) => o.count !== undefined)
  @IsInt()
  count?: number;
}

describe('ToStrictNumber', () => {
  it('preserves real numbers and converts fully-numeric strings', async () => {
    for (const [input, expected] of [
      [7, 7],
      [0, 0],
      ['86400', 86400],
      ['0', 0],
    ] as const) {
      const { instance, errors } = await run(NumberSubject, { count: input });
      expect(instance.count).toBe(expected);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects blank and non-numeric strings instead of reading them as 0', async () => {
    for (const value of ['', '   ', 'abc', '1abc']) {
      const { errors } = await run(NumberSubject, { count: value });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('leaves an absent property absent', async () => {
    const { instance, errors } = await run(NumberSubject, {});
    expect(instance.count).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  // The behaviour the decorator exists to prevent: a blank form field arriving as a valid zero.
  it('documents the unguarded behaviour it replaces: a blank string becomes 0', async () => {
    const { instance, errors } = await run(UnguardedNumber, { count: '' });
    expect(instance.count).toBe(0);
    expect(errors).toHaveLength(0);
  });
});

class StringSubject {
  @ToStrictString()
  @ValidateIf((o: StringSubject) => o.text !== undefined)
  @IsString()
  text?: string;
}

class UnguardedString {
  @ValidateIf((o: UnguardedString) => o.text !== undefined)
  @IsString()
  text?: string;
}

describe('ToStrictString', () => {
  it('keeps a string exactly as sent', async () => {
    for (const value of ['hello', '', '  padded  ', '628123456789', 'true']) {
      const { instance, errors } = await run(StringSubject, { text: value });
      expect(instance.text).toBe(value);
      expect(errors).toHaveLength(0);
    }
  });

  // A number keeps the conversion every release has had: no-code clients post a phone number held as a number.
  it.each([
    [628123456789, '628123456789'],
    [0, '0'],
    [-5, '-5'],
    [1.5, '1.5'],
    [1e21, '1e+21'],
  ])('reads the number %j as the string %j, as the pipe always did', async (value, expected) => {
    const { instance, errors } = await run(StringSubject, { text: value });
    expect(instance.text).toBe(expected);
    expect(errors).toHaveLength(0);
  });

  it('converts a number exactly as the unguarded pipe does', async () => {
    for (const value of [628123456789, 0, -0, -5, 1.5, 1e21, Number.MAX_SAFE_INTEGER]) {
      const guarded = await run(StringSubject, { text: value });
      const unguarded = await run(UnguardedString, { text: value });
      expect(guarded.instance.text).toBe(unguarded.instance.text);
    }
  });

  it.each([[true], [false], [{ order: 42 }], [['a']]])('rejects %j instead of reading it as text', async value => {
    const { instance, errors } = await run(StringSubject, { text: value });
    expect(instance.text).toEqual(value);
    expect(errors.map(e => e.property)).toEqual(['text']);
  });

  it('leaves an absent property absent and a null one null', async () => {
    const absent = await run(StringSubject, {});
    expect(absent.instance.text).toBeUndefined();
    expect(absent.errors).toHaveLength(0);

    const nulled = await run(StringSubject, { text: null });
    expect(nulled.instance.text).toBeNull();
  });

  // The behaviour the decorator exists to prevent: the customer receiving the literal "[object Object]".
  it('documents the unguarded behaviour it replaces: a boolean or object becomes a string', async () => {
    for (const [value, expected] of [
      [true, 'true'],
      [{ order: 42 }, '[object Object]'],
    ] as const) {
      const { instance, errors } = await run(UnguardedString, { text: value });
      expect(instance.text).toBe(expected);
      expect(errors).toHaveLength(0);
    }
  });
});
