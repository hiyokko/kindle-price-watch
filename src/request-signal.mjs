export function requestSignal(externalSignal, timeoutMs) {
  if (!externalSignal && !timeoutMs) return { signal: undefined, cleanup: () => {} };

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timeoutId = timeoutMs > 0 ? setTimeout(abort, timeoutMs) : null;

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abort);
    }
  };
}

export function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener('abort', abort);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
