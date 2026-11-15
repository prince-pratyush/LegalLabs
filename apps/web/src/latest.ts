export type Latest<T> = { current: true; value: T } | { current: false };

/**
 * Wraps a fetch so only the newest call's result counts: a slow, older
 * response that lands after a newer one is marked stale instead of applied.
 */
export function latestOnly<A extends unknown[], T>(
  fetcher: (...args: A) => Promise<T>,
): (...args: A) => Promise<Latest<T>> {
  let calls = 0;
  return async (...args) => {
    const mine = ++calls;
    const value = await fetcher(...args);
    return mine === calls ? { current: true, value } : { current: false };
  };
}
