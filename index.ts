// Edge Function : extract-recipe
// Reçoit { caption?, url?, image?: { data: base64, mediaType } }
// Renvoie { recipe, caption, captionFetched }
//
// La clé Anthropic reste côté serveur (secret ANTHROPIC_API_KEY),
// jamais dans l'app.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
const MAX_CAPTION = 12000;
const MAX_IMAGE_B64 = 6_500_000; // ~5 Mo une fois décodé, limite de l'API

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const PROMPT = `Tu extrais une recette depuis une publication de réseau social (Instagram, TikTok, Pinterest…).
La source peut être la légende (texte) et/ou une capture d'écran.
Réponds uniquement avec un objet JSON de cette forme, sans autre texte :
{"title": string, "servings": number|null, "prepMinutes": number|null, "cookMinutes": number|null,
 "ingredients": string[], "steps": string[], "tags": string[]}
Règles :
- garde la langue d'origine de la recette ;
- un ingrédient par entrée, avec sa quantité (ex. "200 g de farine") ;
- une étape par entrée, sans numéro ;
- retire emojis, hashtags, mentions et appels à s'abonner du titre et des étapes ;
- tags : 1 à 4 mots-clés courts en minuscules (type de plat, régime, ingrédient phare) ;
- null quand une valeur n'est pas indiquée ; n'invente pas de quantités.
Si aucune recette n'est présente, renvoie {"title": "", "ingredients": [], "steps": [], "tags": []}.`;

// TikTok expose la légende publiquement via son endpoint oEmbed (champ "title").
async function fetchTikTokCaption(url: string): Promise<string> {
  try {
    const r = await fetch(
      "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url),
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return "";
    const j = await r.json();
    return typeof j.title === "string" ? j.title : "";
  } catch {
    return "";
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const toInt = (v: unknown) => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const toList = (v: unknown) =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : [];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "missing_api_key", message: "Le secret ANTHROPIC_API_KEY n'est pas configuré." }, 500);

  let body: { caption?: string; url?: string; image?: { data?: string; mediaType?: string } };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", message: "Corps JSON invalide." }, 400);
  }

  const url = (body.url ?? "").trim();
  let caption = (body.caption ?? "").trim();
  let captionFetched = false;

  if (!caption && /tiktok\.com/i.test(url)) {
    caption = (await fetchTikTokCaption(url)).trim();
    captionFetched = caption.length > 0;
  }

  const image = body.image?.data ? body.image : null;
  if (image && image.data!.length > MAX_IMAGE_B64) {
    return json({ error: "image_too_large", message: "La capture est trop lourde. Essaie avec une image plus petite." }, 413);
  }
  const mediaType = image?.mediaType ?? "image/jpeg";
  if (image && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mediaType)) {
    return json({ error: "bad_image", message: "Format d'image non pris en charge." }, 415);
  }

  if (!caption && !image) {
    return json({
      error: "no_content",
      message: "Impossible de lire la légende depuis ce lien. Colle le texte de la publication ou ajoute une capture d'écran.",
    }, 422);
  }

  const content: unknown[] = [];
  if (image) {
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: image.data } });
  }
  content.push({
    type: "text",
    text: PROMPT +
      (caption ? `\n\nLégende :\n"""${caption.slice(0, MAX_CAPTION)}"""` : "") +
      (image ? "\n\nLa capture d'écran jointe fait partie de la publication." : ""),
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic error", res.status, detail);
    return json({ error: "ai_error", message: "L'analyse de la recette a échoué. Réessaie dans un instant." }, 502);
  }

  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  const raw = parseJson(text);
  if (!raw) return json({ error: "parse_error", message: "La réponse de l'IA n'a pas pu être lue. Réessaie." }, 502);

  const recipe = {
    title: String(raw.title ?? "").trim(),
    servings: toInt(raw.servings),
    prepMinutes: toInt(raw.prepMinutes),
    cookMinutes: toInt(raw.cookMinutes),
    ingredients: toList(raw.ingredients),
    steps: toList(raw.steps),
    tags: toList(raw.tags).map((t) => t.replace(/^#/, "").toLowerCase()).slice(0, 6),
  };

  if (!recipe.title && recipe.ingredients.length === 0) {
    return json({ error: "no_recipe", message: "Aucune recette trouvée dans ce contenu." }, 422);
  }

  return json({ recipe, caption, captionFetched });
});
