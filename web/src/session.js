import { createContext, useContext } from 'react';

/** { me, today, engine, can(permission), openLoan(id), refreshBadges() } */
export const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);
