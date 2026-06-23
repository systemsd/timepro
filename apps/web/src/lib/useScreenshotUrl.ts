'use client';

import { useEffect, useState } from 'react';
import { getScreenshotObjectUrl } from './api';
import { createLimiter } from './concurrency';

/**
 * Shared across every thumbnail on the page: never more than this many screenshot
 * blob fetches in flight at once, so they can't saturate the single API process
 * and starve roster/members behind them (the dashboard "no one worked today" bug).
 */
const screenshotLimiter = createLimiter(4);

/**
 * Lazily load an authenticated screenshot as an object URL for a thumbnail.
 *
 * - Defers the fetch until the element scrolls near the viewport (IntersectionObserver),
 *   so a Timeline day's off-screen thumbnails don't all fetch at mount.
 * - Throttles concurrent fetches via a shared limiter.
 * - Revokes the blob URL on unmount / id change.
 *
 * Attach the returned `ref` to the element whose visibility should trigger the load.
 * (One-off, user-initiated loads — e.g. the lightbox — should call
 * `getScreenshotObjectUrl` directly instead, so they aren't deferred or throttled.)
 */
export function useScreenshotUrl(id: string): {
  url: string | null;
  ref: (el: HTMLElement | null) => void;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [node, setNode] = useState<HTMLElement | null>(null);

  // Mark visible once the thumbnail scrolls near the viewport.
  useEffect(() => {
    if (visible || !node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [node, visible]);

  // Once visible, fetch through the shared limiter and manage the blob lifecycle.
  useEffect(() => {
    if (!visible) return;
    let blobUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    void screenshotLimiter(() => getScreenshotObjectUrl(id))
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        blobUrl = u;
        setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [id, visible]);

  return { url, ref: setNode };
}
