// The transfer engine.
//
// Deliberately knows nothing about WebRTC. It talks to a Channel - anything
// with send/onMessage/bufferedAmount - so the identical state machine drives a
// data channel, a loopback pair in tests, and any future transport. That is
// what makes the P2P path testable without a browser.
//
// Wire discipline: control messages are JSON strings, payload is binary frames.
// The receiver never guesses which it is holding.

import { P2P_BUFFER_HIGH, P2P_BUFFER_LOW, P2P_CHUNK_SIZE, TRANSFER_STATE } from "./constants.js";
import { createChunkDigest } from "./digest.js";
import { decodeChunk, decodeControl, encodeChunk, encodeControl, isBinaryFrame } from "./wire.js";
import { now, shortId } from "./util.js";

const MAX_STREAM_ID = 0xffff;

function chunkCount(size, chunkSize) {
  return size === 0 ? 1 : Math.ceil(size / chunkSize);
}

// Smooths the instantaneous rate so the UI does not flicker between 4 MB/s and
// 40 MB/s while the transport drains its buffer.
function createRateMeter() {
  let last = now();
  let lastBytes = 0;
  let rate = 0;
  return (transferred) => {
    const at = now();
    const elapsed = at - last;
    if (elapsed >= 250) {
      const instant = ((transferred - lastBytes) * 1000) / elapsed;
      rate = rate === 0 ? instant : rate * 0.7 + instant * 0.3;
      last = at;
      lastBytes = transferred;
    }
    return rate;
  };
}

