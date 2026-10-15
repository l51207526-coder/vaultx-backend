import type { Request, Response, NextFunction, RequestHandler } from "express";

type WindowEntry = { count: number; resetAt: number };

/** In-process request limiter. Use an edge/shared store for multi-instance deployments. */
export function createRateLimiter(maxRequests: number, windowMs: number): RequestHandler {
  const windows = new Map<string, WindowEntry>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let entry = windows.get(key);

    if (!entry || entry.resetAt <= now) {
      if (windows.size >= 10_000) {
        for (const [storedKey, storedEntry] of windows) {
          if (storedEntry.resetAt <= now) windows.delete(storedKey);
        }
      }
      if (windows.size >= 10_000) {
        return res.status(429).json({ error: "Too many requests. Try again later." });
      }
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    entry.count += 1;
    res.setHeader("RateLimit-Limit", maxRequests);
    res.setHeader("RateLimit-Remaining", Math.max(0, maxRequests - entry.count));
    res.setHeader("RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    next();
  };
}
