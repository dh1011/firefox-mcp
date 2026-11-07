/** The pairing crypto, with the daemon's real signing (Node) against the extension's verification (WebCrypto) */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  pairingCode,
  pairingCommitment,
  pairingPayload,
  randomNonce,
  revealedPairingCode,
  verifyDaemonSignature,
} from "../../src/protocol";
import { loadIdentity, signPayload } from "../../src/server/paths";

function withIdentity<T>(run: (identity: ReturnType<typeof loadIdentity>) => Promise<T>) {
  const home = mkdtempSync(path.join(tmpdir(), "firefox-mcp-unit-"));
  return run(loadIdentity(home)).finally(() => rmSync(home, { recursive: true, force: true }));
}

describe("the daemon's identity", () => {
  it("is kept across restarts", () => {
    const home = mkdtempSync(path.join(tmpdir(), "firefox-mcp-unit-"));
    try {
      assert.equal(loadIdentity(home).publicKey, loadIdentity(home).publicKey);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("verifies only for the right key, challenge, port and commitment", () =>
    withIdentity(async (identity) => {
      const challenge = randomNonce();
      const commitment = await pairingCommitment(randomNonce());
      const signature = signPayload(identity, pairingPayload(challenge, 9320, commitment));
      const base = { challenge, port: 9320, publicKey: identity.publicKey, commitment, signature };
      assert.equal(await verifyDaemonSignature(base), true);
      // A program on another port relaying the challenge to the real daemon
      assert.equal(await verifyDaemonSignature({ ...base, port: 9321 }), false);
      assert.equal(await verifyDaemonSignature({ ...base, challenge: randomNonce() }), false);
      assert.equal(await verifyDaemonSignature({ ...base, commitment: await pairingCommitment(randomNonce()) }), false);
      await withIdentity(async (other) => {
        assert.equal(await verifyDaemonSignature({ ...base, publicKey: other.publicKey }), false);
      });
      assert.equal(await verifyDaemonSignature({ ...base, signature: "bad" }), false);
      assert.equal(await verifyDaemonSignature({ ...base, publicKey: "bad" }), false);
      assert.equal(await verifyDaemonSignature({ ...base, commitment: "" }), false);
    }));
});

describe("the pairing code", () => {
  it("is six digits, the same on both sides", async () => {
    const [key, ext, daemon] = ["key", randomNonce(), randomNonce()] as const;
    const code = await pairingCode(key, ext, daemon);
    assert.match(code, /^\d{3} \d{3}$/);
    const shown = await revealedPairingCode({
      publicKey: key,
      commitment: await pairingCommitment(daemon),
      extensionNonce: ext,
      daemonNonce: daemon,
    });
    assert.equal(shown, code);
  });

  it("is fresh for each connection", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add(await pairingCode("key", randomNonce(), randomNonce()));
    assert.ok(codes.size > 15);
  });

  it("fails when the reveal doesn't match the commitment", async () => {
    const options = {
      publicKey: "key",
      commitment: await pairingCommitment(randomNonce()),
      extensionNonce: randomNonce(),
    };
    assert.equal(await revealedPairingCode({ ...options, daemonNonce: randomNonce() }), null);
    assert.equal(await revealedPairingCode({ ...options, daemonNonce: 42 }), null);
    assert.equal(await revealedPairingCode({ ...options, daemonNonce: "not base64!!" }), null);
  });
});
