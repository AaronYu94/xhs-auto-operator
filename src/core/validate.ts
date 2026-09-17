import { ValidationError } from './errors.ts';

/**
 * Minimal runtime validation with static type inference (zero dependencies).
 * Used for skill inputs/outputs, API request bodies and fixture imports.
 */
export type Validator<T> = (value: unknown, path?: string) => T;
export type Infer<V> = V extends Validator<infer T> ? T : never;

type OptionalKeys<S> = {
  [K in keyof S]: S[K] extends Validator<infer T> ? (undefined extends T ? K : never) : never;
}[keyof S];
type RequiredKeys<S> = Exclude<keyof S, OptionalKeys<S>>;
export type ObjectOf<S extends Record<string, Validator<unknown>>> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp } = {}): Validator<string> {
    return (value, path = '') => {
      if (typeof value !== 'string') throw new ValidationError(path, `expected string, got ${describe(value)}`);
      if (opts.min !== undefined && value.length < opts.min)
        throw new ValidationError(path, `must be at least ${opts.min} chars`);
      if (opts.max !== undefined && value.length > opts.max)
        throw new ValidationError(path, `must be at most ${opts.max} chars`);
      if (opts.pattern && !opts.pattern.test(value)) throw new ValidationError(path, `does not match ${opts.pattern}`);
      return value;
    };
  },

  number(opts: { min?: number; max?: number; int?: boolean } = {}): Validator<number> {
    return (value, path = '') => {
      if (typeof value !== 'number' || Number.isNaN(value))
        throw new ValidationError(path, `expected number, got ${describe(value)}`);
      if (opts.int && !Number.isInteger(value)) throw new ValidationError(path, 'expected integer');
      if (opts.min !== undefined && value < opts.min) throw new ValidationError(path, `must be >= ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) throw new ValidationError(path, `must be <= ${opts.max}`);
      return value;
    };
  },

  boolean(): Validator<boolean> {
    return (value, path = '') => {
      if (typeof value !== 'boolean') throw new ValidationError(path, `expected boolean, got ${describe(value)}`);
      return value;
    };
  },

  literal<const T extends readonly (string | number)[]>(values: T): Validator<T[number]> {
    return (value, path = '') => {
      if (!values.includes(value as T[number]))
        throw new ValidationError(path, `expected one of ${values.join('|')}, got ${JSON.stringify(value)}`);
      return value as T[number];
    };
  },

  array<T>(item: Validator<T>, opts: { min?: number; max?: number } = {}): Validator<T[]> {
    return (value, path = '') => {
      if (!Array.isArray(value)) throw new ValidationError(path, `expected array, got ${describe(value)}`);
      if (opts.min !== undefined && value.length < opts.min)
        throw new ValidationError(path, `must contain at least ${opts.min} items`);
      if (opts.max !== undefined && value.length > opts.max)
        throw new ValidationError(path, `must contain at most ${opts.max} items`);
      return value.map((x, i) => item(x, `${path}[${i}]`));
    };
  },

  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<ObjectOf<S>> {
    return (value, path = '') => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ValidationError(path, `expected object, got ${describe(value)}`);
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const parsed = shape[key](src[key], path ? `${path}.${key}` : key);
        if (parsed !== undefined) out[key] = parsed;
      }
      return out as ObjectOf<S>;
    };
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path = '') => (value === undefined ? undefined : inner(value, path));
  },

  nullable<T>(inner: Validator<T>): Validator<T | null> {
    return (value, path = '') => (value === null ? null : inner(value, path));
  },

  record<T>(inner: Validator<T>): Validator<Record<string, T>> {
    return (value, path = '') => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ValidationError(path, `expected object, got ${describe(value)}`);
      const out: Record<string, T> = {};
      for (const [k, x] of Object.entries(value)) out[k] = inner(x, `${path}.${k}`);
      return out;
    };
  },

  unknown(): Validator<unknown> {
    return (value) => value;
  },

  /** Default when undefined. */
  withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
    return (value, path = '') => (value === undefined ? fallback : inner(value, path));
  },
};
