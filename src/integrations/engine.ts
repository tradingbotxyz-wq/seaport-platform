// Client for the Python analytics engine (engine/server.py), plus a process launcher.

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError, unavailable } from '../lib/errors.ts';

export interface EngineClient {
  parse(filename: string, contentBase64: string, kind: 'invoice' | 'settlement' | 'bank'): Promise<any>;
  price(fundingDate: string, dayCount: string, fixings: Record<string, number>, invoices: unknown[]): Promise<any>;
  lateCharges(asOf: string, dayCount: string, marginBps: number, items: unknown[]): Promise<any>;
  underwrite(body: Record<string, unknown>): Promise<any>;
  defaultModel(): Promise<any>;
  pdf(spec: Record<string, unknown>): Promise<{ content_base64: string; size_bytes: number; sha256: string }>;
  call(path: string, body: Record<string, unknown>): Promise<any>;
  health(): Promise<boolean>;
}

export function httpEngine(baseUrl: string, timeoutMs = 30_000): EngineClient {
  async function post(path: string, body: unknown) {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable('Analytics engine (Python) is not reachable. Is it running?');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 422) throw new HttpError(422, 'engine_validation_error', data.message ?? 'Engine rejected the input');
    if (!res.ok) throw unavailable(`Analytics engine error: ${data.message ?? res.status}`);
    return data;
  }
  return {
    parse: (filename, content_base64, kind) => post('/parse', { filename, content_base64, kind }),
    price: (funding_date, day_count, fixings, invoices) => post('/price', { funding_date, day_count, fixings, invoices }),
    lateCharges: (as_of, day_count, margin_bps, items) => post('/late-charges', { as_of, day_count, margin_bps, items }),
    underwrite: (body) => post('/underwrite', body),
    defaultModel: () => post('/underwrite/model', {}),
    pdf: (spec) => post('/pdf', spec),
    call: (path, body) => post(path, body),
    async health() {
      try {
        const r = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(1000) });
        return r.ok;
      } catch {
        return false;
      }
    },
  };
}

function pythonCandidates(): string[][] {
  if (process.env.PYTHON) return [[process.env.PYTHON]];
  return process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
}

/** Start engine/server.py as a child process and wait until /health answers. */
export async function launchEngine(port: number): Promise<{ client: EngineClient; child: ChildProcess | null }> {
  const script = fileURLToPath(new URL('../../engine/server.py', import.meta.url));
  const client = httpEngine(`http://127.0.0.1:${port}`);
  if (await client.health()) {
    // An engine from an earlier run is still listening (e.g. the API crashed) - reuse it.
    console.log(`[engine] reusing the analytics engine already running on port ${port}`);
    return { client, child: null };
  }
  let lastError = '';
  for (const [cmd, ...args] of pythonCandidates()) {
    const child = spawn(cmd, [...args, script], {
      env: { ...process.env, ENGINE_PORT: String(port), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const failed = await new Promise<string | null>((resolve) => {
      child.once('error', (e) => resolve(e.message));
      child.once('exit', (code) => resolve(`exited with code ${code}`));
      (async () => {
        for (let i = 0; i < 50; i++) {
          if (await client.health()) return resolve(null);
          await new Promise((r) => setTimeout(r, 200));
        }
        resolve('did not become healthy within 10s');
      })();
    });
    if (failed === null) return { client, child };
    child.kill();
    lastError = `${cmd}: ${failed}`;
  }
  throw new Error(`Could not start the Python engine (${lastError}). Install Python 3.10+ or set PYTHON=<path to python>.`);
}
