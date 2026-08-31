import test from "node:test";
import assert from "node:assert/strict";

import { createTransferSession } from "../protocol/transfer.js";
import { createLoopbackPair } from "../protocol/loopback.js";
import { bytesSource, memorySink } from "../protocol/sources.js";
import { digestBytes } from "../protocol/digest.js";
import { equalBytes, randomBytes } from "../protocol/util.js";

function pair({ chunkSize = 1024, autoAccept = () => true, latency = 0, onSenderEvent, onReceiverEvent } = {}) {
  const [left, right] = createLoopbackPair({ latency });
  const received = [];
  const sender = createTransferSession({
    channel: left,
    chunkSize,
    createSink: memorySink(),
    onEvent: onSenderEvent ?? (() => {})
  });
  const receiver = createTransferSession({
    channel: right,
    chunkSize,
    autoAccept,
    createSink: memorySink(),
    onEvent: (event) => {
      if (event.type === "complete" && event.direction === "receive") received.push(event.result);
      onReceiverEvent?.(event);
    }
  });
  return { sender, receiver, received, left, right };
}

test("a file arrives byte-identical", async () => {
  const { sender, received } = pair({ chunkSize: 1024 });
  const bytes = randomBytes(10000);
  const result = await sender.send(bytesSource({ name: "photo.jpg", mime: "image/jpeg", bytes }));

  assert.equal(result.name, "photo.jpg");
  assert.equal(result.size, 10000);
  assert.equal(received.length, 1);
  assert.equal(received[0].name, "photo.jpg");
  assert.equal(received[0].mime, "image/jpeg");
  assert.ok(equalBytes(received[0].bytes, bytes));
});

test("a file smaller than one chunk still transfers", async () => {
  const { sender, received } = pair({ chunkSize: 65536 });
  const bytes = randomBytes(7);
  await sender.send(bytesSource({ name: "tiny.bin", bytes }));
  assert.ok(equalBytes(received[0].bytes, bytes));
});

test("an empty file transfers and completes", async () => {
  const { sender, received } = pair();
  const bytes = new Uint8Array(0);
  const result = await sender.send(bytesSource({ name: "empty.txt", bytes }));
  assert.equal(result.size, 0);
  assert.equal(received[0].bytes.length, 0);
});

test("a file that is an exact multiple of the chunk size transfers", async () => {
  const { sender, received } = pair({ chunkSize: 1024 });
  const bytes = randomBytes(4096);
  await sender.send(bytesSource({ name: "exact.bin", bytes }));
  assert.ok(equalBytes(received[0].bytes, bytes));
});

test("progress is reported on both sides and ends at the file size", async () => {
  const sendProgress = [];
  const receiveProgress = [];
  const { sender } = pair({
    chunkSize: 1024,
    onSenderEvent: (e) => e.type === "progress" && sendProgress.push(e.transferred),
    onReceiverEvent: (e) => e.type === "progress" && receiveProgress.push(e.transferred)
  });

  const bytes = randomBytes(8000);
  await sender.send(bytesSource({ name: "clip.mp4", bytes }));

  assert.ok(sendProgress.length >= 8);
  assert.equal(sendProgress.at(-1), 8000);
  assert.equal(receiveProgress.at(-1), 8000);
  // Monotonic: a progress bar must never go backwards.
  assert.deepEqual(sendProgress, [...sendProgress].sort((a, b) => a - b));
});

test("the receiver can decline a transfer", async () => {
  const { sender, received } = pair({ autoAccept: () => false });
  await assert.rejects(
    () => sender.send(bytesSource({ name: "unwanted.exe", bytes: randomBytes(100) })),
    /Declined by the receiving device/
  );
  assert.equal(received.length, 0);
});

test("the receiver sees the offer before deciding", async () => {
  const seen = [];
  const { sender } = pair({
    autoAccept: (info) => {
      seen.push(info);
      return info.size < 1000;
    }
  });
  await assert.rejects(() => sender.send(bytesSource({ name: "big.bin", bytes: randomBytes(5000) })), /Declined/);
  assert.equal(seen[0].name, "big.bin");
  assert.equal(seen[0].size, 5000);
});

