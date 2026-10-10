/** Monotonic clock in ms (performance.now): for measuring durations, not for dates. */
export const clock = { now: () => performance.now() };

/** SchedulerPort backed by setTimeout. */
export const scheduler = {
  after(ms, fn) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};
