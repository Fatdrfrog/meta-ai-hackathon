import {
  computeWhatsAppFlowPublicKeyFingerprint,
  decryptFlowEndpointRequest,
  encryptFlowEndpointResponse,
  generateWhatsAppFlowEndpointId,
  generateWhatsAppFlowKeySet,
  importLegacyWhatsAppFlowKeySet,
  loadWhatsAppFlowKeySet,
  resolveWhatsAppFlowKeyCandidates,
  toSafeWhatsAppFlowKeyDescriptor,
} from "@/lib/whatsapp/flows/endpoint-crypto";
import crypto from "crypto";

const KNOWN_RSA_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDb93LwTfxbBP6G
KdefTYraRMmJN8zmu7kOdyDGJJWhnhdmGVJcWEHGuZYFFpP2V/KOWFXH0gfVoWAE
6wVBeiprhIs6/UuMZQqgfENG20keVP7yk/iy9v/Ejv6OnTdI5t27feqaEH609aue
UDdAB2qJOZ8/9DxwAv20h52Lnfp174IXvH1FWhu5VdZnieTyt8djnlbn8AgQiPzF
5JqT76GREgAGFCZiHYLP0ohFVsmeuDl2SZp69zyM22kpQck8g2PoHAD1hhqpcw40
UTPBIMCbV+y73LdQ06RTTOZa72reuDGythI2rkwyk6YiOeyx0vkyyqz/SGgqTh21
O8vPcq3fAgMBAAECggEAHE5T/qNyeX4DiN1Cj4/pcdwPOTayifCXSErBL25OyQzw
guV4SUTcNgf0y7PTl4xKvNGWPFAFTRLmqctakkn3wn08c3tb6PWpr+w9thUK7DnQ
0wOCqfkKAc/K5yxJDHsVBocWFPxRadUBYC5/ZaBur7j4CsFRs7JW1o/rEKfkLp/F
9zseiHphHnLzWETZQmGmJHhZGDtgJaNlWORoM/JVOEESOfwkRL0Ca+HXxIXVF1V2
uRkLN6L1eGhbLonRx+56Dl4P3WdrfYrLN9O6FrSmkNXwKeqWGRtyhcFznIqDSAKI
PLojHzxa6jw0+xTF8X5P2SJhuy2RrF/QXu5INllatQKBgQD2DGhR+tX0RljEJLs6
H0XkoNQBgMtikjboHr0xUEVN8jqXgEZNAEVbAQXWJmtlV0B7otJmwVf5/3If0K9R
tZG7atzVQB9/ExDIPBugngCbY9vly/XFRyKvwmNTHgz4R5uR/Q8NuMd1Pkfzqjcu
H0tnPsi0o0jdtMC8FhcLQF2t+wKBgQDk3P01dQQc+1tcUiF5qKl+448b2N6bDQTP
565lxyXCv3rD2Clct6J7l1z0OSDMUPt/CNoqVwIT7lNGvRfWcKPrRnejsDORne8F
rHmSo23v9YXNLPv3SI4qF1dEd2uwRW6LfDWKGpCz0MLlKxVGhmE4ooMqacUz6x46
hE4Ti72ubQKBgBhavAy5TmpCeFDZ7epf5BQwUyve6sLUBDlPqZxy/Jkti90pJkxC
5ZqPbFt5LBI447oZMMhZBPNK9KnvhxsIZOdvOXKmSTfT1EptoLJyUU8QQFjrqmUf
mHBbRmeYxuHgfKajrNTH4H5bbtXQmGupT1Zl4Yn3y6OeW6GCcj973In3AoGAHqLq
jm5kp5CKUVh5PLT0Q5UowhyM6AqdG0uzT9KR3nkNcQwNtWirqom/mr3PAyrQD9ha
hBJzp8FeinijqUQY3VTojRP4Q0T2CzdkatnPzLB8QdQEwryGs2G+f97Qnp8cxjVR
YXRe7INEo7LZvUAd4Zv3nQTdri6KNGEjpoAtWx0CgYEAoYmI8lJgQjMUfKAjDu43
Q+0NR7L9IgI5SMBnnzNcNzayNq1kGntQBpxc9SRPgEzCaaIa4DEcKLh/VazT06dn
F/wyAt/IJl2ZAKccAUFbbFXCOobE3BexndwVVQxZIlF2NIuQ2ed0tJwXOsg9V4oz
aqwacBFOxyebtohceUSnFGM=
-----END PRIVATE KEY-----
`;
const KNOWN_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2/dy8E38WwT+hinXn02K
2kTJiTfM5ru5DncgxiSVoZ4XZhlSXFhBxrmWBRaT9lfyjlhVx9IH1aFgBOsFQXoq
a4SLOv1LjGUKoHxDRttJHlT+8pP4svb/xI7+jp03SObdu33qmhB+tPWrnlA3QAdq
iTmfP/Q8cAL9tIedi536de+CF7x9RVobuVXWZ4nk8rfHY55W5/AIEIj8xeSak++h
kRIABhQmYh2Cz9KIRVbJnrg5dkmaevc8jNtpKUHJPINj6BwA9YYaqXMONFEzwSDA
m1fsu9y3UNOkU0zmWu9q3rgxsrYSNq5MMpOmIjnssdL5Msqs/0hoKk4dtTvLz3Kt
3wIDAQAB
-----END PUBLIC KEY-----
`;
const KNOWN_RSA_FINGERPRINT =
  "d195422fe98d22b1d3ffd86b696bb9d8e3c481fcac6587964b77e8bc9b124641";
