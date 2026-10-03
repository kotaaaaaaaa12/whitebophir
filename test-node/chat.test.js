const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createConfig, createSocketScenario } = require("./test_helpers.js");

/** @typedef {import("../client-data/js/chat_protocol.js").ChatSendResult} ChatSendResult */
/** @typedef {import("../client-data/js/chat_protocol.js").ChatHistoryResult} ChatHistoryResult */

test("chat text accepts Unicode/newlines and rejects blanks, controls, bidi overrides and oversized or malformed messages", async () => {
  const {
    normalizeChatText,
    validChatClientId,
    validChatCursor,
    validChatInput,
    validChatMessage,
  } = await import("../client-data/js/chat_protocol.js");
  assert.equal(
    normalizeChatText("  日本語 🎨\r\nHello\tthere  "),
    "日本語 🎨\nHello\tthere",
  );
  assert.equal(normalizeChatText("🎨".repeat(1000)), "🎨".repeat(1000));
  for (const value of [
    "",
    " \n\t",
    "a\u0000b",
    "a\u0085b",
    "a\u202eb",
    "x".repeat(1001),
    "🎨".repeat(1001),
    {},
    null,
  ])
    assert.equal(normalizeChatText(value), null);
  assert.equal(validChatClientId(randomUUID()), true);
  assert.equal(validChatClientId("fake-nonce"), false);
  for (const value of [0, -1, NaN, Infinity, "1", 1.5])
    assert.equal(validChatCursor(value), false);
  const input = {
    author: "a".repeat(64),
    clientId: randomUUID(),
    name: "こた",
    text: "Hello",
    sentAt: Date.now(),
  };
  assert.equal(validChatInput(input), true);
  for (const text of [null, undefined, "", "\u0000"]) {
    assert.equal(validChatInput({ ...input, text }), false);
    assert.equal(validChatMessage({ ...input, id: 1, text }), false);
  }
  assert.equal(
    validChatMessage({ ...input, id: 1, sentAt: Number.MAX_SAFE_INTEGER }),
    false,
  );
  assert.equal(validChatInput({ ...input, name: "spoof\nname" }), false);
  assert.equal(
    validChatMessage({
      id: 1,
      name: "こた",
      text: "Hello",
      sentAt: Date.now(),
    }),
    true,
  );
});

