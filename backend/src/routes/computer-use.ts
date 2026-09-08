import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { controlOriginError, requireSessionAuth } from "../auth.js";
import { getComputerUseHost, logComputerUseFailure } from "../services/computer-use.js";

/** This control plane is for the signed-in human, never an agent API key.
 *  The per-action confirmation now lives in the chat, and `POST
 *  /api/chats/:id/respond` applies the same two rules to it — see
 *  `pendingRequestRequiresHuman`. */
export function requireControlOrigin(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "GET") {
    next();
    return;
  }
  const error = controlOriginError(req);
  if (error) {
    res.status(403).json({ error, code: "denied" });
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

function handle(operation: string, fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      const value = error as { code?: string; message?: string };
      const code = value.code ?? "unavailable";
      // The client answer below stays sanitized; the operator's copy goes to the log.
      logComputerUseFailure(operation, { chatId: req.params.chatId, sessionId: req.params.sessionId }, error);
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
  handle("status", async (req) => {
    const { chatId } = ids(req);
    return (await getComputerUseHost()).status(chatId);
  }),
);
computerUseRouter.post(
  "/:chatId/open",
  handle("open", async (req) => {
    const { chatId } = ids(req);
    const kind = req.body?.kind;
    if (kind !== "browser" && kind !== "desktop" && kind !== "native" && kind !== "native-desktop")
      throw Object.assign(new Error("Choose browser or native desktop explicitly"), { code: "invalid_request" });
    return { session: await (await getComputerUseHost()).open(chatId, kind === "browser" ? "browser" : "desktop") };
  }),
);
computerUseRouter.post(
  "/:chatId/:sessionId/observe",
  handle("observe", async (req) => {
    const { chatId, sessionId } = ids(req);
    return (await getComputerUseHost()).observe(chatId, sessionId);
  }),
);
computerUseRouter.post(
  "/:chatId/:sessionId/action",
  handle("action", async (req) => {
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
    handle(operation, async (req) => {
      const { chatId, sessionId } = ids(req);
      return (await getComputerUseHost())[operation](chatId, sessionId, req.body?.expectedGeneration);
    }),
  );
}
