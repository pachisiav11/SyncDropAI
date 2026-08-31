# SyncDrop v2 — Rebuild (P2P + encrypted relay)

Architecture: paired device keypairs (no accounts), WebRTC data-channel P2P
with LAN-direct, and an end-to-end-encrypted store-and-forward relay so only
the sender needs to be awake.

## Phases

- [x] 2026-08-31 10:00: Phase 1 — protocol core (crypto, identity, pairing, wire, chunker)
- [x] 2026-08-31 10:00: Phase 2 — signaling + mailbox + blob server (Node self-host/dev)
- [x] 2026-08-31 10:00: Phase 3 — transfer engine over transport-agnostic channel
- [x] 2026-08-31 10:00: Phase 4 — WebRTC P2P transport
- [x] 2026-08-31 10:00: Phase 5 — encrypted relay transport (store-and-forward)
- [x] 2026-08-31 10:00: Phase 6 — transport orchestrator (P2P first, relay fallback)
- [x] 2026-08-31 10:00: Phase 7 — app UI + PWA (pairing, devices, send, progress)
- [x] 2026-08-31 10:00: Phase 8 — Tauri desktop shell (DPAPI vault, native saves, AI naming on send)
- [x] 2026-08-31 10:00: Phase 9 — CLI rewrite on the new protocol
- [x] 2026-08-31 10:00: Phase 10 — Cloudflare Worker + R2 + Durable Objects production server
- [x] 2026-08-31 10:00: Phase 11 — docs, browser end-to-end verification, final push
