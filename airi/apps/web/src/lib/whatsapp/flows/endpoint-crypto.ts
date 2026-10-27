import crypto from "crypto";

import { decryptString, encryptString } from "@/lib/crypto";
import type {
  WhatsAppFlowEndpointSecurityRecord,
  WhatsAppFlowKeySet,
} from "@/models/whatsapp-flow-endpoint-security";

export type FlowEndpointEncryptedBody = {
  encrypted_flow_data?: string;
  encrypted_aes_key?: string;
  initial_vector?: string;
};

export function isFlowEndpointEncryptedBody(
  value: unknown
): value is FlowEndpointEncryptedBody {
  if (!value || typeof value !== "object") return false;
  const o = value as FlowEndpointEncryptedBody;
  return (
    typeof o.encrypted_flow_data === "string" &&
    typeof o.encrypted_aes_key === "string" &&
    typeof o.initial_vector === "string"
  );
}

/**
 * Decrypt WhatsApp Flow Data Endpoint request (data_api_version 3.0 / 4.0).
 * Meta reference (WhatsApp-Flows-Tools) uses the same RSA-OAEP SHA-256 + AES-128-GCM scheme for both.
 * @see https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint
 * @see https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/examples/endpoint/nodejs/basic/src/encryption.js
 */
export function decryptFlowEndpointRequest(
  body: FlowEndpointEncryptedBody,
  privateKeyPem: string
): { decrypted: unknown; aesKey: Buffer; iv: Buffer } {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(body.encrypted_aes_key!, "base64")
  );

  const iv = Buffer.from(body.initial_vector!, "base64");
  const flowDataBuf = Buffer.from(body.encrypted_flow_data!, "base64");
  const TAG_LENGTH = 16;
  const ciphertext = flowDataBuf.subarray(0, -TAG_LENGTH);
  const authTag = flowDataBuf.subarray(-TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return {
    decrypted: JSON.parse(decrypted.toString("utf8")) as unknown,
    aesKey,
    iv,
  };
}

/**
 * Encrypt Flow Data Endpoint response: Base64 ciphertext as plain text body.
 */
