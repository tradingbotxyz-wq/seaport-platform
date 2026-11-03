// Minimal HTTP framework on node:http: routing, JSON bodies, auth, idempotency keys,
// consistent error envelopes, security headers and static file serving.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { HttpError, badRequest, conflict, unauthorized } from './errors.ts';
import type { Services, User } from '../core/context.ts';
import { now } from '../core/context.ts';
import { readSessionToken, resolveSession, SESSION_PATHS, ALWAYS_PATHS, type SessionCtx } from '../modules/auth.ts';

export interface Ctx {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: User;
  services: Services;
  /** Present in password mode once signed in. */
  session?: SessionCtx;
}

export type Result =
  | { status?: number; json: unknown; setCookie?: string }
  | { status?: number; text: string; contentType: string; filename?: string };

type Handler = (ctx: Ctx) => Promise<Result | unknown> | Result | unknown;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; public: boolean }

export class Router {
  routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}) {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    this.routes.push({ method, pattern, keys, handler, public: !!opts.public });
  }
  get(p: string, h: Handler, o?: { public?: boolean }) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: { public?: boolean }) { this.add('POST', p, h, o); }
  put(p: string, h: Handler, o?: { public?: boolean }) { this.add('PUT', p, h, o); }

  match(method: string, path: string) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        throw badRequest('Malformed URL');
      }
      return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const MAX_BODY = 15 * 1024 * 1024;
const INVESTOR_PATHS = [/^\/api\/auth\//, /^\/api\/portal(\/|$)/, /^\/api\/me$/, /^\/api\/health$/, /^\/api\/documents\/\d+\/file$/, /^\/api\/notifications$/]; // documents are uploaded as base64 JSON

async function readBody(req: IncomingMessage): Promise<{ raw: string; json: any }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Request body too large (15 MB max)');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return { raw, json: {} };
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    throw badRequest('Malformed JSON body');
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};
let HSTS = false;

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': contentType, 'Cache-Control': 'no-store', ...SECURITY_HEADERS,
    ...(HSTS ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}), ...extra,
  });
  res.end(body);
}

