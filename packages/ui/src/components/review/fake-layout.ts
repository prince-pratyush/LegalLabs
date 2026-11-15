// Tests only: jsdom lays nothing out, so virtualisers would see a zero-size window.
// Returns a function that puts the real getters back.
export function fakeLayout(sizes = { clientHeight: 600, clientWidth: 1200 }): () => void {
  const saved = Object.keys(sizes).map(
    (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
  );
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, key);
    }
  };
}
