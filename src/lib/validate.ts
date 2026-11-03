// Minimal declarative validation (no dependencies). Collects every field error, then throws 422.

import { validation, badRequest } from './errors.ts';

type Rule = {
  type: 'string' | 'int' | 'enum' | 'date' | 'bool';
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  values?: readonly string[];
  pattern?: RegExp;
};

export type Schema = Record<string, Rule>;

export function check<T = Record<string, any>>(body: unknown, schema: Schema): T {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const input = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const [field, rule] of Object.entries(schema)) {
    let v = input[field];
    if (v === undefined || v === null || v === '') {
      if (rule.required) errors[field] = 'is required';
      continue;
    }
    switch (rule.type) {
      case 'string': {
        if (typeof v !== 'string') { errors[field] = 'must be a string'; break; }
        v = v.trim();
        const s = v as string;
        if (rule.required && !s) errors[field] = 'is required';
        else if (rule.maxLength && s.length > rule.maxLength) errors[field] = `must be at most ${rule.maxLength} characters`;
        else if (rule.pattern && !rule.pattern.test(s)) errors[field] = 'has an invalid format';
        break;
      }
      case 'int': {
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) { errors[field] = 'must be a whole number'; break; }
        if (rule.min !== undefined && v < rule.min) errors[field] = `must be >= ${rule.min}`;
        else if (rule.max !== undefined && v > rule.max) errors[field] = `must be <= ${rule.max}`;
        break;
      }
      case 'enum':
        if (typeof v !== 'string' || !rule.values!.includes(v)) errors[field] = `must be one of ${rule.values!.join(', ')}`;
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) errors[field] = 'must be a date (YYYY-MM-DD)';
        break;
      case 'bool':
        if (typeof v !== 'boolean') errors[field] = 'must be true or false';
        break;
    }
    if (!(field in errors)) out[field] = v;
  }
  if (Object.keys(errors).length) throw validation(errors);
  return out as T;
}

export function intParam(value: string | undefined, name = 'id'): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`Invalid ${name}`);
  return n;
}

/** Keep an uploaded file's name to a safe, printable form: no paths, control characters or shell/CSV specials. */
export function safeFilename(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const clean = base.normalize('NFKC').replace(/[^A-Za-z0-9._ ()-]/g, '_').replace(/_{2,}/g, '_').replace(/^[.\s_-]+/, '').slice(0, 120);
  return clean || 'upload';
}

/** Spreadsheet formula injection: text starting with = + - @ or a control character is prefixed with an apostrophe. */
export function safeCell(v: unknown): unknown {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
