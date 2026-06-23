/**
 * A tiny concurrency limiter (semaphore).
 *
 * Caps how many async tasks run at once so bulk work — e.g. loading dozens of
 * screenshot thumbnails on the Timeline — can't saturate the API connection and
 * starve critical calls (roster/members) queued behind it. Tasks past the limit
 * wait in FIFO order and start as slots free up.
 *
 * No dependency; behaviour matches the common `p-limit` package for our use.
 */
export function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const run = queue.shift()!;
      active++;
      run();
    }
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}
