# SyncDrop

Send a file from your phone to your PC, or from your PC to your phone, by
picking the device and pressing send. No account, no sign-in, no upload to
somebody else's drive and back down again.

When both devices are awake the file goes **straight between them** — on the
same Wi-Fi it never leaves the building. When the other device is asleep the
file is encrypted on the sender and parked on a relay, and the relay hands it
over the next time that device wakes up. The relay cannot read it. It cannot
even tell you what the file is called.

---

## Why it works this way

The first version of SyncDrop had accounts. Every device signed in, held a
token, and refreshed it in the background. That model has a failure mode you
cannot engineer away: a token expires, or two processes rotate the same refresh
token and one of them loses the race, and the device is signed out. The user did
nothing wrong and there is nothing to fix except signing in again.

So the account is gone. A device's identity is a **keypair it generates on first
run and never sends anywhere**. To prove who it is, it signs a challenge. That
signature cannot expire, cannot be revoked by a server, and cannot go stale
while the laptop is closed. There is no session to lose, because there is no
session.

Two devices become "paired" when a six-word code is read off one screen and
typed into the other. From then on they know each other's public keys, and
everything between them is encrypted to those keys.

---

## Pairing

One device shows a code:

```
brave-otter-marble-forest-quiet-anchor
```

The other device types it. Both sides run the code through a slow key
derivation and land in the same rendezvous room on the server. Inside that room
they exchange public keys and each proves it knew the code, by sending an HMAC
over a transcript of both keys.

The server relays those two messages and learns nothing useful from them. It
never sees the code, and it cannot substitute its own key for either side —
the confirmation tag would not match, and both devices would refuse. The room
closes ten minutes after it opens.

After pairing, the code is worthless. It is not a password and it is never
used again.

---

## How a file gets across

SyncDrop tries three routes, in this order, and tells you which one it used.

**1. Direct, on your network.** Both devices are on the same Wi-Fi, so WebRTC
finds the local address and opens a data channel between them. Nothing leaves
the LAN. This is the fast path, and on a home network it is roughly as fast as
the network is.

**2. Direct, over the internet.** Different networks, both awake. WebRTC punches
through the routers and the file still goes device to device — the server only
introduced them.

**3. The encrypted relay.** The other device is asleep, or the network refuses
to cooperate. The sender derives a fresh key for this one transfer, encrypts the
file in parts, and uploads the ciphertext. The recipient picks it up whenever it
next comes online, decrypts it, and the relay deletes its copy.

Route 3 is why **only the sender needs to be awake**. You can send a file to
your desktop from the train, close your phone, and the file is on the desktop
when you get home.

---

## What the server can and cannot see

The relay is not trusted, and the design does not ask you to trust it.

It can see: which device ids talk to each other, how many bytes moved, and
when. That is unavoidable for anything that routes traffic.

It cannot see: the file, the filename, the file type, or any key. Filenames are
sealed inside the encrypted envelope along with the content — the server holds
numbered parts of ciphertext and a recipient id, and nothing else. There is a
test that asserts exactly this: the server is asked for everything it has about
a stored transfer, and the filename does not appear anywhere in the answer.

Content keys are derived per transfer from an ephemeral key agreement, so a
device key that leaks tomorrow does not decrypt the transfers you sent today.

---

## Running it

```bash
npm install
```

### The web app

```bash
npm run dev
```

It is a PWA, so it installs to a phone home screen from the browser menu and
registers as a share target — "Share → SyncDrop" from any Android app.

### The desktop app (Windows)

```bash
npm run tauri:dev
```

Tauri, so the shell is Rust and the UI is the same web app running in WebView2 —
around 10 MB rather than the 150 MB an Electron build costs. Three things the
browser cannot do live in the Rust side:

- the device's private key is sealed with DPAPI, encrypted to your Windows
  account, instead of sitting in browser storage
- received files stream straight to a folder you choose
- the local vision model that names files by their content runs in-process

Build an installer with `npm run tauri:build`.

### Android

```bash
npm run build
npm run cap:sync
npm run cap:open:android
```

### The command line

```bash
npm link          # puts `syncdrop` on your PATH
syncdrop pair     # shows a code; type it into the app
syncdrop send report.pdf --to desk
syncdrop receive --watch
```

The CLI is a device like any other — it has its own keypair and appears in the
app's device list. Node has no WebRTC, so a CLI transfer always takes the
encrypted relay.

---

## Running your own server

The server does two things: it introduces devices to each other, and it holds
encrypted parts for a device that is asleep. It has no database, no user table,
and no secrets to configure, because there are no accounts to store.

**On your own machine, a VPS, or a Pi:**

```bash
npm run serve
```

That serves the rendezvous socket, the relay API, and the built app from one
process. Point `SYNCDROP_DATA` at a directory to keep queued transfers across
restarts.

**On Cloudflare:**

```bash
npx wrangler r2 bucket create syncdrop-blobs
npm run build
npx wrangler deploy
```

One deploy puts the app and the relay on the same origin. The parts live in R2;
the state lives in Durable Objects, one per device, one per pairing room, one
per queued transfer. Nothing is central: two devices that talk to each other
never touch an object that a third device also touches, so adding devices adds
objects rather than load. Each queued transfer sets its own expiry alarm and
deletes its own bytes, so nothing has to sweep anything.

The rules that decide who may read a blob or claim a mailbox entry are the same
file (`server/core.js`) in both hosts. There is only one copy of that logic, so
there is only one copy to get right.

---

## Layout

```
protocol/     the whole protocol: identity, pairing, transfer, transports.
              No DOM and no node: imports, so the browser, Node, and the
              Worker all run the same bytes.
server/       core.js is host-agnostic. node.js self-hosts. worker/ is
              Cloudflare.
app/          the web app and PWA.
src-tauri/    the Windows shell.
cli/          the terminal client.
test/         node --test. Real WebRTC, real workerd, real files on disk.
```

## Tests

```bash
npm test
```

The suite is not made of mocks. Transfers are checked byte for byte, the
Cloudflare host runs on the actual workerd runtime with real Durable Objects
and a real R2 bucket, and the tests that matter most are the adversarial ones:
a forged signature, a stale timestamp, a device reading another device's
mailbox, a corrupted chunk in flight, a server asked to name a file it is
holding.
