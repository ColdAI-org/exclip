import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelError, openChannel, type ChannelEnv, type MessageEventLike } from "../src/channel.ts";
import { parseResponse } from "../src/protocol.ts";

const EXCLIP = "https://exclip.example.com";
const WWW = "https://www.exclip.example.com";
const connect = { v: 1, kind: "exclip-wallet", id: "req_0123456789abcdef", type: "connect", intent: "create" };

function harness(opts: { opener?: boolean } = {}) {
  const posted: { message: unknown; origin: string }[] = [];
  const opener = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) };
  let handler: ((e: MessageEventLike) => void) | null = null;
  let fire: (() => void) | null = null;
  const env: ChannelEnv = {
    opener: opts.opener === false ? null : opener,
    parents: [EXCLIP, WWW],
    listen: (fn) => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    setTimeout: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimeout: () => {
      fire = null;
    },
  };
  return { env, opener, posted, send: (e: MessageEventLike) => handler?.(e), timeout: () => fire?.(), listening: () => handler !== null };
}

test("announces ready to each allowed parent by exact origin, never '*'", async () => {
  const h = harness();
  const p = openChannel(h.env);
  assert.deepEqual(h.posted.map((x) => x.origin), [EXCLIP, WWW]);
  for (const x of h.posted) assert.deepEqual(parseResponse(x.message), { v: 1, kind: "exclip-wallet", type: "ready" });
  h.send({ data: connect, origin: EXCLIP, source: h.opener });
  await p;
});

test("only the opener, from an allowed origin, with a valid message, is accepted; the first one wins", async () => {
  const h = harness();
  const p = openChannel(h.env);
  const otherWindow = { postMessage() {} };
  h.send({ data: connect, origin: "https://evil.test", source: h.opener }); // right window, wrong origin
  h.send({ data: connect, origin: EXCLIP, source: otherWindow }); // right origin, another window (e.g. an iframe)
  h.send({ data: { ...connect, extra: true }, origin: EXCLIP, source: h.opener }); // malformed
  h.send({ data: { ...connect, type: "personal_sign" }, origin: EXCLIP, source: h.opener });
  assert.ok(h.listening(), "still waiting");
  h.send({ data: { ...connect, intent: "signin" }, origin: WWW, source: h.opener });
  const s = await p;
  assert.equal(s.request.type, "connect");
  assert.equal((s.request as { intent: string }).intent, "signin");
  assert.equal(s.origin, WWW);
  assert.equal(h.listening(), false, "one request per popup");
  assert.equal(h.posted.length, 2, "nothing was answered to the rejected messages");

  s.reply({ backedUp: false, passkeys: 1 });
  s.fail("FAILED", "late");
  assert.equal(h.posted.length, 3, "exactly one answer");
  assert.equal(h.posted[2]!.origin, WWW, "answered to the origin that asked");
  const res = parseResponse(h.posted[2]!.message);
  assert.deepEqual(res, { v: 1, kind: "exclip-wallet", id: connect.id, type: "result", ok: true, result: { backedUp: false, passkeys: 1 } });
  assert.equal(s.answered, true);
});

test("errors are bounded and well-formed", async () => {
  const h = harness();
  const p = openChannel(h.env);
  h.send({ data: connect, origin: EXCLIP, source: h.opener });
  const s = await p;
  s.fail("REFUSED", "x".repeat(1000));
  const res = parseResponse(h.posted[2]!.message) as { error: { message: string } };
  assert.equal(res.error.message.length, 300);
});

test("no opener, or no request in time", async () => {
  await assert.rejects(openChannel(harness({ opener: false }).env), (e: unknown) => e instanceof ChannelError && e.code === "NO_OPENER");
  const h = harness();
  const p = openChannel(h.env);
  h.timeout();
  await assert.rejects(p, (e: unknown) => e instanceof ChannelError && e.code === "TIMEOUT");
  assert.equal(h.listening(), false);
});
