import { createLibraryService } from "../index.ts";
const service = createLibraryService({ databasePath: process.argv[2] });
process.send?.({ ready: true });
process.on("message", async (message: any) => {
  try {
    const result =
      message.operation === "merge"
        ? await service.mergeProposal(message.actor, message.input)
        : {
            versions: await service.listVersions(
              message.actor,
              message.skillId,
            ),
            events: await service.listUpdateEvents(message.actor, 0),
            snapshot: await service.catalogSnapshot(message.actor),
          };
    process.send?.({ ok: true, result });
  } catch (error: any) {
    process.send?.({ ok: false, code: error.code, message: error.message });
  } finally {
    service.close();
    process.disconnect();
  }
});
