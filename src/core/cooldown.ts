// After an administrator resets someone's password or MFA, that account cannot approve or release
// anything for RESET_COOLDOWN_HOURS: a reset can never be used to manufacture a second pair of eyes.

import type { Services, User } from './context.ts';
import { forbidden } from '../lib/errors.ts';

export const RESET_COOLDOWN_HOURS = Number(process.env.RESET_COOLDOWN_HOURS ?? 24);

export function assertNotRecentlyReset(svc: Services, user: User) {
  if (user.role === 'SYSTEM' || !RESET_COOLDOWN_HOURS) return;
  const at = svc.db.get<{ t: string | null }>('SELECT credentials_reset_at t FROM users WHERE username = ?', [user.username])?.t;
  if (at && Date.now() - Date.parse(at) < RESET_COOLDOWN_HOURS * 3600_000) {
    throw forbidden(`Your sign-in details were reset by an administrator less than ${RESET_COOLDOWN_HOURS} hours ago, so you cannot approve or release anything yet`);
  }
}
