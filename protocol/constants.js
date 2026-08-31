// Protocol-wide constants. Anything both ends must agree on byte-for-byte lives
// here so a mismatch is a one-line diff rather than a hunt through the stack.

export const PROTOCOL_VERSION = 2;

// Domain-separation strings. Every signature, MAC, and derived key is bound to
// exactly one of these, so a value produced for one purpose can never be
// replayed as a valid value for another.
export const CONTEXT = {
  hello: "syncdrop/v2/pair-hello",
  confirm: "syncdrop/v2/pair-confirm",
  room: "syncdrop/v2/pair-room",
  pairKey: "syncdrop/v2/pair-key",
  auth: "syncdrop/v2/signal-auth",
  sdp: "syncdrop/v2/sdp-bind",
  relayContent: "syncdrop/v2/relay-content",
  relayMeta: "syncdrop/v2/relay-meta",
  mailbox: "syncdrop/v2/mailbox"
};

export const PAIR_CODE_CHARS = 12;
// PBKDF2 rounds for turning a pairing code into a rendezvous room id. The room
// id is visible to the signaling server, so this cost is what stops an operator
// from dictionary-attacking the 60-bit code offline and joining the exchange.
export const PAIR_ROOM_ROUNDS = 210000;
export const PAIR_TTL_MS = 5 * 60 * 1000;

// WebRTC data channels are reliable but message-oriented; 64 KiB is comfortably
// inside every Chromium-family limit while still saturating a LAN link.
export const P2P_CHUNK_SIZE = 64 * 1024;
export const P2P_BUFFER_HIGH = 4 * 1024 * 1024;
export const P2P_BUFFER_LOW = 1 * 1024 * 1024;

// Relay parts are large because each one is a separate HTTP request against
// object storage; 8 MiB clears R2 multipart minimums with room to spare.
export const RELAY_PART_SIZE = 8 * 1024 * 1024;
export const RELAY_TTL_DAYS = 7;

export const FRAME = { CONTROL: 0, CHUNK: 1 };

export const TRANSFER_STATE = {
  pending: "pending",
  offered: "offered",
  accepted: "accepted",
  sending: "sending",
  receiving: "receiving",
  complete: "complete",
  failed: "failed",
  rejected: "rejected"
};
