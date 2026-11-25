// ad-assistant: answers marketing questions in the ad panel with Claude.
// Context = the marketing plan + panel numbers for the last 30 days, read with the
// caller's own JWT, so the same "Маркетинг" section check applies as in the panel.
// Needs the secret ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
import Anthropic from "npm:@anthropic-ai/sdk@1";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `Ты — маркетинговый помощник глазной клиники Asia Köz (Азиякөз): турецкая клиника в Казахстане, филиалы Алматы (10 000 м², 2 турецких врача + 1 казахский), Ақтау и Шымкент (турецкие врачи меняются каждые 2 недели). Почти все пациенты приходят из таргета Instagram → WhatsApp → amoCRM. Самая большая статья расходов — турецкие врачи.

Тебе дают маркетинговый план клиники и цифры панели за последние 30 дней. Отвечай руководителю маркетинга:
- на языке вопроса (казахский или русский);
- коротко и по делу: сначала ответ или решение, потом 2–5 пунктов «что сделать», с цифрами из данных;
- если данных не хватает, прямо скажи, каких, и не придумывай цифры;
- тексты для рекламы и рассылок пиши готовыми к отправке, на казахском и/или русском, без гарантий результата лечения («100% будете видеть» нельзя), цены — только «от»;
- филиалы в данных: ALA = Алматы, SCO = Ақтау, CIT = Шымкент; деньги в тенге (₸), расход Meta также в долларах.`;

function planText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|li|tr|h\d|section|div)>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

type SalesRow = { br: string; doc: string; mgr: string; cat: string; st: string; agreed: boolean | null; n: number; amt: number };
function salesSummary(rows: SalesRow[]) {
  const by = (key: (r: SalesRow) => string) => {
    const m: Record<string, { n: number; agreed: number; done: number; lost: number; not_contacted: number; amount_kzt: number }> = {};
    for (const r of rows) {
      const k = key(r), a = (m[k] ??= { n: 0, agreed: 0, done: 0, lost: 0, not_contacted: 0, amount_kzt: 0 });
      const n = Number(r.n);
      a.n += n; a.amount_kzt += Number(r.amt);
      if (r.agreed) a.agreed += n;
      if (r.st === "completed") a.done += n;
      if (r.st === "lost") a.lost += n;
      if (r.st === "new_recommendation") a.not_contacted += n;
    }
    return m;
  };
  return { by_branch: by((r) => r.br), by_diagnosis: by((r) => r.cat), by_doctor: by((r) => r.doc), by_status: by((r) => r.st) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Claude ещё не подключён: добавьте секрет ANTHROPIC_API_KEY в Supabase." }, 503);

  let body: { question?: string; history?: { role: string; content: string }[] };
  try { body = await req.json(); } catch { return json({ error: "Неверный запрос" }, 400); }
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (!question) return json({ error: "Пустой вопрос" }, 400);
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-6)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 6000) }));

  // Read data as the caller: the RPCs check the "Маркетинг" section themselves.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const today = new Date(Date.now() + 5 * 3600e3); // Asia/Almaty
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 29 * 864e5).toISOString().slice(0, 10);
  const [plan, sales, crm] = await Promise.all([
    sb.rpc("ad_panel_plan"),
    sb.rpc("ad_panel_sales", { p_from: from, p_to: to }),
    sb.rpc("ad_panel_crm", { p_from: from, p_to: to }),
  ]);
  if (plan.error?.code === "42501" || sales.error?.code === "42501") return json({ error: "Нет доступа к разделу «Маркетинг»." }, 403);

  const context = [
    `Сегодня ${to}. Период цифр: ${from} — ${to}.`,
    `## Маркетинговый план\n${planText(plan.data?.html ?? "") || "(нет)"}`,
    `## Реклама и записи по филиалам (amoCRM + Meta)\n${JSON.stringify(crm.data ?? [])}`,
    `## Продажи: пациенты у менеджера после консультации врача (рекомендации операций)\n${JSON.stringify(salesSummary((sales.data?.rows ?? []) as SalesRow[]))}`,
    `## Причины отказа (сгруппированы)\n${JSON.stringify(sales.data?.reasons ?? [])}`,
  ].join("\n\n");

  const client = new Anthropic({ apiKey });
  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: context, cache_control: { type: "ephemeral" } },
      ],
      messages: [...history, { role: "user", content: question }],
    });
    if (res.stop_reason === "refusal") return json({ error: "Claude не стал отвечать на этот вопрос. Переформулируйте его." }, 422);
    const answer = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    return json({ answer, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "Ключ ANTHROPIC_API_KEY не подошёл." }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Слишком много запросов к Claude, попробуйте через минуту." }, 429);
    if (e instanceof Anthropic.APIConnectionError) return json({ error: "Нет связи с Claude, попробуйте ещё раз." }, 502);
    if (e instanceof Anthropic.APIError) return json({ error: `Claude вернул ошибку ${e.status}: ${String(e.message).slice(0, 200)}` }, 502);
    return json({ error: "Внутренняя ошибка" }, 500);
  }
});
