// Entry point: starts the Python analytics engine, then the Node API + React UI on one port.
//   PORT        (default 3000)   web/API port
//   ENGINE_PORT (default 8001)   Python engine port (local only)
//   ENGINE_URL  optional         use an already-running engine instead of launching one
//   DB_PATH     (default data/seaport.db)
//   FILES_DIR   (default data/files)          uploaded and generated documents
//   HOST        (default 127.0.0.1)           0.0.0.0 inside a container / behind a load balancer

import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp, createServices, ROOT } from './app.ts';
import { httpEngine, launchEngine } from './integrations/engine.ts';
import { startDispatcher } from './core/outbox.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const enginePort = Number(process.env.ENGINE_PORT ?? 8001);

let engineChild: { kill: () => void } | null = null;
let engine;
if (process.env.ENGINE_URL) {
  engine = httpEngine(process.env.ENGINE_URL);
} else {
  try {
    const launched = await launchEngine(enginePort);
    engine = launched.client;
    engineChild = launched.child;
  } catch (err) {
    console.error(`\n[api] ${(err as Error).message}\n`);
    process.exit(1);
  }
}

const services = createServices({
  dbPath: process.env.DB_PATH ?? join(ROOT, 'data', 'seaport.db'),
  engine,
  filesDir: process.env.FILES_DIR ?? join(ROOT, 'data', 'files'),
});

const count = services.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
if (!count) {
  console.log('[api] Empty database - loading demo data (run "npm run reset" to reload it later)');
  const { seed } = await import('./seed.ts');
  seed(services);
}
const { seedModules } = await import('./seed-modules.ts');
await seedModules(services);

const stopDispatcher = startDispatcher(services.db);
// Automated delinquency tracking: open cases for loans > 30 days past due (startup, then hourly).
const { sweep } = await import('./modules/service.ts');
const { snapshotMonthEnds } = await import('./modules/dashboard.ts');
const runSweep = () => { try { snapshotMonthEnds(services); } catch (e: any) { console.error('[month-end] snapshot failed:', e.message); } return sweep(services).then((r) => r.opened && console.log(`[servicing] ${r.opened} delinquency case(s) opened`)).catch((e) => console.error('[servicing] sweep failed:', e.message)); };
await runSweep();
setInterval(runSweep, 3600e3).unref();
const server = createServer(createApp(services));
server.listen(port, host, () => {
  console.log(`\n  Seaport Global - Working Capital platform`);
  console.log(`  Open http://localhost:${port}   (business date ${services.today()})\n`);
});

function shutdown() {
  stopDispatcher();
  server.close();
  engineChild?.kill();
  services.db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