export function encryptFlowEndpointResponse(
  responseObj: unknown,
  aesKey: Buffer,
  requestIv: Buffer
): string {
  const flippedIv = Buffer.alloc(requestIv.length);
  for (let i = 0; i < requestIv.length; i++) {
    flippedIv[i] = requestIv[i]! ^ 0xff;
  }
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const json = JSON.stringify(responseObj);
  const encrypted = Buffer.concat([
    cipher.update(json, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return encrypted.toString("base64");
}

export function loadFlowEndpointPrivateKeyFromEnv(): string | null {
  const raw = process.env.WHATSAPP_FLOW_ENDPOINT_PRIVATE_KEY?.trim();
  if (!raw) return null;
  return raw.replace(/\\n/g, "\n");
}

const FLOW_RSA_MODULUS_LENGTH = 2048;
const FLOW_SIGNING_KEY_LENGTH = 32;
const FLOW_ENDPOINT_ID_LENGTH = 32;

type RandomBytes = typeof crypto.randomBytes;

type FlowKeyGenerationOptions = {
  randomBytes?: RandomBytes;
  now?: () => Date;
};

type LoadedWhatsAppFlowKeySet = {
  generationId: string;
  rsaKeyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  signingKeyId: string;
  signingKey: Buffer;
};

export type SafeWhatsAppFlowKeyDescriptor = Pick<
  WhatsAppFlowKeySet,
  | "generationId"
  | "origin"
  | "rsaKeyId"
  | "publicKeyFingerprint"
  | "signingKeyId"
  | "createdAt"
  | "activatedAt"
  | "retireAt"
>;

function invalidPrivateKey(): Error {
  return new Error("WhatsApp Flow RSA private key is invalid");
}

function normalizeRsaPrivateKey(privateKeyPem: string): {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
} {
  try {
    const privateKey = crypto.createPrivateKey(privateKeyPem.trim());
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      privateKey.asymmetricKeyDetails?.modulusLength !== FLOW_RSA_MODULUS_LENGTH
    ) {
      throw invalidPrivateKey();
    }

    const normalizedPrivateKey = privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const publicKey = crypto.createPublicKey(privateKey);
    const normalizedPublicKey = publicKey.export({
      type: "spki",
      format: "pem",
    });
    const publicKeyDer = publicKey.export({
      type: "spki",
      format: "der",
    });
    return {
      privateKeyPem: normalizedPrivateKey.toString(),
      publicKeyPem: normalizedPublicKey.toString(),
      publicKeyFingerprint: crypto
        .createHash("sha256")
        .update(publicKeyDer)
        .digest("hex"),
    };
  } catch {
    throw invalidPrivateKey();
  }
}

function readSigningEntropy(randomBytes: RandomBytes): Buffer {
  const signingKey = randomBytes(FLOW_SIGNING_KEY_LENGTH);
  if (
    !Buffer.isBuffer(signingKey) ||
    signingKey.length !== FLOW_SIGNING_KEY_LENGTH
  ) {
    throw new Error("WhatsApp Flow signing-key entropy is invalid");
  }
  return signingKey;
}

function deriveWhatsAppFlowKeyIdentifiers(
  publicKeyFingerprint: string,
  signingKey: Buffer
): Pick<WhatsAppFlowKeySet, "generationId" | "rsaKeyId" | "signingKeyId"> {
  const signingKeyHash = crypto
    .createHash("sha256")
    .update(signingKey)
    .digest("hex");
  return {
    generationId: `gen_${crypto
      .createHash("sha256")
      .update(`${publicKeyFingerprint}:${signingKeyHash}`)
      .digest("base64url")}`,
    rsaKeyId: `rsa_${publicKeyFingerprint}`,
    signingKeyId: `sign_${signingKeyHash}`,
  };
}

function buildWhatsAppFlowKeySet(params: {
  privateKeyPem: string;
  origin: WhatsAppFlowKeySet["origin"];
  randomBytes: RandomBytes;
  now: () => Date;
}): WhatsAppFlowKeySet {
  const normalized = normalizeRsaPrivateKey(params.privateKeyPem);
  const signingKey = readSigningEntropy(params.randomBytes);
  const identifiers = deriveWhatsAppFlowKeyIdentifiers(
    normalized.publicKeyFingerprint,
    signingKey
  );
  const createdAt = params.now();
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
    throw new Error("WhatsApp Flow key creation time is invalid");
  }

  return {
    generationId: identifiers.generationId,
    origin: params.origin,
    rsaKeyId: identifiers.rsaKeyId,
    encryptedPrivateKey: encryptString(normalized.privateKeyPem),
    publicKeyFingerprint: normalized.publicKeyFingerprint,
    signingKeyId: identifiers.signingKeyId,
    encryptedSigningKey: encryptString(signingKey.toString("base64")),
    createdAt: new Date(createdAt),
  };
}

export function generateWhatsAppFlowEndpointId(
  options: Pick<FlowKeyGenerationOptions, "randomBytes"> = {}
): string {
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const endpointEntropy = randomBytes(FLOW_ENDPOINT_ID_LENGTH);
  if (
    !Buffer.isBuffer(endpointEntropy) ||
    endpointEntropy.length !== FLOW_ENDPOINT_ID_LENGTH
  ) {
    throw new Error("WhatsApp Flow endpoint entropy is invalid");
  }
  return endpointEntropy.toString("base64url");
}

export function computeWhatsAppFlowPublicKeyFingerprint(
  publicKeyPem: string
): string {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      publicKey.asymmetricKeyDetails?.modulusLength !== FLOW_RSA_MODULUS_LENGTH
    ) {
      throw new Error();
    }
    return crypto
      .createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
  } catch {
    throw new Error("WhatsApp Flow RSA public key is invalid");
  }
}

export function generateWhatsAppFlowKeySet(
  options: FlowKeyGenerationOptions = {}
): WhatsAppFlowKeySet {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: FLOW_RSA_MODULUS_LENGTH,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return buildWhatsAppFlowKeySet({
    privateKeyPem: privateKey,
    origin: "WABA_GENERATED",
    randomBytes: options.randomBytes ?? crypto.randomBytes,
    now: options.now ?? (() => new Date()),
  });
}

