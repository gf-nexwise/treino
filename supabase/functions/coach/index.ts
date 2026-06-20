// Treino — Edge Function "coach"
// Proxy seguro entre o app e a OpenAI. A chave da OpenAI vive aqui como secret,
// NUNCA chega no navegador. Só usuários logados (JWT válido) usam, com limite diário.
//
// Deploy (CLI):   supabase functions deploy coach
// Secrets:        supabase secrets set OPENAI_API_KEY=sk-...   (e opcional OPENAI_MODEL / AI_DAILY_LIMIT)
//
// Tarefas aceitas no body: { task: "progressao"|"insights"|"resumo"|"exames", context: {...} }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "80");

const PROMPTS: Record<string, string> = {
  progressao:
    "Você é um coach de musculação direto e prático. Recebe um exercício, o esquema de séries, o tipo (força/hipertrofia), a regra de progressão e o histórico recente (carga×reps por sessão). " +
    "Responda em português, curto (3 a 5 linhas): (1) a sugestão CONCRETA de carga e reps pra próxima sessão seguindo a regra; (2) uma leitura rápida da evolução (subindo, travado, regredindo). " +
    "Se faltar histórico, oriente como começar. Não invente números que não estão no histórico. Sem rodeios, sem listas longas.",
  insights:
    "Você é um coach de musculação. Recebe o histórico de um exercício (carga×reps por sessão). " +
    "Em português e curto (3 a 5 linhas): resuma a evolução, aponte estagnação ou PRs e diga o próximo passo. Baseie-se só nos dados recebidos.",
  resumo:
    "Você é um coach de musculação. Recebe o treino do dia (nome, foco) e os exercícios com a última sessão de cada. " +
    "Faça um briefing útil e motivador em português, curto (4 a 6 linhas): o que focar hoje, onde a pessoa travou na última e o que tentar, e um lembrete de progressão. Direto, sem encheção.",
  exames:
    "Você é um EDUCADOR EM SAÚDE, não um médico. Recebe exames de sangue/hormonais com valores informados pela pessoa (contexto de quem treina e pode usar testosterona). " +
    "Comece SEMPRE a resposta exatamente com: '⚠️ Isto é educativo, não é diagnóstico. Leve seus exames a um médico.' " +
    "Para cada valor: explique em português simples o que aquilo indica em linhas gerais e se costuma ser visto como baixo/normal/alto APENAS de forma genérica, deixando claro que faixas variam por laboratório, sexo, idade e contexto. " +
    "NUNCA dê diagnóstico. NUNCA prescreva nem ajuste dose de qualquer substância. NUNCA afirme de forma definitiva que está 'tudo certo' ou 'errado'. " +
    "Destaque o que merece atenção e oriente procurar um endocrinologista. Seja claro e responsável.",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  try {
    // 1. valida o usuário logado a partir do JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: uerr } = await supa.auth.getUser();
    if (uerr || !user) return json({ error: "Não autenticado." }, 401);

    // 2. limite diário por usuário (service role ignora RLS)
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const day = new Date().toISOString().slice(0, 10);
    const { data: usageRow } = await admin
      .from("ai_usage").select("count").eq("user_id", user.id).eq("day", day).maybeSingle();
    const used = usageRow?.count ?? 0;
    if (used >= DAILY_LIMIT) {
      return json({ error: "Limite diário de IA atingido. Tenta amanhã 🙂" }, 429);
    }

    // 3. monta o prompt
    const body = await req.json().catch(() => ({}));
    const sys = PROMPTS[body?.task];
    if (!sys) return json({ error: "Tarefa inválida." }, 400);

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) return json({ error: "OPENAI_API_KEY não configurada no servidor." }, 500);

    // 4. chama a OpenAI
    const oai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify(body?.context ?? {}) },
        ],
      }),
    });
    if (!oai.ok) {
      const detail = (await oai.text()).slice(0, 300);
      return json({ error: "Erro na OpenAI", detail }, 502);
    }
    const out = await oai.json();
    const text = out?.choices?.[0]?.message?.content ?? "(sem resposta)";

    // 5. incrementa o uso
    await admin.from("ai_usage").upsert(
      { user_id: user.id, day, count: used + 1 },
      { onConflict: "user_id,day" },
    );

    return json({ text });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
