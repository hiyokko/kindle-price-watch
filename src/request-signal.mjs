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
