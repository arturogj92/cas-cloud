/**
 * Leading + trailing coalescer. The first value passes through immediately; later values that
 * arrive within `windowMs` collapse into one emission of the latest value. Keeps a burst of
 * runtime envelopes (replay after resume, hydration, streaming deltas) from costing one React
 * render each, which is what saturates the JS thread and blocks taps and swipe releases.
 */
export function coalesceLatest<T>(emit: (value: T) => void, windowMs: number) {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmitAt = -Infinity;
  const emitPending = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastEmitAt = Date.now();
    emit(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer) return;
      const wait = windowMs - (Date.now() - lastEmitAt);
      if (wait <= 0) emitPending();
      else timer = setTimeout(emitPending, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