/** RFC 6266 filename: ASCII fallback plus UTF-8 form; no quotes, control characters or path separators. */
export function contentDisposition(filename: string) {
  const clean = filename.replace(/[\x00-\x1f\x7f"\\/]/g, '_').slice(0, 180) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function sendResult(res: ServerResponse, result: Result | unknown) {
  if (result && typeof result === 'object' && 'text' in (result as any)) {
    const r = result as { status?: number; text: string; contentType: string; filename?: string };
    const extra: Record<string, string> = r.filename ? { 'Content-Disposition': contentDisposition(r.filename) } : {};
    return send(res, r.status ?? 200, r.text, r.contentType, extra);
  }
  const r = result && typeof result === 'object' && 'json' in (result as any) ? (result as { status?: number; json: unknown; setCookie?: string }) : { json: result };
  send(res, r.status ?? 200, JSON.stringify(r.json ?? null), 'application/json; charset=utf-8', (r as any).setCookie ? { 'Set-Cookie': (r as any).setCookie } : {});
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

async function serveStatic(res: ServerResponse, publicDir: string, urlPath: string) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  let file = join(publicDir, rel || 'index.html');
  if (!file.startsWith(publicDir + sep) && file !== publicDir) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    if (!(await stat(file)).isFile()) file = join(publicDir, 'index.html');
  } catch {
    file = join(publicDir, 'index.html');
  }
  const data = await readFile(file);
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' });
  res.end(data);
}

export function createHandler(router: Router, services: Services, publicDir: string, log = true) {
  const { db } = services;
  HSTS = services.auth.secureCookies;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    let status = 200;
    let idemKey: { key: string; actor: string } | null = null;
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        return await serveStatic(res, publicDir, url.pathname);
      }
      const match = router.match(method, url.pathname);
      if (match === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      if (!match) throw new HttpError(404, 'not_found', `No route for ${method} ${url.pathname}`);

      let user: User | undefined;
      let session: SessionCtx | undefined;
      const mutating = method !== 'GET' && method !== 'HEAD';
      if (services.auth.mode === 'demo') {
        // Demo/test only (refused when NODE_ENV=production): the client names the user.
        const username = req.headers['x-user'];
        if (typeof username === 'string' && username) {
          user = db.get<User>('SELECT username, name, role FROM users WHERE username = ? AND active = 1', [username]);
        }
      } else {
        // CSRF defence for cookie sessions: SameSite=Strict cookies, plus a custom header that a
        // cross-site form or image cannot send, plus an Origin check when the browser sends one.
        if (mutating) {
          if (req.headers['x-requested-with'] !== 'seaport') throw new HttpError(403, 'csrf', 'Missing X-Requested-With header');
          const origin = req.headers.origin;
          if (origin) {
            let host = '';
            try { host = new URL(origin).host; } catch { /* invalid */ }
            const expected = (services.auth.trustProxy ? (req.headers['x-forwarded-host'] as string) : undefined) ?? req.headers.host;
            if (!host || host !== expected) throw new HttpError(403, 'csrf', 'Cross-origin request refused');
          }
        }
        const token = readSessionToken(services, req);
        const resolved = token ? resolveSession(services, token) : null;
        if (resolved) ({ user, session } = resolved);
      }
      if (!user && !match.route.public) throw unauthorized();
      if (session && !match.route.public && !ALWAYS_PATHS.some((re) => re.test(url.pathname)) && !SESSION_PATHS[session.state].some((re) => re.test(url.pathname))) {
        throw new HttpError(403, 'session_incomplete', session.state === 'MFA' ? 'Enter your authenticator code first'
          : session.state === 'MFA_SETUP' ? 'Set up multi-factor authentication first' : 'Change your temporary password first', { state: session.state });
      }
      if (user?.role === 'INVESTOR' && !match.route.public && !INVESTOR_PATHS.some((re) => re.test(url.pathname))) {
        throw new HttpError(403, 'forbidden', 'Investor users can only use the investor portal');
      }

      const body = method === 'GET' ? { raw: '', json: {} } : await readBody(req);

      // Idempotency: a retried POST with the same key returns the original response instead of
      // repeating the side effect. A concurrent duplicate gets 409 while the first is in flight.
      const key = req.headers['idempotency-key'];
      // Never cache responses that carry secrets (MFA keys, recovery codes, one-time passwords).
      const secretBearing = /^\/api\/(auth\/|approvals\/|access\/users\/[^/]+\/reset-)/.test(url.pathname);
      if (method === 'POST' && typeof key === 'string' && key && user && !secretBearing) {
        if (key.length > 128) throw badRequest('Idempotency-Key too long');
        const hash = createHash('sha256').update(`${method} ${url.pathname} ${body.raw}`).digest('hex');
        const existing = db.get('SELECT * FROM idempotency_keys WHERE key = ? AND actor = ?', [key, user.username]);
        if (existing) {
          if (existing.request_hash !== hash) throw new HttpError(422, 'idempotency_mismatch', 'Idempotency-Key was already used with a different request');
          if (existing.status_code === null) throw conflict('A request with this Idempotency-Key is still in progress');
          status = existing.status_code;
          res.setHeader('Idempotent-Replay', 'true');
          return send(res, status, existing.response, 'application/json; charset=utf-8');
        }
        db.run('INSERT INTO idempotency_keys (key, actor, request_hash, created_at) VALUES (?,?,?,?)', [key, user.username, hash, now()]);
        idemKey = { key, actor: user.username };
      }

      const result = await match.route.handler({ req, params: match.params, query: url.searchParams, body: body.json, user: user!, services, session });
      status = (result as any)?.status ?? 200;
      if (idemKey) {
        const json = result && typeof result === 'object' && 'json' in (result as any) ? (result as any).json : result;
        db.run('UPDATE idempotency_keys SET status_code = ?, response = ? WHERE key = ? AND actor = ?', [status, JSON.stringify(json ?? null), idemKey.key, idemKey.actor]);
        idemKey = null;
      }
      sendResult(res, result);
    } catch (err) {
      if (idemKey) db.run('DELETE FROM idempotency_keys WHERE key = ? AND actor = ?', [idemKey.key, idemKey.actor]);
      const e = err instanceof HttpError ? err : mapError(err);
      status = e.status;
      if (status >= 500) console.error(err);
      send(res, status, JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }), 'application/json; charset=utf-8');
    } finally {
      if (log && url.pathname.startsWith('/api/')) console.log(`${method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    }
  };
}

function mapError(err: unknown): HttpError {
  const msg = (err as Error)?.message ?? String(err);
  if (/UNIQUE constraint failed/.test(msg)) return conflict('A record with these details already exists');
  if (/append-only|immutable/.test(msg)) return conflict('This record is immutable; use a reversing entry instead');
  if (/CHECK constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint failed/.test(msg)) return badRequest('Data integrity rule violated');
  return new HttpError(500, 'internal_error', 'Unexpected server error');
}
