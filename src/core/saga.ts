// Saga runner for multi-step processes (capital calls, disbursements).
// Each step has an action and an optional compensation. Steps run in order; if one fails,
// completed steps are compensated in reverse order. Every run and step outcome is recorded
// in saga_runs, so operations can see exactly what happened. In AWS the same definitions map
// to a Step Functions state machine with Catch -> compensation states.

import type { Services, User } from './context.ts';
import { now } from './context.ts';

export interface SagaStep<C> {
  name: string;
  run: (ctx: C) => Promise<void> | void;
  compensate?: (ctx: C) => Promise<void> | void;
}

type StepLog = { name: string; status: 'DONE' | 'FAILED' | 'COMPENSATED' | 'COMPENSATION_FAILED' | 'SKIPPED'; at: string; error?: string };

export async function runSaga<C>(svc: Services, user: User, saga: string, ref: string, ctx: C, steps: SagaStep<C>[]) {
  const log: StepLog[] = [];
  const { id } = svc.db.run('INSERT INTO saga_runs (saga, ref, status, steps, started_by, started_at) VALUES (?,?,?,?,?,?)', [saga, ref, 'RUNNING', '[]', user.username, now()]);
  const save = (status: string, error?: string) =>
    svc.db.run('UPDATE saga_runs SET status = ?, steps = ?, error = ?, finished_at = ? WHERE id = ?', [status, JSON.stringify(log), error ?? null, status === 'RUNNING' ? null : now(), id]);
  const done: SagaStep<C>[] = [];
  for (const step of steps) {
    try {
      await step.run(ctx);
      log.push({ name: step.name, status: 'DONE', at: now() });
      done.push(step);
      save('RUNNING');
    } catch (err) {
      const message = (err as Error).message;
      log.push({ name: step.name, status: 'FAILED', at: now(), error: message });
      let compensationFailed = false;
      for (const prev of done.reverse()) {
        if (!prev.compensate) continue;
        try {
          await prev.compensate(ctx);
          log.push({ name: `undo: ${prev.name}`, status: 'COMPENSATED', at: now() });
        } catch (e) {
          compensationFailed = true;
          log.push({ name: `undo: ${prev.name}`, status: 'COMPENSATION_FAILED', at: now(), error: (e as Error).message });
        }
      }
      save(compensationFailed ? 'FAILED' : 'COMPENSATED', message);
      throw err;
    }
  }
  save('COMPLETED');
  return { saga_id: id, steps: log };
}

export function sagaRuns(svc: Services, ref: string) {
  return svc.db.all('SELECT * FROM saga_runs WHERE ref = ? ORDER BY id DESC', [ref]).map((r) => ({ ...r, steps: JSON.parse(r.steps) }));
}
