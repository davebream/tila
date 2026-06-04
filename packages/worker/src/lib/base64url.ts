export function base64UrlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binStr = atob(padded);
  return Uint8Array.from(binStr, (c) => c.charCodeAt(0));
}
