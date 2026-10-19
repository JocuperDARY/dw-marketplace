import { requireValue } from './errors.js';

// null is an omitted caller limit, never a large finite stand-in for unlimited.
export function optionalLimit(value, name, minimum = 1) {
  if (value === undefined || value === null) return null;
  requireValue(Number.isSafeInteger(value) && value >= minimum, 'INVALID_ARGUMENT', `${name} must be an integer >= ${minimum}, or omitted.`);
  return value;
}

export const withinLimit = (value, limit) => limit == null || (value != null && value <= limit);
export const minimumLimit = (...values) => {
  const finite = values.filter(value => value != null);
  return finite.length ? Math.min(...finite) : null;
};
export const remainingLimit = (limit, used) => limit == null ? null : used == null ? 0 : Math.max(0, limit - used);

export function deadlineAfter(duration, now = Date.now()) {
  if (duration == null) return null;
  const deadline = now + duration;
  requireValue(Number.isSafeInteger(deadline), 'INVALID_ARGUMENT', 'The duration exceeds the representable clock range.');
  return deadline;
}

/** Avoid Node's timer overflow converting long explicit deadlines into 1 ms. */
export function deadlineTimer(callback, duration) {
  if (duration == null) return () => {};
  const deadline = deadlineAfter(duration);
  let timer;
  const tick = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) callback();
    else timer = setTimeout(tick, Math.min(remaining, 2147483647));
  };
  tick();
  return () => clearTimeout(timer);
}
