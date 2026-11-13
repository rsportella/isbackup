import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function generateKeyHex(): string {
  return crypto.randomBytes(KEY_LENGTH).toString("hex");
}

export function parseKey(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ISBACKUP_ENCRYPTION_KEY invalida: esperado ${KEY_LENGTH} bytes em hex (${KEY_LENGTH * 2} caracteres hex).`,
    );
  }
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]);
  return `${PREFIX}${payload.toString("base64")}`;
}

export function decrypt(encoded: string, key: Buffer): string {
  try {
    const payload = Buffer.from(encoded.slice(PREFIX.length), "base64");
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "Nao foi possivel decifrar a senha: o valor esta corrompido/truncado, ou a ISBACKUP_ENCRYPTION_KEY " +
        "atual (.env) nao confere com a que cifrou esse valor.",
    );
  }
}
