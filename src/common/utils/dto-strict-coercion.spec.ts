import 'reflect-metadata';
import { getMetadataStorage, validate, ValidationTypes } from 'class-validator';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Drift gate for the input-coercion contract.
 *
 * The global ValidationPipe runs with `transformOptions.enableImplicitConversion: true`
 * (`src/config/app-validation.ts`). That is deliberate — it lets a client send `"5"` for a numeric
 * field, which form-encoded bodies and several HTTP clients do by default. But it also means
 * class-transformer rewrites the value BEFORE any `@Is*` validator sees it, and three of its
 * conversions destroy information rather than preserving it:
 *
 *   Boolean  — every non-empty string becomes `true`, so `"false"`, `"no"` and `"0"` all arrive as
 *              `true` and `@IsBoolean()` can never reject them.
 *   Number   — `Number('')` and `Number('   ')` are `0`, so a blank field arrives as a real zero
 *              and `@IsInt()`/`@IsNumber()` accept it.
 *   String   - a number, boolean or object becomes its string form (`5`, `true`, `[object Object]`), so
 *              `@IsString()` accepts it and the route sends text the caller never wrote.
 *
 * The first two fail toward the more permissive value, which is how a `forEveryone=false` delete became
 * a delete-for-everyone. `ToStrictBoolean`/`ToStrictNumber`/`ToStrictString` (`./strict-boolean`)
 * restore the rejection while keeping the useful half of the conversion.
 *
 * This spec asserts the BEHAVIOUR rather than the presence of a decorator, so any future mechanism
 * that produces the same guarantee also satisfies it. Every boolean and numeric property that
 * carries validation metadata is covered — including classes that are never exported, because
 * discovery walks class-validator's own registry rather than module exports. So is every string one.
 */

const PIPE_TRANSFORM_OPTS = { enableImplicitConversion: true };
const PIPE_VALIDATOR_OPTS = { whitelist: true, forbidNonWhitelisted: true };

/** The values each type is probed with, and why each must be refused. */
const PROBES: Record<string, { values: unknown[]; reason: string }> = {
  Boolean: { values: ['yes'], reason: 'implicit conversion turns any non-empty string into true' },
  Number: { values: [''], reason: 'Number("") is 0, so a blank field becomes a real zero' },
  // Three probes, because their string forms differ: "628123456789" and "true" pass a digit pattern or a
  // name rule that "[object Object]" fails, so one probe alone would let such a field skip the decorator.
  String: {
    values: [628123456789, true, { order: 42 }],
    reason: 'implicit conversion rewrites a number, boolean or object into its string form, which @IsString accepts',
  },
};

function dtoFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) dtoFiles(path, out);
    else if (path.endsWith('.dto.ts') && !path.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

// Importing every DTO module registers its decorators. Classes only reach the registry once their
// module has been loaded, so this has to happen before the registry is read.
const SRC = join(__dirname, '..', '..');
dtoFiles(SRC).forEach(file => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(file);
});

// class-transformer's own constructor type, not a hand-rolled copy: `plainToInstance` is what these
// are handed to, so its contract is the one that has to hold.
type ValidatedClass = ClassConstructor<object> & { name: string; prototype: object };

function registeredClasses(): ValidatedClass[] {
  const storage = getMetadataStorage() as unknown as { validationMetadatas?: Map<unknown, unknown> };
  const registry = storage.validationMetadatas;
  if (!(registry instanceof Map)) {
    // The internal shape changed. Fail loudly — a silently empty scan would report "no drift".
    throw new Error('class-validator metadata registry is not the expected Map; update this spec');
  }
  return [...registry.keys()].filter((k): k is ValidatedClass => typeof k === 'function');
}

function coercibleProps(cls: ValidatedClass): Array<{ prop: string; type: string }> {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, cls.name, true, false);
  const props = [...new Set(metas.map(m => m.propertyName))];
  return props
    .map(prop => {
      const declared = Reflect.getMetadata('design:type', cls.prototype, prop) as { name?: string } | undefined;
      return { prop, type: declared?.name ?? '' };
    })
    .filter(({ type }) => type in PROBES);
}

describe('DTO input-coercion drift gate', () => {
  const classes = registeredClasses();
  const targets = classes.flatMap(cls => coercibleProps(cls).map(p => ({ cls, ...p })));

  // Guard the DISCOVERY, not just the assertions. A scan that silently finds nothing would report a
  // clean result forever; these pin the mechanism against a known-positive of each kind.
  it('discovers the DTO registry, including classes that are never exported', () => {
    const names = classes.map(c => c.name);
    expect(names).toContain('DeleteMessageDto'); // exported, top-level
    expect(names).toContain('BulkMessageOptionsDto'); // NOT exported — reached only via the registry
    expect(names.length).toBeGreaterThanOrEqual(40);
  });

  it('finds a boolean, a numeric and a string property to check', () => {
    expect(targets.some(t => t.type === 'Boolean')).toBe(true);
    expect(targets.some(t => t.type === 'Number')).toBe(true);
    expect(targets.some(t => t.type === 'String')).toBe(true);
    expect(targets.length).toBeGreaterThanOrEqual(15);
    // Most request fields are text, so a scan that came up with none of them would report a clean result.
    expect(targets.filter(t => t.type === 'String').length).toBeGreaterThanOrEqual(100);
  });

  it.each(targets.flatMap(t => PROBES[t.type].values.map(value => [`${t.cls.name}.${t.prop}`, value, t] as const)))(
    '%s refuses %j, which the pipe would otherwise coerce',
    async (_label, value, target) => {
      const { reason } = PROBES[target.type];
      const instance = plainToInstance(target.cls, { [target.prop]: value }, PIPE_TRANSFORM_OPTS);
      const errors = await validate(instance, PIPE_VALIDATOR_OPTS);

      // Only this property's verdict matters — other properties may be absent and report their own
      // errors, which is irrelevant here.
      const refused = errors.some(e => e.property === target.prop);
      expect(
        refused ||
          `${target.cls.name}.${target.prop} accepted ${JSON.stringify(value)} — ${reason}. ` +
            `Add @ToStrict${target.type}() from common/utils/strict-boolean.`,
      ).toBe(true);
    },
  );
});

/**
 * The same class of drift for a single nested object. It is declared with `@ValidateNested() @Type()`,
 * and `@ValidateNested` checks an array element by element, so without `@IsObject()` an array (even an
 * empty one) passed and the handler read the object's fields off it: bulk `options` sent as `[{...}]`
 * was stored as the defaults with the caller's values dropped.
 */
function nestedObjectProps(cls: ValidatedClass): string[] {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, cls.name, true, false);
  const nested = metas.filter(m => m.type === ValidationTypes.NESTED_VALIDATION && !m.each);
  return [...new Set(nested.map(m => m.propertyName))];
}

describe('DTO nested-object drift gate', () => {
  const targets = registeredClasses().flatMap(cls => nestedObjectProps(cls).map(prop => ({ cls, prop })));

  it('finds the nested object properties to check', () => {
    expect(targets.length).toBeGreaterThanOrEqual(15);
  });

  it.each(targets.map(t => [`${t.cls.name}.${t.prop}`, t] as const))('%s refuses an array', async (_label, target) => {
    const instance = plainToInstance(target.cls, { [target.prop]: [] }, PIPE_TRANSFORM_OPTS);
    const errors = await validate(instance, PIPE_VALIDATOR_OPTS);

    const refused = errors.some(e => e.property === target.prop);
    expect(refused || `${target.cls.name}.${target.prop} accepted an array. Add @IsObject().`).toBe(true);
  });
});
