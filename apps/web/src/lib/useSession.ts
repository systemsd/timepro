'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadSession, type WebSession } from './session';

/**
 * Client-side auth gate. Reads the stored session; if missing and
 * `redirect` is true, sends the user to /login.
 */
export function useSession(redirect = true): { session: WebSession | null; checked: boolean } {
  const router = useRouter();
  const [session, setSession] = useState<WebSession | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const s = loadSession();
    setSession(s);
    setChecked(true);
    if (!s && redirect) router.replace('/login');
  }, [redirect, router]);

  return { session, checked };
}
