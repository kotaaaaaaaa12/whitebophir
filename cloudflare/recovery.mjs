import { Pencil } from "../client-data/tools/index.js";
import { MutationType } from "../client-data/js/mutation_type.js";

/** @import { BoardData } from "../server/board/data.mjs" */
/** @import { MutationLogEntry } from "../types/server-runtime.d.ts" */

/**
 * Replay one committed entry. Old checkpoints could omit an empty pencil
 * seed while compacting its creation record. Keep orphan points in a durable
 * recovery archive before checkpointing; never invent their stroke metadata.
 * @param {BoardData} board
 * @param {MutationLogEntry} entry
 * @returns {Promise<boolean>} Whether the entry needs archival recovery.
 */
export async function replayEntry(board, entry) {
  if (entry.seq !== board.getSeq() + 1)
    throw new Error("Mutation sequence gap");
  const prepared = await board.preparePersistentMutation(entry.mutation);
  const mutation =
    prepared.ok && prepared.mutation ? prepared.mutation : entry.mutation;
  const result = board.processMessage(mutation);
  const fields =
    /** @type {{type?: number, id?: string, parent?: string, tool?: unknown}} */ (
      mutation
    );
  const alreadyDeleted =
    fields.type === MutationType.DELETE &&
    typeof fields.id === "string" &&
    (!board.itemsById.has(fields.id) ||
      board.itemsById.get(fields.id)?.deleted === true);
  const orphanPoint =
    !result.ok &&
    result.reason === "invalid parent for child" &&
    (fields.tool === Pencil.id || fields.tool === Pencil.toolId) &&
    fields.type === MutationType.APPEND &&
    typeof fields.parent === "string" &&
    !board.itemsById.has(fields.parent);
  if (!result.ok && !alreadyDeleted && !orphanPoint)
    throw new Error(`Cannot recover mutation ${entry.seq}: ${result.reason}`);
  board.consumePendingAcceptedMutationEffects();
  board.consumePendingRejectedMutationEffects();
  board.recordPersistentMutation(mutation, entry.acceptedAtMs);
  board.clearSaveTimeout();
  return orphanPoint;
}