export function importLegacyWhatsAppFlowKeySet(
  params: FlowKeyGenerationOptions & { privateKeyPem: string }
): WhatsAppFlowKeySet {
  return buildWhatsAppFlowKeySet({
    privateKeyPem: params.privateKeyPem,
    origin: "LEGACY_IMPORTED",
    randomBytes: params.randomBytes ?? crypto.randomBytes,
    now: params.now ?? (() => new Date()),
  });
}

export function loadWhatsAppFlowKeySet(
  keySet: WhatsAppFlowKeySet
): LoadedWhatsAppFlowKeySet {
  try {
    const privateKeyPem = decryptString(keySet.encryptedPrivateKey);
    const normalized = normalizeRsaPrivateKey(privateKeyPem);
    if (normalized.publicKeyFingerprint !== keySet.publicKeyFingerprint) {
      throw new Error();
    }

    const encodedSigningKey = decryptString(keySet.encryptedSigningKey);
    const signingKey = Buffer.from(encodedSigningKey, "base64");
    if (
      signingKey.length !== FLOW_SIGNING_KEY_LENGTH ||
      signingKey.toString("base64") !== encodedSigningKey
    ) {
      throw new Error();
    }
    const identifiers = deriveWhatsAppFlowKeyIdentifiers(
      normalized.publicKeyFingerprint,
      signingKey
    );
    if (
      keySet.rsaKeyId !== identifiers.rsaKeyId ||
      keySet.signingKeyId !== identifiers.signingKeyId ||
      keySet.generationId !== identifiers.generationId
    ) {
      throw new Error();
    }

    return {
      generationId: keySet.generationId,
      rsaKeyId: keySet.rsaKeyId,
      privateKeyPem: normalized.privateKeyPem,
      publicKeyPem: normalized.publicKeyPem,
      publicKeyFingerprint: normalized.publicKeyFingerprint,
      signingKeyId: keySet.signingKeyId,
      signingKey,
    };
  } catch {
    throw new Error("Stored WhatsApp Flow key material is invalid");
  }
}

export function resolveWhatsAppFlowKeyCandidates(
  record: Pick<
    WhatsAppFlowEndpointSecurityRecord,
    "activeKeySet" | "pendingKeySet" | "previousKeySets"
  >,
  now: Date
): WhatsAppFlowKeySet[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("WhatsApp Flow candidate time is invalid");
  }

  const candidates = [
    record.activeKeySet,
    record.pendingKeySet,
    ...record.previousKeySets.filter(
      keySet =>
        keySet.retireAt instanceof Date &&
        keySet.retireAt.getTime() > now.getTime()
    ),
  ];
  const seenGenerationIds = new Set<string>();
  const seenRsaKeyIds = new Set<string>();
  const seenSigningKeyIds = new Set<string>();
  const deduplicated: WhatsAppFlowKeySet[] = [];

  for (const candidate of candidates) {
    if (
      candidate === undefined ||
      seenGenerationIds.has(candidate.generationId) ||
      seenRsaKeyIds.has(candidate.rsaKeyId) ||
      seenSigningKeyIds.has(candidate.signingKeyId)
    ) {
      continue;
    }
    seenGenerationIds.add(candidate.generationId);
    seenRsaKeyIds.add(candidate.rsaKeyId);
    seenSigningKeyIds.add(candidate.signingKeyId);
    deduplicated.push(candidate);
  }
  return deduplicated;
}

export function toSafeWhatsAppFlowKeyDescriptor(
  keySet: WhatsAppFlowKeySet
): SafeWhatsAppFlowKeyDescriptor {
  return {
    generationId: keySet.generationId,
    origin: keySet.origin,
    rsaKeyId: keySet.rsaKeyId,
    publicKeyFingerprint: keySet.publicKeyFingerprint,
    signingKeyId: keySet.signingKeyId,
    createdAt: keySet.createdAt,
    activatedAt: keySet.activatedAt,
    retireAt: keySet.retireAt,
  };
}
