import { setTimeout as delay } from 'node:timers/promises';

// A lost response does not prove that a remote write was not committed.
// Only tools/list may be replayed; never replay tools/call.
export function discoveryFetch(fetchImpl = fetch, { delays = [200, 500], wait = delay } = {}) {
  return async (url, init) => {
    let discovery = false;
    try {
      const message = JSON.parse(init?.body);
      discovery = init?.method?.toUpperCase() === 'POST' && message.method === 'tools/list';
    } catch { /* Streaming bodies and unknown requests must not be replayed. */ }
    for (let attempt = 0; ; attempt++) {
      try { return await fetchImpl(url, init); }
      catch (error) {
        const networkFailure = error instanceof TypeError && error.message === 'fetch failed';
        if (!discovery || !networkFailure || init?.signal?.aborted || attempt >= delays.length) throw error;
        await wait(delays[attempt], undefined, { signal: init?.signal });
      }
    }
  };
}
