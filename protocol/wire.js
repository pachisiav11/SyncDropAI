// Framing for the peer-to-peer data channel.
//
// A WebRTC data channel carries both strings and binary, so control traffic is
// JSON strings and file bytes are binary frames. That split means the receiver
// never has to parse a header to find out which it is holding, and file bytes
// never pay for base64.
//
// Binary frame layout (little-endian, 7-byte header):
//   u8   frame version
//   u16  stream id   - which concurrent transfer this chunk belongs to
//   u32  sequence    - chunk index within that stream, from 0
//   ...  payload

import { toBytes } from "./util.js";

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 7;

export function encodeControl(message) {
  return JSON.stringify(message);
}

export function decodeControl(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("Malformed control message");
  }
  return parsed;
}

export function encodeChunk(streamId, sequence, payload) {
  const body = toBytes(payload);
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint16(1, streamId, true);
  view.setUint32(3, sequence, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}

export function decodeChunk(data) {
  const bytes = toBytes(data);
  if (bytes.length < HEADER_BYTES) throw new Error("Chunk frame is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) throw new Error(`Unsupported frame version ${version}`);
  return {
    streamId: view.getUint16(1, true),
    sequence: view.getUint32(3, true),
    // Subarray, not slice: the payload is handed straight to the file writer
    // and copying every chunk would double the memory traffic of a transfer.
    payload: bytes.subarray(HEADER_BYTES)
  };
}

export function isBinaryFrame(data) {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}
