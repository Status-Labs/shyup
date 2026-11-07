// People who sign in to the web board with an emailed link. Agents use tokens instead (tokens.ts).
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { now } from "./db.ts";
import { InputError } from "./tasks.ts";

const loginLinkMinutes = 15;
const sessionDays = 30;
const resendSeconds = 60;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,63}$/;

export type User = { name: string; email: string; created_at: string };

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function addUser(db: DatabaseSync, name: string, email: string): User {
  if (!namePattern.test(name)) throw new InputError("Name must be 1-64 characters: letters, digits, @ . _ -");
  const address = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new InputError(`"${email}" isn't an email address`);
  if (db.prepare("SELECT 1 FROM users WHERE name = ? OR email = ?").get(name, address)) {
    throw new InputError(`A user named ${name} or with email ${address} already exists`);
  }
  const createdAt = now();
  db.prepare("INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)").run(name, address, createdAt);
  return { name, email: address, created_at: createdAt };
}

export function listUsers(db: DatabaseSync): User[] {
  return db.prepare("SELECT name, email, created_at FROM users ORDER BY name").all() as User[];
}

/** Removes a user and signs them out everywhere. Their name stays on past tasks and comments. */
export function removeUser(db: DatabaseSync, name: string): void {
  const user = db.prepare("SELECT id FROM users WHERE name = ?").get(name) as { id: number } | undefined;
  if (!user) throw new InputError(`No user named ${name}`);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM login_links WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
}

/**
 * Makes a one-time sign-in secret for the user with this email.
 * Returns null for unknown emails, or if a link was sent in the last minute, so callers
 * can answer the same way either way and not reveal who has an account.
 */
export function createLoginLink(db: DatabaseSync, email: string): { secret: string; email: string } | null {
  const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(normalizeEmail(email)) as
    | { id: number; email: string }
    | undefined;
  if (!user) return null;
  const recentCutoff = new Date(Date.now() - resendSeconds * 1000).toISOString();
  if (db.prepare("SELECT 1 FROM login_links WHERE user_id = ? AND created_at > ?").get(user.id, recentCutoff)) {
    return null;
  }
  const secret = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO login_links (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    hash(secret),
    user.id,
    now(),
    minutesFromNow(loginLinkMinutes),
  );
  return { secret, email: user.email };
}

/** Uses up a login link and starts a session. Returns the session secret, or null if the link is bad or spent. */
export function redeemLoginLink(db: DatabaseSync, secret: string): string | null {
  const link = db
    .prepare("SELECT user_id FROM login_links WHERE hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(hash(secret), now()) as { user_id: number } | undefined;
  if (!link) return null;
  db.prepare("UPDATE login_links SET used_at = ? WHERE hash = ?").run(now(), hash(secret));
  const session = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    hash(session),
    link.user_id,
    now(),
    minutesFromNow(sessionDays * 24 * 60),
  );
  return session;
}

/** Returns the signed-in user's name for a session secret, or null. */
export function sessionUser(db: DatabaseSync, session: string): string | null {
  const row = db
    .prepare("SELECT users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE hash = ? AND expires_at > ?")
    .get(hash(session), now()) as { name: string } | undefined;
  return row?.name ?? null;
}

export function endSession(db: DatabaseSync, session: string): void {
  db.prepare("DELETE FROM sessions WHERE hash = ?").run(hash(session));
}

export const sessionMaxAgeSeconds = sessionDays * 24 * 60 * 60;
