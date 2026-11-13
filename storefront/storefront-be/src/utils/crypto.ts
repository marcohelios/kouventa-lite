import crypto from "crypto";

const SERVER_PRIVATE_KEY_JWK = JSON.parse(process.env.ECDH_PRIVATE_KEY_JWK!);

let josePromise: Promise<typeof import("jose", { with: { "resolution-mode": "import" } })> | null = null;
function getJose() {
  if (!josePromise) josePromise = import("jose");
  return josePromise;
}

export async function unwrapKey(jwe: string): Promise<Buffer> {
  const { compactDecrypt, importJWK } = await getJose();
  const privateKey = await importJWK(SERVER_PRIVATE_KEY_JWK, "ECDH-ES+A256KW");
  const { plaintext } = await compactDecrypt(jwe, privateKey);
  return Buffer.from(plaintext);
}

export function decryptValue(aesKey: Buffer, encoded: string): string {
  const combined = Buffer.from(encoded, "base64url");
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptValue(aesKey: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}