test("local chat is durable across fresh connections, paginates all history, deduplicates retries and is erased with its board", async () => {
  const { saveChatMessage, readChatHistory, chatDatabasePath } = await import(
    "../server/persistence/chat_store.mjs"
  );
  const { registerBoardCreator, eraseBoard } = await import(
    "../server/persistence/board_lifecycle.mjs"
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-chat-store-"));
  const config = createConfig({ HISTORY_DIR: dir });
  try {
    await registerBoardCreator("chat-a", "a".repeat(32), config);
    await registerBoardCreator("chat-b", "b".repeat(32), config);
    const inputs = Array.from({ length: 103 }, (_, index) => ({
      author: "a".repeat(64),
      clientId: randomUUID(),
      name: "こた",
      text: `message ${index}`,
      sentAt: Date.now(),
    }));
    const saved = await Promise.all(
      inputs.map((input) => saveChatMessage("chat-a", config, input)),
    );
    const input = inputs[0];
    assert.ok(input);
    assert.deepEqual(
      await saveChatMessage("chat-a", config, {
        ...input,
        name: "changed name",
        text: "changed text",
      }),
      saved[0],
    );
    await saveChatMessage("chat-b", config, { ...input, text: "other board" });
    const first = await readChatHistory("chat-a", config);
    assert.equal(first.messages.length, 50);
    assert.equal(first.messages[0]?.text, "message 53");
    assert.equal(first.messages[49]?.text, "message 102");
    assert.ok(first.nextBefore);
    const second = await readChatHistory("chat-a", config, first.nextBefore);
    assert.ok(second.nextBefore);
    const third = await readChatHistory("chat-a", config, second.nextBefore);
    assert.equal(third.messages.length, 3);
    assert.equal(third.nextBefore, null);
    assert.equal(
      new Set(
        [...first.messages, ...second.messages, ...third.messages].map(
          (m) => m.id,
        ),
      ).size,
      103,
    );
    assert.equal(
      (await readChatHistory("chat-b", config)).messages[0]?.text,
      "other board",
    );
    assert.deepEqual(Object.keys(first.messages[0] || {}).sort(), [
      "id",
      "name",
      "sentAt",
      "text",
    ]);
    await eraseBoard("chat-a", config, async () => () => {});
    await assert.rejects(fs.stat(chatDatabasePath("chat-a", config)), {
      code: "ENOENT",
    });
    await assert.rejects(saveChatMessage("chat-a", config, input), {
      statusCode: 410,
    });
    await assert.rejects(readChatHistory("chat-a", config), {
      statusCode: 410,
    });
    assert.equal((await readChatHistory("chat-b", config)).messages.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat socket uses joined-board identity, persists before broadcasting, bounds requests and blocks banned/disconnected users", async () => {
  const { banBoardUser } = await import("../server/socket/bans.mjs");
  await createSocketScenario(
    { boardName: "chat-socket", config: { AUTH_SECRET_KEY: "" } },
    async (scenario) => {
      const owner = await scenario.connect({
        query: { displayName: "こた" },
        headers: {
          cookie: "wbo-user-secret-v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      });
      /** @param {string} event @param {unknown} payload */
      async function invoke(event, payload) {
        let result = /** @type {ChatSendResult | ChatHistoryResult | null} */ (
          null
        );
        await scenario.invoke(
          owner,
          event,
          payload,
          (/** @type {ChatSendResult | ChatHistoryResult} */ value) => {
            result = value;
          },
        );
        assert.ok(result);
        return /** @type {ChatSendResult | ChatHistoryResult} */ (result);
      }
      const nonce = randomUUID();
      const result = await invoke("chat_send", {
        clientId: nonce,
        text: "  <script>alert(1)</script>  ",
        name: "someone else",
        board: "other-private",
        sentAt: 1,
      });
      assert.equal(result.ok, true);
      if (!result.ok || !("message" in result))
        throw new Error("Missing saved message");
      assert.equal(result.message.name, "こた");
      assert.equal(result.message.text, "<script>alert(1)</script>");
      assert.ok(result.message.sentAt > 1);
      assert.ok(
        owner.broadcasted.some(
          (frame) =>
            frame.event === "chat_message" && frame.room === "chat-socket",
        ),
      );
      assert.deepEqual(
        owner.emitted.find((frame) => frame.event === "chat_message")?.payload,
        { ...result.message, own: true },
      );
      assert.deepEqual(
        owner.broadcasted.find((frame) => frame.event === "chat_message")
          ?.payload,
        result.message,
      );
      const history = await invoke("chat_history", { board: "other-private" });
      assert.equal(history.ok, true);
      if (history.ok && "messages" in history)
        assert.deepEqual(history.messages, [result.message]);
      const duplicate = await invoke("chat_send", {
        clientId: nonce,
        text: "duplicate",
      });
      if (duplicate.ok && "message" in duplicate)
        assert.equal(duplicate.message.id, result.message.id);
      else throw new Error("Retry failed");
      for (const payload of [
        { clientId: randomUUID(), text: "" },
        { clientId: randomUUID(), text: "x".repeat(1001) },
        { text: "missing id" },
      ]) {
        const invalid = await invoke("chat_send", payload);
        assert.equal(invalid.ok, false);
      }
      for (let i = 0; i < 3; i++)
        assert.equal(
          (
            await invoke("chat_send", {
              clientId: randomUUID(),
              text: `allowed ${i}`,
            })
          ).ok,
          true,
        );
      const limited = await invoke("chat_send", {
        clientId: randomUUID(),
        text: "too much",
      });
      assert.equal(limited.ok, false);
      if (!limited.ok) assert.equal(limited.error, "chat_rate_limited");
      const user = scenario.test
        .getBoardUserMap("chat-socket")
        .get(owner.socket.id);
      banBoardUser("chat-socket", user.userSecret, user.ip, Date.now(), 10_000);
      const banned = await invoke("chat_send", {
        clientId: randomUUID(),
        text: "banned",
      });
      assert.equal(banned.ok, false);
      if (!banned.ok) assert.equal(banned.error, "chat_unavailable");
      owner.socket.disconnect(true);
      assert.equal((await invoke("chat_history", {})).ok, false);
    },
  );
});

test("all 21 board languages include every chat label and error", async () => {
  const translations = /** @type {Record<string, Record<string, string>>} */ (
    require("../server/http/translations.json")
  );
  const keys = Object.keys(translations.en || {}).filter((key) =>
    key.startsWith("chat_"),
  );
  assert.equal(keys.length, 19);
  for (const [language, dictionary] of Object.entries(translations))
    for (const key of keys) {
      assert.ok(dictionary[key]?.trim(), `${language}: ${key}`);
      assert.deepEqual(
        (dictionary[key] || "").match(/\{[a-z_]+\}/g) || [],
        (translations.en?.[key] || "").match(/\{[a-z_]+\}/g) || [],
        `${language}: ${key} placeholders`,
      );
      if (language !== "en")
        assert.notEqual(dictionary[key], translations.en?.[key]);
    }
});

test("chat prefixes only a live signed administrator name and preserves the sent name after logout", async () => {
  const auth = await import("../server/auth/admin_session.mjs");
  const secret = "1234567890abcdef1234567890abcdef";
  const config = {
    AUTH_SECRET_KEY: "",
    BOARD_ADMIN_KEY: "chat-admin-test-key",
  };
  const token = auth.createAdminSession(secret, config);
  await createSocketScenario(
    { boardName: "chat-admin-name", config },
    async (scenario) => {
      const admin = await scenario.connect({
        id: "chat-admin",
        query: { displayName: "こた" },
        headers: {
          cookie: `wbo-user-secret-v1=${secret}; ${auth.ADMIN_COOKIE_NAME}=${token}`,
        },
      });
      const ordinary = await scenario.connect({
        id: "chat-ordinary",
        query: { displayName: "Peer" },
        headers: {
          cookie: `wbo-user-secret-v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; ${auth.ADMIN_COOKIE_NAME}=${token}`,
        },
      });
      /** @param {typeof admin} created @param {string} text */
      async function send(created, text) {
        let result = /** @type {ChatSendResult | null} */ (null);
        await scenario.invoke(
          created,
          "chat_send",
          {
            text,
            clientId: randomUUID(),
            administrator: true,
            name: "🌸forged",
          },
          (/** @type {ChatSendResult} */ value) => {
            result = value;
          },
        );
        assert.ok(result);
        const sent = /** @type {ChatSendResult} */ (result);
        if (!sent.ok) throw new Error(sent.error);
        return sent.message;
      }
      assert.equal((await send(ordinary, "not an administrator")).name, "Peer");
      const signed = await send(admin, "signed administrator");
      assert.equal(signed.name, "🌸こた");
      auth.revokeAdminSession(token);
      assert.equal((await send(admin, "after logout")).name, "こた");
      let history = /** @type {ChatHistoryResult | null} */ (null);
      await scenario.invoke(
        admin,
        "chat_history",
        {},
        (/** @type {ChatHistoryResult} */ value) => {
          history = value;
        },
      );
      assert.ok(history);
      const page = /** @type {ChatHistoryResult} */ (history);
      if (!page.ok) throw new Error(page.error);
      assert.equal(
        page.messages.find((m) => m.id === signed.id)?.name,
        "🌸こた",
      );
    },
  );
});

test("administrator chat deletion is board-scoped, durable, ordered and rejects normal/expired sessions and nonce resurrection", async () => {
  const auth = await import("../server/auth/admin_session.mjs");
  const {
    readChatHistory,
    saveChatMessage,
    deleteChatMessage,
    chatDatabasePath,
  } = await import("../server/persistence/chat_store.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const secret = "1234567890abcdef1234567890abcdef";
  const config = {
    AUTH_SECRET_KEY: "",
    BOARD_ADMIN_KEY: "chat-deletion-test-key",
  };
  const token = auth.createAdminSession(secret, config);
  await createSocketScenario(
    { boardName: "chat-delete", config },
    async (scenario) => {
      const admin = await scenario.connect({
        id: "admin-delete",
        query: { displayName: "Admin" },
        headers: {
          cookie: `wbo-user-secret-v1=${secret}; ${auth.ADMIN_COOKIE_NAME}=${token}`,
        },
      });
      const ordinary = await scenario.connect({
        id: "ordinary-delete",
        query: { displayName: "Peer" },
        headers: {
          cookie: "wbo-user-secret-v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      });
      /** @param {typeof admin} created @param {string} event @param {unknown} payload @returns {Promise<any>} */
      async function invoke(created, event, payload) {
        let result;
        await scenario.invoke(
          created,
          event,
          payload,
          (/** @type {unknown} */ value) => {
            result = value;
          },
        );
        assert.ok(result);
        return result;
      }
      const nonce = randomUUID();
      const sent = await invoke(ordinary, "chat_send", {
        text: "private message to delete",
        clientId: nonce,
      });
      assert.equal(sent.ok, true);
      assert.equal(
        (await invoke(ordinary, "chat_history", {})).canDelete,
        false,
      );
      assert.equal((await invoke(admin, "chat_history", {})).canDelete, true);
      assert.equal(
        (
          await invoke(ordinary, "chat_delete", {
            id: sent.message.id,
            administrator: true,
          })
        ).error,
        "chat_delete_forbidden",
      );
      for (const payload of [
        null,
        [],
        {},
        { id: -1 },
        { id: "1" },
        { id: 1.5 },
      ])
        assert.equal((await invoke(admin, "chat_delete", payload)).ok, false);
      const results = await Promise.all([
        invoke(admin, "chat_delete", {
          id: sent.message.id,
          board: "other-board",
        }),
        invoke(ordinary, "chat_send", {
          text: "private message to delete",
          clientId: nonce,
        }),
      ]);
      assert.equal(results[0].ok, true);
      assert.equal(results[1].ok, false);
      assert.ok(
        admin.broadcasted.some(
          (frame) =>
            frame.event === "chat_deleted" &&
            frame.room === "chat-delete" &&
            frame.payload.id === sent.message.id,
        ),
      );
      assert.equal(
        (await invoke(admin, "chat_delete", { id: sent.message.id })).ok,
        true,
      );
      assert.equal(
        (await invoke(admin, "chat_history", {})).messages.length,
        0,
      );
      const effectiveConfig = scenario.sockets.__config;
      const db = new DatabaseSync(
        chatDatabasePath("chat-delete", effectiveConfig),
      );
      try {
        assert.equal(
          db
            .prepare("SELECT * FROM messages WHERE id = ?")
            .get(sent.message.id),
          undefined,
        );
        assert.deepEqual(
          Object.keys(
            db
              .prepare("SELECT * FROM deleted_messages WHERE id = ?")
              .get(sent.message.id) || {},
          ).sort(),
          ["author", "client_id", "id"],
        );
      } finally {
        db.close();
      }
      const kept = await saveChatMessage("other-board", effectiveConfig, {
        author: "b".repeat(64),
        clientId: randomUUID(),
        name: "Other",
        text: "keep",
        sentAt: Date.now(),
      });
      assert.equal(
        await deleteChatMessage("chat-delete", effectiveConfig, kept.id + 1000),
        false,
      );
      assert.equal(
        (await readChatHistory("other-board", effectiveConfig)).messages[0]
          ?.text,
        "keep",
      );
      auth.revokeAdminSession(token);
      assert.equal(
        (await invoke(admin, "chat_delete", { id: kept.id })).error,
        "chat_delete_forbidden",
      );
    },
  );
});
