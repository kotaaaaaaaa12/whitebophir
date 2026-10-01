import { DurableObject } from "cloudflare:workers";
import { decodeAndValidateBoardName } from "../client-data/js/board_name.js";

interface Entry {
  seq: number;
  acceptedAtMs: number;
  mutation: Record<string, unknown>;
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Entry>;
  return (
    Number.isSafeInteger(entry.seq) &&
    Number(entry.seq) > 0 &&
    Number.isFinite(entry.acceptedAtMs) &&
    !!entry.mutation &&
    typeof entry.mutation === "object" &&
    !Array.isArray(entry.mutation)
  );
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Journal request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class WhiteboardStorage extends DurableObject<Env> {
  private snapshotQueue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS boards (
      name TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0,
      checkpoint INTEGER NOT NULL DEFAULT 0,
      previous_checkpoint INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS mutations (
      board TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL,
      PRIMARY KEY (board, seq)
    );`);
  }

  // Only the Container's outbound handler calls this object. The public Worker
  // never routes user requests here, so there is no public storage endpoint.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/boards" && request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM boards WHERE name > ? ORDER BY name LIMIT 100",
          url.searchParams.get("after") || "",
        )
        .toArray();
      return Response.json(rows.map((row) => row.name));
    }
    const match = /^\/(snapshot|restore|journal)\/([^/]+)$/.exec(url.pathname);
    const name = match ? decodeAndValidateBoardName(match[2]) : null;
    if (!match || !name)
      return new Response("Invalid storage path", { status: 400 });
    const prefix = `boards/${encodeURIComponent(name)}/`;
    if (match[1] === "restore" && request.method === "GET") {
      const row = this.board(name);
      const object = await this.env.BOARDS.get(
        `${prefix}${row.checkpoint}.svg`,
      );
      if (!object && row.checkpoint > 0) {
        return new Response("Snapshot is missing", { status: 503 });
      }
      if (object && Number(object.customMetadata?.seq) !== row.checkpoint) {
        return new Response("Snapshot checkpoint mismatch", { status: 503 });
      }
      return new Response(object?.body ?? null, {
        status: object ? 200 : 204,
        headers: { "x-snapshot-seq": String(row.checkpoint) },
      });
    }
    if (match[1] === "journal" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      if (!Number.isSafeInteger(after) || after < 0)
        return new Response("Invalid sequence", { status: 400 });
      const rows = this.ctx.storage.sql
        .exec<{ entry: string }>(
          "SELECT entry FROM mutations WHERE board = ? AND seq > ? ORDER BY seq LIMIT 8",
          name,
          after,
        )
        .toArray();
      return new Response(`[${rows.map((row) => row.entry).join(",")}]`, {
        headers: { "content-type": "application/json" },
      });
    }
    if (match[1] === "journal" && request.method === "POST") {
      let entries: unknown;
      try {
        entries = await boundedJson(request);
      } catch {
        return new Response("Invalid journal body", { status: 400 });
      }
      if (
        !Array.isArray(entries) ||
        entries.length === 0 ||
        !entries.every(validEntry)
      ) {
        return new Response("Invalid journal entries", { status: 400 });
      }
      try {
        this.ctx.storage.transactionSync(() => {
          let row = this.board(name);
          for (const entry of entries) {
            if (entry.seq <= row.checkpoint) continue;
            const json = JSON.stringify(entry);
            if (new TextEncoder().encode(json).byteLength > 1_900_000)
              throw new Error("Entry is too large");
            if (entry.seq <= row.seq) {
              const previous = this.ctx.storage.sql
                .exec<{ entry: string }>(
                  "SELECT entry FROM mutations WHERE board = ? AND seq = ?",
                  name,
                  entry.seq,
                )
                .toArray()[0];
              if (previous?.entry !== json)
                throw new Error("Conflicting mutation");
              continue;
            }
            if (entry.seq !== row.seq + 1)
              throw new Error("Mutation sequence gap");
            this.ctx.storage.sql.exec(
              "INSERT INTO mutations VALUES (?, ?, ?)",
              name,
              entry.seq,
              json,
            );
            this.ctx.storage.sql.exec(
              "UPDATE boards SET seq = ? WHERE name = ?",
              entry.seq,
              name,
            );
            row = { ...row, seq: entry.seq };
          }
        });
      } catch (error) {
        console.error("journal.rejected", String(error));
        return new Response("Journal conflict", { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (match[1] === "snapshot" && request.method === "PUT") {
      const save = this.snapshotQueue.then(async () => {
        const seq = Number(url.searchParams.get("seq"));
        const length = Number(request.headers.get("content-length"));
        const row = this.board(name);
        if (
          !Number.isSafeInteger(seq) ||
          seq < row.checkpoint ||
          !request.body ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > 64 * 1024 * 1024
        ) {
          return new Response("Invalid snapshot", { status: 409 });
        }
        const { readable, writable } = new FixedLengthStream(length);
        await Promise.all([
          request.body.pipeTo(writable),
          this.env.BOARDS.put(`${prefix}${seq}.svg`, readable, {
            httpMetadata: { contentType: "image/svg+xml" },
            customMetadata: { seq: String(seq) },
          }),
        ]);
        // Immutable objects make an interrupted upload/pointer update harmless.
        // R2 succeeds before log compaction. A failed upload retains the journal.
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE boards SET previous_checkpoint = checkpoint, checkpoint = ?, seq = MAX(seq, ?) WHERE name = ?",
            seq,
            seq,
            name,
          );
          this.ctx.storage.sql.exec(
            "DELETE FROM mutations WHERE board = ? AND seq <= ?",
            name,
            seq,
          );
        });
        if (
          row.previous_checkpoint > 0 &&
          row.previous_checkpoint !== row.checkpoint &&
          row.previous_checkpoint !== seq
        ) {
          this.ctx.waitUntil(
            this.env.BOARDS.delete(
              `${prefix}${row.previous_checkpoint}.svg`,
            ).catch((error: unknown) => {
              console.error("snapshot.cleanup_failed", String(error));
            }),
          );
        }
        return new Response(null, { status: 204 });
      });
      this.snapshotQueue = save.catch(() => undefined);
      return save;
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private board(name: string): {
    seq: number;
    checkpoint: number;
    previous_checkpoint: number;
  } {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO boards (name) VALUES (?)",
      name,
    );
    return this.ctx.storage.sql
      .exec<{ seq: number; checkpoint: number; previous_checkpoint: number }>(
        "SELECT seq, checkpoint, previous_checkpoint FROM boards WHERE name = ?",
        name,
      )
      .toArray()[0];
  }
}