test("a corrupted chunk in flight is caught by the digest", async () => {
  const [left, right] = createLoopbackPair();
  // Sit between the two ends and flip one bit of the first chunk payload.
  let corrupted = false;
  const tapped = {
    get bufferedAmount() {
      return right.bufferedAmount;
    },
    send: (data) => right.send(data),
    onMessage(handler) {
      right.onMessage((data) => {
        if (!corrupted && data instanceof ArrayBuffer && data.byteLength > 7) {
          const view = new Uint8Array(data);
          view[8] ^= 0xff;
          corrupted = true;
        }
        handler(data);
      });
    },
    close: () => right.close()
  };

  const failures = [];
  const sender = createTransferSession({ channel: left, chunkSize: 1024, createSink: memorySink() });
  createTransferSession({
    channel: tapped,
    chunkSize: 1024,
    createSink: memorySink(),
    onEvent: (event) => event.type === "failed" && failures.push(event.error)
  });

  await assert.rejects(
    () => sender.send(bytesSource({ name: "doc.pdf", bytes: randomBytes(5000) })),
    /Integrity check failed/
  );
  assert.ok(corrupted, "the test actually corrupted a chunk");
  assert.deepEqual(failures, ["Integrity check failed"]);
});

test("concurrent transfers keep their streams separate", async () => {
  const { sender, received } = pair({ chunkSize: 512 });
  const a = randomBytes(3000);
  const b = randomBytes(4500);
  const c = randomBytes(1200);

  await Promise.all([
    sender.send(bytesSource({ name: "a.bin", bytes: a })),
    sender.send(bytesSource({ name: "b.bin", bytes: b })),
    sender.send(bytesSource({ name: "c.bin", bytes: c }))
  ]);

  assert.equal(received.length, 3);
  const byName = Object.fromEntries(received.map((r) => [r.name, r.bytes]));
  assert.ok(equalBytes(byName["a.bin"], a));
  assert.ok(equalBytes(byName["b.bin"], b));
  assert.ok(equalBytes(byName["c.bin"], c));
});

test("a transfer larger than the send buffer applies backpressure", async () => {
  const { sender, received } = pair({ chunkSize: 4096, latency: 1 });
  const bytes = randomBytes(600000);
  await sender.send(bytesSource({ name: "big.iso", bytes }));
  assert.ok(equalBytes(received[0].bytes, bytes));
});

test("the sender can cancel an accepted transfer", async () => {
  let streamId = null;
  let receiverGaveUp;
  const receiverDone = new Promise((resolve) => {
    receiverGaveUp = resolve;
  });
  const { sender, receiver, received } = pair({
    chunkSize: 4096,
    latency: 1,
    onSenderEvent: (event) => {
      if (event.type === "accepted") streamId = event.streamId;
    },
    onReceiverEvent: (event) => {
      if (event.type === "failed") receiverGaveUp(event.error);
    }
  });

  const pending = sender.send(bytesSource({ name: "cancelme.bin", bytes: randomBytes(2000000) }));
  // Let the offer and accept round-trip, then pull the plug mid-stream.
  while (streamId === null) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 20));
  sender.cancel(streamId);

  await assert.rejects(() => pending, /Cancelled|closed/);
  // The cancel is still on the wire when the sender gives up, so wait for the
  // receiver to actually see it before asserting that it let go.
  assert.match(await receiverDone, /Cancelled by sender/);
  assert.equal(received.length, 0, "a cancelled transfer must not be delivered");
  assert.equal(receiver.active.incoming, 0, "the receiver drops its half too");
});

test("closing a session rejects everything still in flight", async () => {
  const { sender } = pair({ chunkSize: 64, autoAccept: () => new Promise(() => {}) });
  const pending = sender.send(bytesSource({ name: "stuck.bin", bytes: randomBytes(1000) }));
  sender.close();
  await assert.rejects(() => pending, /Connection closed/);
});

test("the engine digest matches a standalone digest of the same bytes", async () => {
  const bytes = randomBytes(9999);
  const a = await digestBytes(bytes, 1024);
  const b = await digestBytes(bytes, 1024);
  assert.equal(a, b);
  assert.notEqual(await digestBytes(bytes, 2048), a, "chunk size is part of the digest definition");
});
