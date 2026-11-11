import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { requireStepUp } from "@/lib/stepup";
import { dumpBeforeReset, removeFiles, resetData } from "@/lib/services/reset";

// Owner only. GET = full JSON snapshot to download first; POST = the reset itself (phrase + 2FA code).
export const GET = secured({ ownerOnly: true }, ({ tx }) => dumpBeforeReset(tx));
export const POST = secured({ ownerOnly: true }, async ({ tx, principal, actor, req }) => {
  const b = parse(z.object({ phrase: z.string(), code: z.string().optional(), backedUp: z.literal(true) }), await req.json());
  await requireStepUp(tx, principal, b.code);
  const { files } = await resetData(tx, actor, b.phrase);
  // Files are removed after the response is built; a failure to delete a file never undoes the reset.
  queueMicrotask(() => { void removeFiles(actor.companyId, files); });
  return { ok: true, removedFiles: files.length };
});
