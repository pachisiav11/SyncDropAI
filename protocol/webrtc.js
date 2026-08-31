// WebRTC transport.
//
// The signaling server relays the offer/answer, so it is in a position to swap
// them and put itself in the middle. It cannot: each description is signed with
// the sender identity key, and the DTLS fingerprint that decides who the media
// path actually terminates on lives inside the signed bytes. A tampered SDP
// fails verification before it ever reaches setRemoteDescription.
//
// Data channels are available in every runtime this app ships into, and - unlike
// a plain HTTP call to a LAN address - a WebRTC connection from an https page to
// a peer on 192.168.x.x is not blocked as mixed content. That is what lets the
// phone stay a normal web app while still transferring at LAN speed.

import { CONTEXT, P2P_BUFFER_LOW } from "./constants.js";
import { signContext, verifyContext } from "./identity.js";

export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" }
];

const CHANNEL_LABEL = "syncdrop";
const CONNECT_TIMEOUT_MS = 30000;

export async function signDescription(identity, description) {
  const payload = { kind: description.type, sdp: description.sdp };
  return { ...payload, sig: await signContext(identity, CONTEXT.sdp, payload) };
}

export async function verifyDescription(peer, message) {
  const { sig, kind, sdp } = message ?? {};
  if (!sig || !kind || !sdp) throw new Error("Unsigned session description");
  const ok = await verifyContext(peer.idKey, CONTEXT.sdp, { kind, sdp }, sig);
  if (!ok) throw new Error("Session description signature does not match the paired device");
  return { type: kind, sdp };
}

// Which path the connection actually took, for the UI to report honestly.
// host/host means the bytes never left the local network.
export function describeCandidatePair(pair) {
  if (!pair) return { route: "unknown", label: "Connected" };
  const local = pair.localCandidateType ?? pair.local?.candidateType;
  const remote = pair.remoteCandidateType ?? pair.remote?.candidateType;
  if (local === "relay" || remote === "relay") return { route: "relay", label: "Relayed (TURN)" };
  if (local === "host" && remote === "host") return { route: "lan", label: "Direct on your network" };
  return { route: "p2p", label: "Direct over the internet" };
}

export function createRtcTransport({
  identity,
  peer,
  signaling,
  initiator,
  iceServers = DEFAULT_ICE_SERVERS,
  timeoutMs = CONNECT_TIMEOUT_MS,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  onState = () => {}
}) {
  if (!RTCPeerConnectionImpl) throw new Error("This runtime has no WebRTC support");

  const connection = new RTCPeerConnectionImpl({ iceServers, bundlePolicy: "max-bundle" });
  const handlers = [];
  let channel = null;
  let settled = false;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (error) rejectReady(error);
    else resolveReady(adapter);
  };

  const timer = setTimeout(
    () => finish(new Error("Timed out waiting for a direct connection")),
    timeoutMs
  );

  function attach(dataChannel) {
    channel = dataChannel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      clearTimeout(timer);
      onState("open");
      finish();
    };
    channel.onmessage = (event) => {
      for (const handler of handlers) handler(event.data);
    };
    channel.onclose = () => {
      onState("closed");
      finish(new Error("Data channel closed before it opened"));
    };
    channel.onerror = () => onState("error");
  }

  connection.onicecandidate = (event) => {
    // Candidates are routing hints only. The DTLS fingerprint inside the signed
    // description is what authenticates the far end, so an injected candidate
    // can misroute a connection attempt but cannot terminate one.
    if (event.candidate) signaling.signal(peer.deviceId, { kind: "candidate", candidate: event.candidate.toJSON() });
  };

  connection.onconnectionstatechange = () => {
    const state = connection.connectionState;
    onState(state);
    if (state === "failed" || state === "closed") finish(new Error(`Connection ${state}`));
  };

  if (initiator) attach(connection.createDataChannel(CHANNEL_LABEL, { ordered: true }));
  else connection.ondatachannel = (event) => attach(event.channel);

  const adapter = {
    connection,
    get bufferedAmount() {
      return channel?.bufferedAmount ?? 0;
    },
    send(data) {
      if (!channel || channel.readyState !== "open") throw new Error("Data channel is not open");
      channel.send(data);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    // Lets the transfer engine wait on the transport instead of polling it.
    whenDrained() {
      if (!channel || channel.bufferedAmount <= P2P_BUFFER_LOW) return Promise.resolve();
      return new Promise((resolve) => {
        channel.bufferedAmountLowThreshold = P2P_BUFFER_LOW;
        const onLow = () => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        channel.addEventListener("bufferedamountlow", onLow);
      });
    },
    close() {
      clearTimeout(timer);
      try {
        channel?.close();
      } finally {
        connection.close();
      }
    },
    // Reports how the connection was actually established, so the UI can say
    // "direct on your network" instead of guessing.
    async route() {
      if (!connection.getStats) return describeCandidatePair(null);
      const stats = await connection.getStats();
      let selected = null;
      const byId = new Map();
      stats.forEach((report) => byId.set(report.id, report));
      stats.forEach((report) => {
        const isSelected =
          report.type === "candidate-pair" && (report.selected || report.state === "succeeded" && report.nominated);
        if (isSelected && !selected) selected = report;
      });
      if (!selected) return describeCandidatePair(null);
      return describeCandidatePair({
        localCandidateType: byId.get(selected.localCandidateId)?.candidateType,
        remoteCandidateType: byId.get(selected.remoteCandidateId)?.candidateType
      });
    }
  };

  async function handleSignal(payload) {
    if (payload.kind === "candidate") {
      // Candidates can arrive before the remote description is set; the browser
      // queues them itself once a remote description exists, and throws before.
      try {
        await connection.addIceCandidate(payload.candidate);
      } catch {
        // A candidate we cannot use is not fatal - ICE has others to try.
      }
      return;
    }

    const description = await verifyDescription(peer, payload);
    await connection.setRemoteDescription(description);

    if (description.type === "offer") {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      signaling.signal(peer.deviceId, await signDescription(identity, connection.localDescription));
    }
  }

  async function start() {
    if (!initiator) return ready;
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    signaling.signal(peer.deviceId, await signDescription(identity, connection.localDescription));
    return ready;
  }

  return { adapter, ready, start, handleSignal, route: () => adapter.route(), close: adapter.close };
}
