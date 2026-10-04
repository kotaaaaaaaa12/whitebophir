const test = require("node:test");
const assert = require("node:assert/strict");
const { replayEntry } = require("../cloudflare/recovery.mjs");
const { BoardData } = require("../server/board/data.mjs");
const { createConfig } = require("./test_helpers.js");
const { contract } = require("../client-data/tools/pencil/index.js");
const { Pencil, Rectangle, Text } = require("../client-data/tools/index.js");
const {
  storedSvgSerializeHelpers,
  summarizeStoredSvgItem,
} = require("../server/persistence/stored_svg_item_codec.mjs");

test("orphan pencil points advance recovery without inventing a stroke, while later edits survive", async () => {
  const board = new BoardData("recovery-orphan", createConfig());
  try {
    assert.equal(
      await replayEntry(board, {
        seq: 1,
        acceptedAtMs: 1,
        mutation: { tool: Pencil.id, type: 4, parent: "missing", x: 10, y: 20 },
      }),
      true,
    );
    assert.equal(board.itemsById.size, 0);
    assert.equal(board.getSeq(), 1);
    assert.equal(
      await replayEntry(board, {
        seq: 2,
        acceptedAtMs: 2,
        mutation: {
          tool: Rectangle.id,
          type: 1,
          id: "kept",
          color: "#123456",
          size: 3,
          x: 1,
          y: 2,
          x2: 10,
          y2: 20,
        },
      }),
      false,
    );
    assert.equal(board.itemsById.has("kept"), true);
    assert.equal(board.getSeq(), 2);
    assert.deepEqual(board.readMutationsAfter(0)[0]?.mutation, {
      tool: Pencil.id,
      type: 4,
      parent: "missing",
      x: 10,
      y: 20,
    });
  } finally {
    board.dispose();
  }
});

test("recovery still rejects gaps, wrong parent types and unrelated invalid edits", async () => {
  const board = new BoardData("recovery-invalid", createConfig());
  try {
    const mutation = /** @type {const} */ ({
      tool: Pencil.id,
      type: 4,
      parent: "missing",
      x: 1,
      y: 2,
    });
    await assert.rejects(
      replayEntry(board, { seq: 2, acceptedAtMs: 1, mutation }),
      /sequence gap/,
    );
    await replayEntry(board, {
      seq: 1,
      acceptedAtMs: 1,
      mutation: {
        tool: Rectangle.id,
        type: 1,
        id: "rect",
        color: "#123456",
        size: 3,
        x: 1,
        y: 2,
        x2: 10,
        y2: 20,
      },
    });
    await assert.rejects(
      replayEntry(board, {
        seq: 2,
        acceptedAtMs: 2,
        mutation: { ...mutation, parent: "rect" },
      }),
      /invalid parent/,
    );
    await assert.rejects(
      replayEntry(board, {
        seq: 2,
        acceptedAtMs: 2,
        mutation: {
          tool: Text.id,
          type: 2,
          id: "missing",
          txt: "Not an orphan point",
        },
      }),
      /object not found/,
    );
    assert.equal(board.getSeq(), 1);
  } finally {
    board.dispose();
  }
});

test("Cloudflare pencil seeds retain metadata without drawing a fabricated point", () => {
  const svg = contract.serializeStoredSvgItem(
    {
      id: "seed",
      color: "#123456",
      size: 7,
      opacity: 0.4,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 25, f: 30 },
    },
    { ...storedSvgSerializeHelpers, preservePencilSeeds: true },
  );
  assert.match(svg, /d="" data-wbo-pencil-seed="true"/);
  const summary = summarizeStoredSvgItem({
    tagName: "path",
    rawAttributes: svg.slice(5, svg.indexOf(">")),
  });
  assert.equal(summary.childCount, 0);
  assert.equal(summary.localBounds, null);
  assert.deepEqual(summary.data, {
    color: "#123456",
    size: 7,
    opacity: 0.4,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 25, f: 30 },
  });
  assert.equal(
    summarizeStoredSvgItem({
      tagName: "path",
      attributes: {
        id: "invalid",
        d: "broken",
        "stroke-width": "7",
        "data-wbo-pencil-seed": "true",
      },
    }),
    null,
  );
});
