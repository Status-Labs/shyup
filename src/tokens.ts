import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { now } from "./db.ts";
import { InputError } from "./tasks.ts";

// A token's name is who it acts as, e.g. "ben" or "claude@wemail". It's recorded on everything it does.
const tokenNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,63}$/;

export type TokenInfo = { name: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a token and returns it. Only its hash is stored, so it can't be shown again. */
export function createToken(db: DatabaseSync, name: string): string {
  if (!tokenNamePattern.test(name)) {
    throw new InputError("Token name must be 1-64 characters: letters, digits, @ . _ -");
  }
  const existing = db.prepare("SELECT 1 FROM tokens WHERE name = ? AND revoked_at IS NULL").get(name);
  if (existing) throw new InputError(`A token named "${name}" already exists`);
  const token = `sy_${randomBytes(24).toString("base64url")}`;
  db.prepare("INSERT INTO tokens (name, hash, created_at) VALUES (?, ?, ?)").run(name, hashToken(token), now());
  return token;
}

/** Returns the name the token acts as, or null if it's unknown or revoked. */
export function authenticate(db: DatabaseSync, token: string): string | null {
  const row = db
    .prepare("SELECT id, name FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .get(hashToken(token)) as { id: number; name: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
  return row.name;
}

export function listTokens(db: DatabaseSync): TokenInfo[] {
  return db
    .prepare("SELECT name, created_at, last_used_at, revoked_at FROM tokens ORDER BY name")
    .all() as TokenInfo[];
}

export function revokeToken(db: DatabaseSync, name: string): void {
  const result = db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(now(), name);
  if (result.changes === 0) throw new InputError(`No active token named "${name}"`);
}
