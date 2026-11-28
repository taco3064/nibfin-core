// Shared test support for the runner request: request Issues and keys. It holds no
// tests of its own.
import { type RequestIssue, requestMarker } from "./check.ts";

/** The base64 of an ssh-ed25519 public key: its wire format with 32 key bytes. */
export function ed25519Blob(fill = 7): string {
  const prefix = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
  return Buffer.concat([prefix, Buffer.alloc(32, fill)]).toString("base64");
}

/** A runner request of ann for her SSH key 12345, as the event gives it. */
export function requestIssue(overrides: Partial<RequestIssue> = {}): RequestIssue {
  return {
    number: 1,
    title: "Nibfin runner request",
    body: `${requestMarker}\nssh-key-id: 12345\n`,
    login: "ann",
    userType: "User",
    ...overrides,
  };
}
