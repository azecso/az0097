import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { requireStepUp } from "@/lib/stepup";
import { prepareReset, removeFiles, resetData, resetStatus } from "@/lib/services/reset";

// Owner only. GET = status (the copy itself: /api/settings/reset/download?file=…); POST {action:"prepare"} writes + verifies the full copy; POST {action:"reset"} wipes.
export const GET = secured({ ownerOnly: true }, ({ tx }) => resetStatus(tx));
export const POST = secured({ ownerOnly: true }, async ({ tx, principal, actor, req }) => {
  const b = parse(z.discriminatedUnion("action", [z.object({ action: z.literal("prepare") }), z.object({ action: z.literal("reset"), phrase: z.string(), code: z.string().optional() })]), await req.json());
  if (b.action === "prepare") return prepareReset(tx, actor);
  await requireStepUp(tx, principal, b.code);
  const { files } = await resetData(tx, actor, b.phrase);
  queueMicrotask(() => { void removeFiles(actor.companyId, files); });
  return { ok: true, removedFiles: files.length };
});
