/**
 * How many levels of objects and arrays a request body may nest. The recursive readers of a parsed body
 * (class-transformer in the validation pipe, the send idempotency fingerprint, the cluster proxy's
 * JSON.stringify) overflow the stack a couple of thousand levels down and answered 500 with a stack trace
 * in the log. A real payload nests a handful of levels; nothing in the API takes one near this.
 */
export const MAX_BODY_NESTING = 100;

/** Whether a parsed request body nests deeper than the cap. It stops descending at the cap, so the walk cannot overflow. */
export const exceedsBodyNesting = (value: unknown, depth = 1): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (depth > MAX_BODY_NESTING || Object.values(value).some(child => exceedsBodyNesting(child, depth + 1)));
