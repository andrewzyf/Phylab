import { parseScenario, type Scenario } from "@physicslab/shared";

/**
 * Share links carry the whole scenario in the URL fragment (never sent to a server):
 * #s=<base64url(deflate-raw(JSON))>. Falls back to uncompressed base64url ("#j=") where
 * CompressionStream isn't available.
 */
const toB64Url = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64Url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const out = blob.stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeScenario(s: Scenario): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  if (typeof CompressionStream !== "undefined") {
    try {
      return `s=${toB64Url(await pipe(json, new CompressionStream("deflate-raw")))}`;
    } catch {
      // fall through
    }
  }
  return `j=${toB64Url(json)}`;
}

export async function decodeScenario(hash: string): Promise<Scenario | null> {
  const h = hash.replace(/^#/, "");
  try {
    let json: string;
    if (h.startsWith("s=")) {
      json = new TextDecoder().decode(await pipe(fromB64Url(h.slice(2)), new DecompressionStream("deflate-raw")));
    } else if (h.startsWith("j=")) {
      json = new TextDecoder().decode(fromB64Url(h.slice(2)));
    } else return null;
    const parsed = parseScenario(JSON.parse(json));
    return parsed.ok ? parsed.scenario : null;
  } catch {
    return null;
  }
}

export async function shareUrl(s: Scenario): Promise<string> {
  const url = new URL(window.location.href);
  url.hash = await encodeScenario({ ...s, metadata: { ...s.metadata, source: "shared" } });
  return url.toString();
}
