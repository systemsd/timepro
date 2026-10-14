'use client';

import { useEffect, useState } from 'react';
import { getMyAccess, type MyAccess } from './api';
import type { WebSession } from './session';

const isManagerOrAdmin = (r: string) => r === 'owner' || r === 'admin' || r === 'manager';

/** What the stored role alone implies — used while /me/access loads, or if it fails. */
export function roleAccess(session: WebSession): MyAccess {
  const team = isManagerOrAdmin(session.role);
  return { role: session.role, can_view_others: team, can_manage_team: team };
}

// One request per signed-in user, shared by every component on the page.
let cache: { userId: string; promise: Promise<MyAccess> } | null = null;

function load(session: WebSession): Promise<MyAccess> {
  if (!cache || cache.userId !== session.user_id) {
    cache = {
      userId: session.user_id,
      promise: getMyAccess().catch(() => roleAccess(session)),
    };
  }
  return cache.promise;
}

/**
 * The signed-in user's visibility scope. Hierarchy (OpsCore reporting line) and
 * admin view grants can let an `employee` see others, so the role alone no
 * longer decides whether to show team views. `null` until resolved.
 */
export function useAccess(session: WebSession | null): MyAccess | null {
  const [access, setAccess] = useState<MyAccess | null>(null);
  useEffect(() => {
    if (!session) return;
    let live = true;
    void load(session).then((a) => {
      if (live) setAccess(a);
    });
    return () => {
      live = false;
    };
  }, [session]);
  return access;
}
