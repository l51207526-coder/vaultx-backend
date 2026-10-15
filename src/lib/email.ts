const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function emailIsConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.FRONTEND_URL);
}

export function requireEmailConfiguration(): void {
  if (!emailIsConfigured()) {
    const error = new Error("Email delivery is not configured. Set RESEND_API_KEY, EMAIL_FROM and FRONTEND_URL.");
    Object.assign(error, { status: 503 });
    throw error;
  }
}

export function buildEmailLink(kind: "verify" | "reset", token: string): string {
  const url = new URL("/", process.env.FRONTEND_URL!);
  url.hash = `${kind}=${encodeURIComponent(token)}`;
  return url.toString();
}

export async function sendVaultEmail(to: string, subject: string, text: string, actionLabel: string, actionUrl: string): Promise<void> {
  requireEmailConfiguration();
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      text: `${text}\n\n${actionLabel}: ${actionUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>${text}</p><p><a href="${actionUrl}">${actionLabel}</a></p><p>If you did not request this, you can ignore this email.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.error(`Email provider returned HTTP ${response.status}.`);
    const error = new Error("Email delivery failed. Please try again later.");
    Object.assign(error, { status: 503 });
    throw error;
  }
}
