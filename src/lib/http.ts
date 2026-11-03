// Minimal HTTP framework on node:http: routing, JSON bodies, auth, idempotency keys,
// consistent error envelopes, security headers and static file serving.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { HttpError, badRequest, conflict, unauthorized } from './errors.ts';
import type { Services, User } from '../core/context.ts';
import { now } from '../core/context.ts';

export interface Ctx {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: User;
  services: Services;
}

export type Result =
  | { status?: number; json: unknown }
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
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const MAX_BODY = 15 * 1024 * 1024;
const INVESTOR_PATHS = [/^\/api\/portal(\/|$)/, /^\/api\/me$/, /^\/api\/health$/, /^\/api\/documents\/\d+\/file$/, /^\/api\/notifications$/]; // documents are uploaded as base64 JSON

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function sendResult(res: ServerResponse, result: Result | unknown) {
  if (result && typeof result === 'object' && 'text' in (result as any)) {
    const r = result as { status?: number; text: string; contentType: string; filename?: string };
    const extra: Record<string, string> = r.filename ? { 'Content-Disposition': `attachment; filename="${r.filename}"` } : {};
    return send(res, r.status ?? 200, r.text, r.contentType, extra);
  }
  const r = result && typeof result === 'object' && 'json' in (result as any) ? (result as { status?: number; json: unknown }) : { json: result };
  send(res, r.status ?? 200, JSON.stringify(r.json ?? null), 'application/json; charset=utf-8');
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
      const username = req.headers['x-user'];
      if (typeof username === 'string' && username) {
        user = db.get<User>('SELECT username, name, role FROM users WHERE username = ? AND active = 1', [username]);
      }
      if (!user && !match.route.public) throw unauthorized();
      if (user?.role === 'INVESTOR' && !match.route.public && !INVESTOR_PATHS.some((re) => re.test(url.pathname))) {
        throw new HttpError(403, 'forbidden', 'Investor users can only use the investor portal');
      }

      const body = method === 'GET' ? { raw: '', json: {} } : await readBody(req);

      // Idempotency: a retried POST with the same key returns the original response instead of
      // repeating the side effect. A concurrent duplicate gets 409 while the first is in flight.
      const key = req.headers['idempotency-key'];
      if (method === 'POST' && typeof key === 'string' && key && user) {
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

      const result = await match.route.handler({ req, params: match.params, query: url.searchParams, body: body.json, user: user!, services });
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
  if (/CHECK constraint failed|FOREIGN KEY constraint failed/.test(msg)) return badRequest('Data integrity rule violated', msg);
  return new HttpError(500, 'internal_error', 'Unexpected server error');
}
