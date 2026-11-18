// Planted API routes for the endpoint checks: a safe and an unsafe version of each kind.
// Used by the unit tests and by add-sample-routes.mjs (sample repo, branch feature/api-routes).
// No real keys: everything is read from environment variables that do not exist.

const AUTH = `  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });`;

export const SAMPLE_ROUTES = {
  // ------------------------------------------------------------------ shared helpers
  "lib/supabase/server.ts": `
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
}
`,
  "lib/ratelimit.ts": `
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export const ratelimit = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(20, "1 m") });
`,

  // ------------------------------------------------------------------ SAFE: must not be flagged
  // LLM endpoint done right: login, rate limit, maxDuration, input limit, only the message from the client.
  "app/api/chat/route.ts": `
import OpenAI from "openai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ratelimit } from "@/lib/ratelimit";

export const maxDuration = 60;
const Body = z.object({ message: z.string().min(1).max(4000) });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
${AUTH}
  const { success } = await ratelimit.limit(user.id);
  if (!success) return new Response("Too many requests", { status: 429 });
  const { message } = Body.parse(await req.json());
  const completion = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: message },
    ],
  });
  return Response.json({ answer: completion.choices[0].message.content });
}
`,
  // Third-party endpoint done right: fixed URL, timeout, key never logged.
  "app/api/search/route.ts": `
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
${AUTH}
  const { q } = await req.json();
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", String(q).slice(0, 200));
  url.searchParams.set("api_key", process.env.SERPAPI_KEY!);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return Response.json(await res.json());
}
`,
  // Container endpoint done right: service credential, fixed path, timeout.
  "app/api/summaries/route.ts": `
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
${AUTH}
  const { documentId } = await req.json();
  const res = await fetch(\`\${process.env.WORKER_URL}/jobs/summarize\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${process.env.WORKER_SECRET}\` },
    body: JSON.stringify({ documentId: String(documentId), requestedBy: user.id }),
    signal: AbortSignal.timeout(15_000),
  });
  return Response.json(await res.json(), { status: res.status });
}
`,
  // Webhook done right: signature verified on the raw body.
  "app/api/webhooks/stripe/route.ts": `
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const raw = await req.text();
  const event = stripe.webhooks.constructEvent(raw, req.headers.get("stripe-signature")!, process.env.STRIPE_WEBHOOK_SECRET!);
  return Response.json({ received: event.id });
}
`,
  // Cron done right: refuses without the secret.
  "app/api/cron/refresh/route.ts": `
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== \`Bearer \${process.env.CRON_SECRET}\`) return new Response("Forbidden", { status: 403 });
  return Response.json({ refreshed: true });
}
`,
  // Public by decision: on publicRoutes in the agent's config.
  "app/api/health/route.ts": `
export function GET() {
  return Response.json({ ok: true });
}
`,
  // Server action done right.
  "app/actions/profile.ts": `
"use server";
import { createClient } from "@/lib/supabase/server";

export async function updateDisplayName(name: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  await supabase.from("profiles").update({ display_name: name.slice(0, 80) }).eq("id", user.id);
}
`,
  // Supabase function with the platform's token check left on (default).
  "supabase/functions/hello/index.ts": `
Deno.serve(() => new Response(JSON.stringify({ hello: "world" }), { headers: { "content-type": "application/json" } }));
`,

  // ------------------------------------------------------------------ UNSAFE: must be flagged
  // PLANTED: LLM endpoint with no login, GET handler, model/system from the client, no limits.
  "app/api/ai/generate/route.ts": `
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function GET(req: Request) {
  const prompt = new URL(req.url).searchParams.get("prompt") ?? "";
  const msg = await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 1024, messages: [{ role: "user", content: prompt }] });
  return Response.json(msg);
}

export async function POST(req: Request) {
  const { model, system, prompt } = await req.json();
  const msg = await anthropic.messages.create({ model, system, max_tokens: 4096, messages: [{ role: "user", content: prompt }] });
  return Response.json(msg);
}
`,
  // PLANTED: third-party endpoint that fetches a user URL (SSRF), logs its key, no timeout.
  "app/api/link-preview/route.ts": `
import { createClient } from "@/lib/supabase/server";

export async function GET(req: Request) {
${AUTH}
  const target = new URL(req.url).searchParams.get("url");
  console.log("link preview with key", process.env.LINKPREVIEW_API_KEY);
  const meta = await fetch(\`https://api.linkpreview.net/?key=\${process.env.LINKPREVIEW_API_KEY}&q=\${target}\`);
  const page = await fetch(target!);
  return Response.json({ meta: await meta.json(), status: page.status });
}
`,
  // PLANTED: container endpoint that forwards the user's headers and a user-chosen path.
  "app/api/documents/process/route.ts": `
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
${AUTH}
  const { path, payload } = await req.json();
  const res = await fetch(\`\${process.env.WORKER_URL}/\${path}\`, { method: "POST", headers: req.headers, body: JSON.stringify(payload) });
  return Response.json(await res.json());
}
`,
  // PLANTED: URL from an unknown setting (REPORTS_URL): assumed to be a container, to classify.
  "app/api/export/route.ts": `
import { createClient } from "@/lib/supabase/server";

export async function POST() {
${AUTH}
  const res = await fetch(\`\${process.env.REPORTS_URL}/export\`, { method: "POST", body: JSON.stringify({ owner: user.id }) });
  return Response.json(await res.json());
}
`,
  // PLANTED: cron route anyone can call.
  "app/api/cron/cleanup/route.ts": `
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

export async function GET() {
  await admin.from("sessions").delete().lt("expires_at", new Date().toISOString());
  return Response.json({ cleaned: true });
}
`,
  // PLANTED: webhook that trusts whatever is posted.
  "app/api/webhooks/n8n/route.ts": `
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

export async function POST(req: Request) {
  const { jobId, status } = await req.json();
  await admin.from("jobs").update({ status }).eq("id", jobId);
  return Response.json({ ok: true });
}
`,
  // PLANTED: no login, secret key, and the user id / role come from the request.
  "app/api/admin/set-role/route.ts": `
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

export async function POST(req: Request) {
  const { userId, role } = await req.json();
  await admin.from("profiles").update({ role }).eq("id", userId);
  return Response.json({ ok: true });
}
`,
  // PLANTED: GET handler that changes data (a link in an email can trigger it).
  "app/api/profile/route.ts": `
import { createClient } from "@/lib/supabase/server";

export async function GET(req: Request) {
${AUTH}
  const theme = new URL(req.url).searchParams.get("theme");
  await supabase.from("profiles").update({ theme }).eq("id", user.id);
  return Response.json({ theme });
}
`,
  // PLANTED: server action with no login check.
  "app/actions/notes.ts": `
"use server";
import { createClient } from "@/lib/supabase/server";

export async function deleteNote(id: string) {
  const supabase = await createClient();
  await supabase.from("notes").delete().eq("id", id);
}
`,
  // PLANTED: Supabase function with the token check switched off, no login, no timeout.
  "supabase/functions/send-digest/index.ts": `
Deno.serve(async (req) => {
  const { to } = await req.json();
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: \`Bearer \${Deno.env.get("RESEND_API_KEY")}\`, "content-type": "application/json" },
    body: JSON.stringify({ from: "digest@example.com", to, subject: "Your digest", text: "..." }),
  });
  return new Response("sent");
});
`,
  "supabase/config.toml": `
[functions.send-digest]
verify_jwt = false
`,
};

/** What the agent must report for the planted routes: endpoint -> sorted finding keys. */
export const EXPECTED_ENDPOINT_FINDINGS = {
  "/api/ai/generate": ["get-llm", "llm-input-limit", "llm-max-duration", "llm-rate-limit", "llm-settings", "no-auth"],
  "/api/link-preview": ["logs-secret", "ssrf", "timeout"],
  "/api/documents/process": ["container-headers", "ssrf", "timeout"],
  "/api/export": ["container-credential", "timeout"],
  "/api/cron/cleanup": ["cron-secret"],
  "/api/webhooks/n8n": ["webhook-signature"],
  "/api/admin/set-role": ["identity", "no-auth"],
  "/api/profile": ["get-writes"],
  "server actions in app/actions/notes.ts": ["no-auth"],
  "/functions/v1/send-digest": ["no-auth", "timeout"],
};
