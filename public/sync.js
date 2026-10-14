export const POLL_INTERVAL_MS = 3000;

export function startPolling({ read, onDishes, onConnection }) {
  let stopped = false;
  let controller = null;
  const timer = setInterval(async () => {
    if (stopped || controller) return; // Never overlap slow requests.
    controller = new AbortController();
    try {
      const dishes = await read({ signal: controller.signal });
      if (stopped) return;
      onDishes(dishes);
      onConnection(true);
    } catch {
      if (!stopped) onConnection(false);
    } finally { controller = null; }
  }, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    controller?.abort();
  };
}
