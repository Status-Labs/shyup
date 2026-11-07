// Sends sign-in emails through WeMail's API when it's configured. Otherwise prints the link
// to the server log, which is all you need locally or on a box only you use.

export type MailConfig = { url: string; apiKey: string; inboxId: string } | null;

export function mailConfigFromEnv(env: NodeJS.ProcessEnv): MailConfig {
  const apiKey = env.SHYUP_WEMAIL_API_KEY;
  const inboxId = env.SHYUP_WEMAIL_INBOX_ID;
  if (!apiKey && !inboxId) return null;
  if (!apiKey || !inboxId) throw new Error("Set both SHYUP_WEMAIL_API_KEY and SHYUP_WEMAIL_INBOX_ID, or neither.");
  return { url: env.SHYUP_WEMAIL_URL ?? "https://wemail.now", apiKey, inboxId };
}

export async function sendLoginEmail(config: MailConfig, to: string, link: string): Promise<void> {
  const text = `Here's your link to sign in to Shyup:\n\n${link}\n\nIt works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`;
  if (!config) {
    console.log(`Sign-in link for ${to}: ${link}`);
    return;
  }
  const response = await fetch(new URL("/api/v1/messages", config.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inbox_id: config.inboxId, to, subject: "Your Shyup sign-in link", text }),
  });
  if (!response.ok) {
    throw new Error(`WeMail send failed (${response.status}): ${await response.text()}`);
  }
}
