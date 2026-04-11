type FetchHandler = () => object;

/**
 * Replace global.fetch for the duration of `fn`, routing calls by URL substring.
 * Each key in `routes` is matched against the request URL; the first match wins.
 */
export async function withFetch<T>(
  routes: Record<string, FetchHandler>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const body = handler();
        return {
          ok: true,
          json: async () => body,
          arrayBuffer: async () => Buffer.from("fake-image").buffer,
        } as unknown as Response;
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof global.fetch;
  try {
    return await fn();
  } finally {
    global.fetch = saved;
  }
}

/** Stub an HTTP error response (non-2xx). */
export function httpError(status = 500): () => Response {
  return () =>
    ({
      ok: false,
      status,
      json: async () => ({}),
    } as unknown as Response);
}
