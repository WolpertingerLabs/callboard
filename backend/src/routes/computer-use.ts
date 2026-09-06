import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireSessionAuth } from "../auth.js";
import { getComputerUseHost } from "../services/computer-use.js";

/** This control plane is for the signed-in human, never an agent API key. */
export function requireControlOrigin(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "GET") {
    next();
    return;
  }
  try {
    const origin = new URL(req.get("origin") || "");
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.get("host") || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "Computer control requires a same-origin browser session.", code: "denied" });
      return;
    }
  } catch {
    res.status(403).json({ error: "Computer control requires a valid Origin header.", code: "denied" });
    return;
  }
  next();
}

export const computerUseRouter = Router();
computerUseRouter.use(requireSessionAuth, requireControlOrigin);
computerUseRouter.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

const idPattern = /^[a-zA-Z0-9_-]{1,160}$/;
function ids(req: Request): { chatId: string; sessionId: string } {
  const chatId = String(req.params.chatId ?? "");
  const sessionId = String(req.params.sessionId ?? "");
  if (!idPattern.test(chatId) || (sessionId && !idPattern.test(sessionId)))
    throw Object.assign(new Error("Invalid control identifier"), { code: "invalid_request" });
  return { chatId, sessionId };
}

function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      const value = error as { code?: string; message?: string };
      const code = value.code ?? "unavailable";
      const status =
        code === "not_found"
          ? 404
          : code === "invalid_request"
            ? 400
            : ["denied", "approval_required"].includes(code)
              ? 403
              : ["lease_conflict", "stale_frame", "stale_generation", "stopped", "revoked"].includes(code)
                ? 409
                : 503;
      res.status(status).json({ code, error: value.code ? value.message : "Computer control is unavailable. Check the configured driver prerequisites." });
    }
  };
}

computerUseRouter.get(
  "/:chatId/status",
  handle(async (req) => {
    const { chatId } = ids(req);
    return (await getComputerUseHost()).status(chatId);
  }),
);
computerUseRouter.post(
  "/:chatId/open",
  handle(async (req) => {
    const { chatId } = ids(req);
    const kind = req.body?.kind;
    if (kind !== "browser" && kind !== "desktop" && kind !== "native" && kind !== "native-desktop")
      throw Object.assign(new Error("Choose browser or native desktop explicitly"), { code: "invalid_request" });
    return { session: await (await getComputerUseHost()).open(chatId, kind === "browser" ? "browser" : "desktop") };
  }),
);
computerUseRouter.post(
  "/:chatId/:sessionId/observe",
  handle(async (req) => {
    const { chatId, sessionId } = ids(req);
    return (await getComputerUseHost()).observe(chatId, sessionId);
  }),
);
computerUseRouter.post(
  "/:chatId/:sessionId/action",
  handle(async (req) => {
    const { chatId, sessionId } = ids(req);
    const frameId = req.body?.frameId;
    if (typeof frameId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frameId))
      throw Object.assign(new Error("A fresh observation frameId is required"), { code: "invalid_request" });
    return (await getComputerUseHost()).action(chatId, sessionId, req.body?.action, req.body?.expectedGeneration ?? req.body?.generation, frameId);
  }),
);
for (const operation of ["approve", "takeover", "resume", "stop", "revoke"] as const) {
  computerUseRouter.post(
    `/:chatId/:sessionId/${operation}`,
    handle(async (req) => {
      const { chatId, sessionId } = ids(req);
      return (await getComputerUseHost())[operation](chatId, sessionId, req.body?.expectedGeneration);
    }),
  );
}
