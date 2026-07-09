// Shared HTTP client. Sampling every account at once, or swapping right at a
// limit, can trip an endpoint's burst throttle, so GETs retry a bounded number
// of times, honoring the server's Retry-After (capped). throwHttpErrors is off
// so callers read the body and shape their own fail-fast error; retry still runs.

import ky from "ky";

export const http = ky.create({
  timeout: 15_000,
  throwHttpErrors: false,
  retry: {
    limit: 2,
    methods: ["get"],
    statusCodes: [429, 500, 502, 503, 504],
    afterStatusCodes: [429, 503],
    maxRetryAfter: 10_000,
    backoffLimit: 3000,
  },
});