export function createTransferSession({
  channel,
  chunkSize = P2P_CHUNK_SIZE,
  autoAccept = () => true,
  createSink,
  onEvent = () => {}
}) {
  const outgoing = new Map();
  const incoming = new Map();
  let nextStreamId = 1;
  let closed = false;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // A throwing UI callback must not tear down an in-flight transfer.
    }
  };

  const control = (message) => channel.send(encodeControl(message));

  function allocateStreamId() {
    for (let i = 0; i <= MAX_STREAM_ID; i += 1) {
      nextStreamId = (nextStreamId % MAX_STREAM_ID) + 1;
      if (!outgoing.has(nextStreamId)) return nextStreamId;
    }
    throw new Error("No free stream id: too many concurrent transfers");
  }

  // Wait for the transport to drain before queueing more. Without this a large
  // file is read into the send buffer as fast as the disk allows and the app
  // dies on memory rather than on bandwidth.
  function drain() {
    if (channel.bufferedAmount < P2P_BUFFER_HIGH) return Promise.resolve();
    // A real data channel can tell us the moment it has drained; polling adds
    // up to a tick of dead air to every buffer cycle of a large transfer.
    if (channel.whenDrained) return channel.whenDrained();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (closed || channel.bufferedAmount <= P2P_BUFFER_LOW) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
  }

  async function pumpChunks(entry) {
    const { source, streamId } = entry;
    const digest = createChunkDigest();
    const meter = createRateMeter();
    const total = chunkCount(source.size, chunkSize);

    for (let index = entry.resumeFrom; index < total; index += 1) {
      if (entry.cancelled) throw new Error("Cancelled");
      const offset = index * chunkSize;
      const bytes = await source.readChunk(offset, Math.min(chunkSize, source.size - offset));
      await digest.update(index, bytes);
      await drain();
      if (entry.cancelled) throw new Error("Cancelled");
      channel.send(encodeChunk(streamId, index, bytes));
      entry.transferred = Math.min(source.size, offset + bytes.length);
      emit({
        type: "progress",
        direction: "send",
        streamId,
        id: entry.id,
        name: source.name,
        transferred: entry.transferred,
        total: source.size,
        rate: meter(entry.transferred)
      });
    }

    // Chunks the receiver already had on a resume never passed through this
    // digest, so only claim one when the whole file went out on this attempt.
    entry.digest = entry.resumeFrom === 0 ? await digest.final() : null;
    control({ type: "done", streamId, digest: entry.digest });
  }

  async function beginSend(source, meta = {}) {
    const streamId = allocateStreamId();
    const id = meta.id ?? shortId(16);
    const entry = {
      id,
      streamId,
      source,
      meta,
      state: TRANSFER_STATE.offered,
      transferred: 0,
      resumeFrom: 0,
      cancelled: false
    };
    outgoing.set(streamId, entry);

    entry.settled = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    control({
      type: "offer",
      streamId,
      id,
      name: source.name,
      size: source.size,
      mime: source.mime ?? "application/octet-stream",
      chunkSize,
      chunks: chunkCount(source.size, chunkSize),
      meta: meta.extra ?? null
    });
    emit({ type: "offered", direction: "send", streamId, id, name: source.name, total: source.size });
    return entry;
  }

  async function handleControl(message) {
    const entry = outgoing.get(message.streamId);
    const arriving = incoming.get(message.streamId);

    switch (message.type) {
      case "offer": {
        if (incoming.has(message.streamId)) return;
        const info = {
          id: message.id,
          streamId: message.streamId,
          name: message.name,
          size: message.size,
          mime: message.mime,
          chunkSize: message.chunkSize,
          chunks: message.chunks,
          meta: message.meta ?? null
        };
        emit({ type: "offered", direction: "receive", ...info, total: info.size });

        let accepted = false;
        try {
          accepted = await autoAccept(info);
        } catch {
          accepted = false;
        }
        if (!accepted) {
          control({ type: "reject", streamId: info.streamId, reason: "Declined by the receiving device" });
          emit({ type: "rejected", direction: "receive", ...info });
          return;
        }

        const sink = await createSink(info);
        incoming.set(info.streamId, {
          ...info,
          sink,
          digest: createChunkDigest(),
          received: 0,
          transferred: 0,
          meter: createRateMeter(),
          state: TRANSFER_STATE.receiving
        });
        control({ type: "accept", streamId: info.streamId, resumeFrom: sink.resumeFrom ?? 0 });
        return;
      }

      case "accept": {
        if (!entry) return;
        entry.state = TRANSFER_STATE.sending;
        entry.resumeFrom = Number(message.resumeFrom) || 0;
        entry.transferred = Math.min(entry.source.size, entry.resumeFrom * chunkSize);
        emit({ type: "accepted", direction: "send", streamId: entry.streamId, id: entry.id, name: entry.source.name });
        pumpChunks(entry).catch((error) => {
          control({ type: "error", streamId: entry.streamId, message: error.message });
          entry.state = TRANSFER_STATE.failed;
          outgoing.delete(entry.streamId);
          emit({ type: "failed", direction: "send", streamId: entry.streamId, id: entry.id, error: error.message });
          entry.reject(error);
        });
        return;
      }

      case "reject": {
        if (!entry) return;
        entry.state = TRANSFER_STATE.rejected;
        outgoing.delete(entry.streamId);
        emit({ type: "rejected", direction: "send", streamId: entry.streamId, id: entry.id, reason: message.reason });
        entry.reject(new Error(message.reason || "Rejected by the receiving device"));
        return;
      }

      case "done": {
        if (!arriving) return;
        const ours = await arriving.digest.final().catch(() => null);
        const ok = !message.digest || (ours !== null && ours === message.digest);
        if (ok) {
          await arriving.sink.close();
          arriving.state = TRANSFER_STATE.complete;
          control({ type: "ack", streamId: arriving.streamId, ok: true });
          emit({
            type: "complete",
            direction: "receive",
            streamId: arriving.streamId,
            id: arriving.id,
            name: arriving.name,
            total: arriving.size,
            path: arriving.sink.path ?? null,
            result: arriving.sink.result ?? null
          });
        } else {
          await arriving.sink.abort?.();
          control({ type: "ack", streamId: arriving.streamId, ok: false, reason: "Integrity check failed" });
          emit({
            type: "failed",
            direction: "receive",
            streamId: arriving.streamId,
            id: arriving.id,
            error: "Integrity check failed"
          });
        }
        incoming.delete(arriving.streamId);
        return;
      }

      case "ack": {
        if (!entry) return;
        outgoing.delete(entry.streamId);
        if (message.ok) {
          entry.state = TRANSFER_STATE.complete;
          emit({
            type: "complete",
            direction: "send",
            streamId: entry.streamId,
            id: entry.id,
            name: entry.source.name,
            total: entry.source.size
          });
          entry.resolve({ id: entry.id, name: entry.source.name, size: entry.source.size });
        } else {
          entry.state = TRANSFER_STATE.failed;
          emit({ type: "failed", direction: "send", streamId: entry.streamId, id: entry.id, error: message.reason });
          entry.reject(new Error(message.reason || "The receiving device rejected the transfer"));
        }
        return;
      }

      case "cancel": {
        if (arriving) {
          await arriving.sink.abort?.();
          incoming.delete(arriving.streamId);
          emit({ type: "failed", direction: "receive", streamId: message.streamId, id: arriving.id, error: "Cancelled by sender" });
        }
        if (entry) {
          entry.cancelled = true;
          outgoing.delete(entry.streamId);
          entry.reject(new Error("Cancelled by the other device"));
        }
        return;
      }

      case "error": {
        if (arriving) {
          await arriving.sink.abort?.();
          incoming.delete(arriving.streamId);
          emit({ type: "failed", direction: "receive", streamId: message.streamId, id: arriving.id, error: message.message });
        }
        if (entry) {
          entry.cancelled = true;
          outgoing.delete(entry.streamId);
          emit({ type: "failed", direction: "send", streamId: message.streamId, id: entry.id, error: message.message });
          entry.reject(new Error(message.message));
        }
        return;
      }

      default:
        return;
    }
  }

  async function handleChunk(data) {
    const { streamId, sequence, payload } = decodeChunk(data);
    const arriving = incoming.get(streamId);
    if (!arriving) return;

    await arriving.digest.update(sequence, payload);
    await arriving.sink.write(sequence, payload);
    arriving.received += 1;
    arriving.transferred = Math.min(arriving.size, arriving.transferred + payload.length);
    emit({
      type: "progress",
      direction: "receive",
      streamId,
      id: arriving.id,
      name: arriving.name,
      transferred: arriving.transferred,
      total: arriving.size,
      rate: arriving.meter(arriving.transferred)
    });
  }

  // Messages must be applied strictly in the order they arrived. Both handlers
  // are async, and a transport delivers by calling this synchronously in a
  // loop, so without this chain the "done" control message can overtake chunks
  // that are still awaiting their digest and the transfer fails its own
  // integrity check. Serialising here rather than in each handler keeps that
  // guarantee in one place.
  let inbound = Promise.resolve();
  channel.onMessage((data) => {
    inbound = inbound.then(async () => {
      if (closed) return;
      try {
        if (isBinaryFrame(data)) await handleChunk(data);
        else await handleControl(decodeControl(data));
      } catch (error) {
        emit({ type: "error", error: error.message });
      }
    });
  });

  return {
    async send(source, meta) {
      const entry = await beginSend(source, meta);
      return entry.settled;
    },
    cancel(streamId) {
      const entry = outgoing.get(streamId);
      if (entry) {
        entry.cancelled = true;
        control({ type: "cancel", streamId });
        outgoing.delete(streamId);
      }
    },
    get active() {
      return { outgoing: outgoing.size, incoming: incoming.size };
    },
    close() {
      closed = true;
      for (const entry of outgoing.values()) {
        entry.cancelled = true;
        entry.reject(new Error("Connection closed"));
      }
      outgoing.clear();
      for (const arriving of incoming.values()) arriving.sink.abort?.();
      incoming.clear();
    }
  };
}
