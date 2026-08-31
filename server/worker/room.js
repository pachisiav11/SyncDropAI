// One Durable Object per pairing room.
//
// The room id is PBKDF2 over the six-word code, so this object's name is
// already the secret's shadow: only two devices that typed the same code can
// address it. The room is a letterbox and nothing more — it forwards two
// opaque payloads and never learns the code, the keys, or which device won.
//
// It keeps device ids rather than sockets, because the sockets live in the
// DeviceObjects. That also makes joining idempotent: a phone that reconnects
// mid-pairing rejoins the same slot instead of filling the room.

const MAX_OCCUPANTS = 2;
// A code is read off one screen and typed into another. Ten minutes is far more
// than that takes, and short enough that an abandoned room frees its code soon.
const ROOM_TTL_MS = 10 * 60 * 1000;

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export class PairRoomObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async occupants() {
    return (await this.state.storage.get("occupants")) ?? [];
  }

  send(deviceId, message) {
    const stub = this.env.DEVICE.get(this.env.DEVICE.idFromName(deviceId));
    return stub
      .fetch("https://do/deliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message })
      })
      .catch(() => null);
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.replace(/^\/+/, "");
    const { roomId, deviceId, payload } = await request.json().catch(() => ({}));
    if (typeof deviceId !== "string" || !deviceId) return json({ error: "Missing device id" }, 400);

    if (action === "join") return this.join(roomId, deviceId);
    if (action === "relay") return this.relay(roomId, deviceId, payload);
    if (action === "leave") return this.leave(deviceId);
    return json({ error: "No such room action" }, 404);
  }

  async join(roomId, deviceId) {
    const occupants = await this.occupants();
    if (!occupants.includes(deviceId)) {
      if (occupants.length >= MAX_OCCUPANTS) {
        await this.send(deviceId, { type: "error", message: "Pairing room is full; generate a fresh code" });
        return json({ error: "full" }, 409);
      }
      occupants.push(deviceId);
      await this.state.storage.put("occupants", occupants);
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
    // Everyone hears the new count, including the device that just arrived —
    // the client waits for two before it says hello, so both sides need it.
    const message = { type: "joined", roomId, occupants: occupants.length };
    await Promise.all(occupants.map((id) => this.send(id, message)));
    return json({ occupants: occupants.length });
  }

  async relay(roomId, deviceId, payload) {
    const occupants = await this.occupants();
    if (!occupants.includes(deviceId)) return json({ error: "Not in that pairing room" }, 403);
    const message = { type: "pair", roomId, from: deviceId, payload };
    await Promise.all(occupants.filter((id) => id !== deviceId).map((id) => this.send(id, message)));
    return json({ relayed: occupants.length - 1 });
  }

  async leave(deviceId) {
    const occupants = (await this.occupants()).filter((id) => id !== deviceId);
    if (occupants.length === 0) return this.destroy();
    await this.state.storage.put("occupants", occupants);
    return json({ occupants: occupants.length });
  }

  async destroy() {
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    return json({ occupants: 0, closed: true });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
