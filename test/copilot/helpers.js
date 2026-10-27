// Fake clock: timers fire in order as time is advanced, awaiting async callbacks.
function fakeClock(start = 1_000_000) {
  let t = start;
  let timers = [];
  let seq = 0;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers = timers.filter((x) => x.id !== id);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    pending: () => timers.length,
  };
}
module.exports = { fakeClock };
