import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "./base64url";

describe("base64UrlEncode", () => {
  it("roundtrip: encode then decode returns original bytes", () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(original);
  });

  it("empty Uint8Array encodes to empty string", () => {
    const result = base64UrlEncode(new Uint8Array([]));
    expect(result).toBe("");
  });

  it("decoding empty string returns empty Uint8Array", () => {
    const result = base64UrlDecode("");
    expect(result).toEqual(new Uint8Array([]));
  });

  it("encodes all byte values 0-255 without error", () => {
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const encoded = base64UrlEncode(allBytes);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(allBytes);
  });

  it("output contains no padding characters", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("=");
  });

  it("output contains no standard base64 + character", () => {
    // Use bytes that produce + in standard base64: 0xfb = 251
    const bytes = new Uint8Array([0xfb, 0xff]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("+");
  });

  it("output contains no standard base64 / character", () => {
    // Use bytes that produce / in standard base64: 0xff = 255
    const bytes = new Uint8Array([0xff, 0xff]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("/");
  });

  it("encodes multi-byte UTF-8 string bytes and decodes back correctly", () => {
    const text = "héllo wörld";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    const encoded = base64UrlEncode(bytes);
    const decoded = base64UrlDecode(encoded);
    const decoder = new TextDecoder();
    expect(decoder.decode(decoded)).toBe(text);
  });

  it("uses - instead of + and _ instead of /", () => {
    // 0xfb produces + in standard base64; 0xff produces /
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const encoded = base64UrlEncode(bytes);
    // must only contain URL-safe characters
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
