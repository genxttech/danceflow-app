import { createHash, randomBytes } from "crypto";

export function createAccountantDeliveryToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAccountantDeliveryToken(token) };
}

export function hashAccountantDeliveryToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
