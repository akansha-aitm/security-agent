// Email senders. Picked automatically:
//   GMAIL_REFRESH_TOKEN set  -> Gmail API with a send-only Google sign-in (OAuth, scope gmail.send)
//   otherwise                -> Gmail SMTP with an App Password (SMTP_USER / SMTP_PASS)
// Each sender has verify() (sign in once, before sending) and send(message).
// Messages are built by nodemailer (headers, encoding), so both senders produce the same email.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** Returns { name, verify(), send({from, replyTo, to, subject, text}) } or { error }. */
export async function createMailer(env = process.env) {
  if (env.GMAIL_REFRESH_TOKEN) return gmailApiMailer(env);
  return smtpMailer(env);
}

async function smtpMailer(env) {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.replace(/\s+/g, ""); // App Passwords are shown with spaces
  if (!user || !pass) return { error: "no sender configured: set GMAIL_REFRESH_TOKEN (Gmail API) or SMTP_USER and SMTP_PASS" };
  const host = env.SMTP_HOST ?? "smtp.gmail.com";
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({ host, port: Number(env.SMTP_PORT ?? 465), secure: true, auth: { user, pass } });
  return {
    name: `SMTP (${host})`,
    // A 535-5.7.8 error here usually means the normal password was used instead of an App Password.
    verify: () => transport.verify(),
    send: (message) => transport.sendMail(message),
  };
}

async function gmailApiMailer(env) {
  const clientId = env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
  const refreshToken = env.GMAIL_REFRESH_TOKEN.trim();
  if (!clientId || !clientSecret) return { error: "GMAIL_REFRESH_TOKEN is set but GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET is missing" };
  const { default: nodemailer } = await import("nodemailer");
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  let accessToken = null;

  const signIn = async () => {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      // invalid_grant: the sign-in was revoked, or the account's password changed. Run `npm run gmail-auth` again.
      const hint = body.error === "invalid_grant" ? " (sign-in revoked or password changed: run npm run gmail-auth again)" : "";
      throw new Error(`Google sign-in failed: ${body.error ?? res.status}${body.error_description ? ` - ${body.error_description}` : ""}${hint}`);
    }
    if (!String(body.scope ?? "").split(" ").includes("https://www.googleapis.com/auth/gmail.send"))
      throw new Error("Google sign-in has no gmail.send permission: run npm run gmail-auth again");
    accessToken = body.access_token;
  };

  return {
    name: "Gmail API",
    verify: signIn,
    async send(message) {
      if (!accessToken) await signIn();
      const { message: mime } = await composer.sendMail(message);
      const res = await fetch(GMAIL_SEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Gmail API ${res.status}: ${body.error?.message ?? res.statusText}`);
      }
    },
  };
}
