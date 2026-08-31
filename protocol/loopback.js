// An in-process pair of channels that behave like the two ends of a data
// channel. The tests drive the full transfer state machine through this without
// a browser or a network.
//
// The latency and bufferLimit knobs exist so tests can exercise the backpressure
// path, which is otherwise unreachable on a zero-latency link.

export function createLoopbackPair({ latency = 0, bufferLimit = Infinity } = {}) {
  const state = {
    a: { handlers: [], buffered: 0 },
    b: { handlers: [], buffered: 0 },
    closed: false
  };

  function endpoint(selfKey, otherKey) {
    const self = state[selfKey];
    const other = state[otherKey];
    return {
      get bufferedAmount() {
        return self.buffered;
      },
      send(data) {
        if (state.closed) throw new Error("Channel is closed");
        const size = typeof data === "string" ? data.length : data.byteLength;
        if (self.buffered + size > bufferLimit) throw new Error("Send buffer overflow");
        self.buffered += size;
        // Binary arrives as an ArrayBuffer on a real data channel, and the
        // engine hands us a view over a reused buffer, so copy before queueing.
        const payload = typeof data === "string" ? data : data.slice().buffer;
        const deliver = () => {
          self.buffered -= size;
          if (state.closed) return;
          for (const handler of other.handlers) handler(payload);
        };
        if (latency > 0) setTimeout(deliver, latency);
        else queueMicrotask(deliver);
      },
      onMessage(handler) {
        self.handlers.push(handler);
      },
      close() {
        state.closed = true;
      }
    };
  }

  // Each endpoint reads from its own handler list and writes into the other.
  const a = endpoint("a", "b");
  const b = endpoint("b", "a");
  return [a, b];
}
