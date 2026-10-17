const encoder = new TextEncoder();

export async function signRequestJWT(
  encodedSecret: string,
  audience: string,
  path: string,
  origin: string,
  data: unknown,
  now = Date.now(),
): Promise<string> {
  const keyBytes = decodeBase64URL(encodedSecret);
  if (keyBytes.byteLength !== 32) throw new Error("Manager JWT secret must contain exactly 32 bytes");
  if (!audience || !path.startsWith("/") || !origin) throw new Error("Manager JWT request identity is invalid");
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable");
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const issued = Math.floor(now / 1000);
  const claims = base64url(encoder.encode(JSON.stringify({ aud: audience, path, origin, iat: issued, exp: issued + 60, data })));
  const unsigned = `${header}.${claims}`;
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

function decodeBase64URL(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Manager JWT secret is not valid unpadded base64url");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { throw new Error("Manager JWT secret is malformed"); }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