const TEST_ENCRYPTION_SECRET = "task-7-flow-key-encryption-secret";

function decryptResponseForTest(
  b64: string,
  aesKey: Buffer,
  requestIv: Buffer
): unknown {
  const flippedIv = Buffer.alloc(requestIv.length);
  for (let i = 0; i < requestIv.length; i++) {
    flippedIv[i] = requestIv[i]! ^ 0xff;
  }
  const buf = Buffer.from(b64, "base64");
  const TAG_LENGTH = 16;
  const ciphertext = buf.subarray(0, -TAG_LENGTH);
  const tag = buf.subarray(-TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, flippedIv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

describe("flows/endpoint-crypto", () => {
  const originalEncryptionSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = TEST_ENCRYPTION_SECRET;
  });

  afterAll(() => {
    if (originalEncryptionSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = originalEncryptionSecret;
    }
  });

  it("decrypts request and roundtrips response encryption", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const payload = { version: "4.0", action: "ping" };

    const encryptedAesKey = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      aesKey
    );

    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
    const encFlow = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    const body = {
      encrypted_flow_data: encFlow.toString("base64"),
      encrypted_aes_key: encryptedAesKey.toString("base64"),
      initial_vector: iv.toString("base64"),
    };

    const {
      decrypted,
      aesKey: aesOut,
      iv: ivOut,
    } = decryptFlowEndpointRequest(body, privateKey);
    expect(decrypted).toEqual(payload);
    expect(aesOut.equals(aesKey)).toBe(true);
    expect(ivOut.equals(iv)).toBe(true);

    const response = { data: { status: "active" } };
    const encResp = encryptFlowEndpointResponse(response, aesOut, ivOut);
    expect(decryptResponseForTest(encResp, aesOut, ivOut)).toEqual(response);
  });

  it("generates normalized 2048-bit WABA keys from independent endpoint and signing entropy", () => {
    const endpointEntropy = Buffer.alloc(32, 0x11);
    const signingEntropy = Buffer.alloc(32, 0x22);
    const randomBytesMock = jest
      .fn()
      .mockReturnValueOnce(endpointEntropy)
      .mockReturnValueOnce(signingEntropy);
    const randomBytes = randomBytesMock as unknown as typeof crypto.randomBytes;
    const createdAt = new Date("2026-07-30T10:00:00.000Z");

    const endpointId = generateWhatsAppFlowEndpointId({ randomBytes });
    const keySet = generateWhatsAppFlowKeySet({
      randomBytes,
      now: () => createdAt,
    });
    const loaded = loadWhatsAppFlowKeySet(keySet);

    expect(randomBytesMock.mock.calls).toEqual([[32], [32]]);
    expect(endpointId).toBe(endpointEntropy.toString("base64url"));
    expect(keySet).toMatchObject({
      origin: "WABA_GENERATED",
      createdAt,
      publicKeyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      crypto.createPrivateKey(loaded.privateKeyPem).asymmetricKeyDetails
        ?.modulusLength
    ).toBe(2048);
    expect(loaded.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(loaded.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(loaded.signingKey.equals(signingEntropy)).toBe(true);
    expect(computeWhatsAppFlowPublicKeyFingerprint(loaded.publicKeyPem)).toBe(
      keySet.publicKeyFingerprint
    );
  });

  it("normalizes a strict legacy RSA key and rejects malformed, public-only, non-RSA, and wrong-size material", () => {
    const { privateKey: ecPrivateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const { privateKey: shortRsaPrivateKey } = crypto.generateKeyPairSync(
      "rsa",
      {
        modulusLength: 1024,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }
    );
    const signingKey = Buffer.alloc(32, 0x33);
    const randomBytes = jest
      .fn()
      .mockReturnValue(signingKey) as unknown as typeof crypto.randomBytes;

    const imported = importLegacyWhatsAppFlowKeySet({
      privateKeyPem: KNOWN_RSA_PRIVATE_KEY,
      randomBytes,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });
    const loaded = loadWhatsAppFlowKeySet(imported);

    expect(imported.origin).toBe("LEGACY_IMPORTED");
    expect(imported.publicKeyFingerprint).toBe(KNOWN_RSA_FINGERPRINT);
    expect(loaded.privateKeyPem).toBe(KNOWN_RSA_PRIVATE_KEY);
    expect(loaded.publicKeyPem).toBe(KNOWN_RSA_PUBLIC_KEY);
    expect(loaded.signingKey.equals(signingKey)).toBe(true);

    for (const privateKeyPem of [
      "not a private key",
      KNOWN_RSA_PUBLIC_KEY,
      ecPrivateKey,
      shortRsaPrivateKey,
    ]) {
      expect(() => importLegacyWhatsAppFlowKeySet({ privateKeyPem })).toThrow(
        "WhatsApp Flow RSA private key is invalid"
      );
    }
  });

  it("orders active, pending, and unexpired previous candidates without duplicate generations or key IDs", () => {
    const base = generateWhatsAppFlowKeySet({
      randomBytes: (() => Buffer.alloc(32, 0x44)) as typeof crypto.randomBytes,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });
    const active = { ...base, generationId: "active-generation" };
    const pending = {
      ...base,
      generationId: "pending-generation",
      rsaKeyId: "pending-rsa",
      signingKeyId: "pending-signing",
    };
    const previous = {
      ...base,
      generationId: "previous-generation",
      rsaKeyId: "previous-rsa",
      signingKeyId: "previous-signing",
      retireAt: new Date("2026-08-02T10:00:00.000Z"),
    };
    const expired = {
      ...base,
      generationId: "expired-generation",
      rsaKeyId: "expired-rsa",
      signingKeyId: "expired-signing",
      retireAt: new Date("2026-07-30T10:00:00.000Z"),
    };
    const duplicateActive = {
      ...base,
      generationId: active.generationId,
      rsaKeyId: "duplicate-rsa",
      signingKeyId: "duplicate-signing",
      retireAt: new Date("2026-08-02T10:00:00.000Z"),
    };
    const duplicatePreviousKey = {
      ...base,
      generationId: "duplicate-previous-generation",
      rsaKeyId: previous.rsaKeyId,
      signingKeyId: "duplicate-previous-signing",
      retireAt: new Date("2026-08-02T10:00:00.000Z"),
    };

    const candidates = resolveWhatsAppFlowKeyCandidates(
      {
        activeKeySet: active,
        pendingKeySet: pending,
        previousKeySets: [
          expired,
          duplicateActive,
          previous,
          duplicatePreviousKey,
        ],
      },
      new Date("2026-07-30T10:00:00.000Z")
    );

    expect(candidates.map(candidate => candidate.generationId)).toEqual([
      "active-generation",
      "pending-generation",
      "previous-generation",
    ]);
  });

  it("keeps safe descriptors and failures free of private and encrypted material", () => {
    const keySet = importLegacyWhatsAppFlowKeySet({
      privateKeyPem: KNOWN_RSA_PRIVATE_KEY,
      randomBytes: (() => Buffer.alloc(32, 0x55)) as typeof crypto.randomBytes,
    });
    const descriptor = toSafeWhatsAppFlowKeyDescriptor(keySet);
    const serializedDescriptor = JSON.stringify(descriptor);
    expect(descriptor).toEqual({
      generationId: keySet.generationId,
      origin: "LEGACY_IMPORTED",
      rsaKeyId: keySet.rsaKeyId,
      publicKeyFingerprint: KNOWN_RSA_FINGERPRINT,
      signingKeyId: keySet.signingKeyId,
      createdAt: keySet.createdAt,
      activatedAt: undefined,
      retireAt: undefined,
    });

    const tampered = {
      ...keySet,
      publicKeyFingerprint: "0".repeat(64),
    };
    let failure: Error | undefined;
    try {
      loadWhatsAppFlowKeySet(tampered);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeDefined();

    for (const secret of [
      KNOWN_RSA_PRIVATE_KEY,
      Buffer.alloc(32, 0x55).toString("base64"),
      keySet.encryptedPrivateKey.iv,
      keySet.encryptedPrivateKey.tag,
      keySet.encryptedPrivateKey.ciphertext,
      keySet.encryptedSigningKey.iv,
      keySet.encryptedSigningKey.tag,
      keySet.encryptedSigningKey.ciphertext,
    ]) {
      expect(serializedDescriptor).not.toContain(secret);
      expect(failure?.message).not.toContain(secret);
    }
  });

  it.each([
    ["rsaKeyId", "rsa_tampered"],
    ["signingKeyId", "sign_tampered"],
    ["generationId", "gen_tampered"],
  ] as const)(
    "rejects stored key material whose derived %s was tampered",
    (field, value) => {
      const keySet = importLegacyWhatsAppFlowKeySet({
        privateKeyPem: KNOWN_RSA_PRIVATE_KEY,
        randomBytes: (() =>
          Buffer.alloc(32, 0x66)) as typeof crypto.randomBytes,
      });

      expect(() =>
        loadWhatsAppFlowKeySet({ ...keySet, [field]: value })
      ).toThrow("Stored WhatsApp Flow key material is invalid");
    }
  );
});
