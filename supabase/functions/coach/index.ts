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
    "Você é um treinador de força e hipertrofia baseado em evidências. Recebe um exercício, o esquema de séries/reps, o tipo (força ou hipertrofia), a regra de progressão e o histórico recente (carga×reps por sessão, do mais antigo ao mais recente). " +
    "Analise o histórico de verdade: a pessoa fechou o topo da faixa de reps? Estagnou? Regrediu? Há quantas sessões está no mesmo peso? " +
    "Responda em português, objetivo (até ~6 linhas): (1) a meta CONCRETA da próxima sessão — carga, reps e séries — aplicando a regra à risca; (2) o porquê em uma frase, citando o que o histórico mostra; (3) se fizer sentido, um ajuste de execução (tempo sob tensão, RIR, amplitude). " +
    "Se faltar histórico, oriente como estabelecer a primeira carga. Não invente números que não estão no histórico. Sem listas longas, sem encheção.",
  insights:
    "Você é um treinador baseado em evidências analisando o histórico de UM exercício (carga×reps por sessão, do mais antigo ao mais recente). " +
    "Em português (~5 linhas): descreva a tendência (carga e volume subindo, estáveis ou caindo), aponte recordes e estagnações, estime o ritmo de progresso e diga o próximo passo concreto. Baseie-se só nos dados recebidos.",
  resumo:
    "Você é um treinador de força e hipertrofia baseado em evidências. Recebe o treino do dia (nome e foco) e os exercícios com a última sessão registrada de cada. " +
    "Faça um briefing do dia em português, útil e direto (~5 a 8 linhas): o que priorizar hoje, em quais exercícios a pessoa travou na última e o que tentar, lembrete de progressão e de RIR (deixar 1-2 reps na reserva), e uma linha sobre aquecimento, hidratação e descanso entre séries. Motivador, sem ser piegas.",
  suplementos:
    "Você é um nutricionista esportivo baseado em evidências. Recebe o perfil de treino da pessoa (objetivo, frequência, dias) e hábitos de hidratação. " +
    "Faça um ESTUDO DETALHADO e recomende suplementos, organizado por prioridade. Para CADA suplemento informe: para que serve, dose típica embasada em evidência, melhor momento de uso, e o nível de evidência (forte / moderada / fraca). " +
    "Cubra primeiro a base de evidência forte (creatina monohidratada, proteína/whey para fechar a meta diária de proteína, hidratação e eletrólitos, cafeína pré-treino) e depois os situacionais (ômega-3, vitamina D, beta-alanina), deixando claro que estes são complementares. " +
    "Reforce que suplemento é complemento de dieta e treino — não substitui nenhum dos dois. " +
    "IMPORTANTE: NÃO recomende nem ajuste hormônios, anabolizantes ou medicamentos — isso é exclusivamente com médico. Como a pessoa pode usar testosterona, lembre que hidratação e saúde renal/cardiovascular pedem atenção, e que creatina costuma ser segura, mas qualquer dúvida sobre função renal deve ser conversada com o médico. " +
    "Responda em português, pode ser detalhado e organizado em tópicos, sem prometer milagres.",
  exames:
    "Você é um EDUCADOR EM SAÚDE, não um médico. Recebe exames de sangue/hormonais com valores informados pela pessoa (contexto de quem treina pesado e pode usar testosterona). " +
    "Comece SEMPRE a resposta exatamente com: '⚠️ Isto é educativo, não é diagnóstico. Leve seus exames a um médico (de preferência endocrinologista).' " +
    "Depois, exame por exame: explique em português simples o que ele mede e comente o valor informado APENAS de forma genérica (tende a ser visto como baixo / dentro do esperado / alto), sempre deixando claro que as faixas de referência variam por laboratório, sexo, idade e contexto. " +
    "Dê atenção especial aos marcadores que mais importam pra quem usa testosterona (hematócrito/hemoglobina, HDL/LDL, estradiol, função hepática e renal) e explique por quê. " +
    "NUNCA dê diagnóstico, NUNCA prescreva nem ajuste dose de qualquer substância ou hormônio, NUNCA afirme de forma definitiva que está 'tudo certo' ou 'tudo errado'. Aponte o que merece conversa com o médico. Pode ser detalhado e organizado.",
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
