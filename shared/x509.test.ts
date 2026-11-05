import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { X509Certificate, createPublicKey, createHash } from "node:crypto";
import { generateSigningKeys, spkiFingerprint, type SigningKeys } from "./connCrypto.js";
import { PROFILES } from "./cryptoProfile.js";
import { selfSignedCertPem } from "./x509.js";

const EKM_LABEL = "agent-uplink-conn-v1";

function startServer(k: SigningKeys, opts: Partial<tls.TlsOptions> = {}): Promise<{ srv: tls.Server; port: number; ekm: Promise<Buffer> }> {
  let gotEkm!: (b: Buffer) => void;
  const ekm = new Promise<Buffer>((r) => { gotEkm = r; });
  const srv = tls.createServer({
    key: k.privateKeyPem,
    cert: selfSignedCertPem(k, "agent-uplink", Date.now()),
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ciphers: PROFILES["tls13-chacha20"].tlsCipher,
    ...opts,
  }, (s) => { gotEkm(s.exportKeyingMaterial(32, EKM_LABEL, Buffer.alloc(0))); s.on("error", () => {}); });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, port: (srv.address() as { port: number }).port, ekm })));
}

test("cert_parses_and_self_verifies: 자체 서명 인증서가 파싱되고 자기 키로 검증된다", () => {
  const k = generateSigningKeys();
  const x = new X509Certificate(selfSignedCertPem(k, "agent-uplink", Date.now()));
  const pub = createPublicKey({ key: Buffer.from(k.publicKeyB64, "base64"), format: "der", type: "spki" });
  assert.equal(x.verify(pub), true);
  assert.equal(x.subject, "CN=agent-uplink");
  assert.equal(x.publicKey.export({ type: "spki", format: "der" }).toString("base64"), k.publicKeyB64);
  assert.ok(new Date(x.validFrom).getTime() <= Date.now());
});

test("tls13_pinned_profile_and_ekm: TLS 1.3·고른 암호·고정 지문 일치·EKM 양쪽 동일", async () => {
  const k = generateSigningKeys();
  const { srv, port, ekm } = await startServer(k);
  try {
    const sock = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ciphers: PROFILES["tls13-chacha20"].tlsCipher });
    await new Promise<void>((res, rej) => { sock.once("secureConnect", () => res()); sock.once("error", rej); });
    const peer = sock.getPeerX509Certificate()!;
    const peerFp = createHash("sha256").update(peer.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    assert.equal(peerFp, spkiFingerprint(k.publicKeyB64));
    assert.equal(sock.getProtocol(), "TLSv1.3");
    assert.equal(sock.getCipher().standardName, "TLS_CHACHA20_POLY1305_SHA256");
    const clientEkm = sock.exportKeyingMaterial(32, EKM_LABEL, Buffer.alloc(0));
    assert.equal(clientEkm.equals(await ekm), true);
    sock.destroy();
  } finally {
    srv.close();
  }
});

test("RT-C1_client_refuses_tls12: TLS 1.2만 하는 서버에는 연결되지 않는다", async () => {
  const k = generateSigningKeys();
  const { srv, port } = await startServer(k, { minVersion: "TLSv1.2", maxVersion: "TLSv1.2", ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384" });
  try {
    const sock = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    const outcome = await new Promise<string>((res) => {
      sock.once("secureConnect", () => res("connected"));
      sock.once("error", () => res("error"));
    });
    assert.equal(outcome, "error");
    sock.destroy();
  } finally {
    srv.close();
  }
});
