import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------------------------------------------------------- *
 * Démarrage
 * ---------------------------------------------------------------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

const configured = !SUPABASE_URL.includes("TON-PROJET") && !SUPABASE_ANON_KEY.includes("TA_CLE");
if (!configured) {
  $("#setup").hidden = false;
  throw new Error("config.js n'est pas configuré");
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

let user = null;
let recipes = [];
let current = null;     // id de la recette ouverte
let editingId = null;   // id en cours de modification (null = nouvel import)
let imageBlob = null;   // capture d'écran choisie
let pendingShare = null;

const CACHE_KEY = "cookbook-cache-v1";

/* ---------------------------------------------------------------- *
 * Navigation
 * ---------------------------------------------------------------- */
function show(v) {
  for (const n of ["login", "list", "import", "detail"]) $("#v-" + n).hidden = n !== v;
  if (v !== "detail") current = null;
  window.scrollTo(0, 0);
}
document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => show("list")));
$("#go-import").onclick = $("#go-import2").onclick = () => { resetImport(); show("import"); };

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------------------------------------------------------------- *
 * Connexion par code à 6 chiffres (fonctionne aussi dans l'app installée sur iPhone)
 * ---------------------------------------------------------------- */
let loginEmail = "";
function loginMsg(text) { const m = $("#l-msg"); m.textContent = text || ""; m.hidden = !text; }

$("#f-email").onsubmit = async (e) => {
  e.preventDefault();
  loginEmail = $("#l-email").value.trim();
  const btn = $("#l-send"); btn.disabled = true; loginMsg("");
  const { error } = await sb.auth.signInWithOtp({ email: loginEmail, options: { shouldCreateUser: true } });
  btn.disabled = false;
  if (error) return loginMsg(error.status === 429
    ? "Trop de demandes. Attends une minute avant de redemander un code."
    : "Le code n'a pas pu être envoyé. Vérifie ton courriel et réessaie.");
  $("#l-sent-to").textContent = loginEmail;
  $("#f-email").hidden = true; $("#f-code").hidden = false;
  $("#l-code").value = ""; $("#l-code").focus();
};

$("#f-code").onsubmit = async (e) => {
  e.preventDefault();
  const token = $("#l-code").value.replace(/\D/g, "");
  const btn = $("#l-verify"); btn.disabled = true; loginMsg("");
  const { error } = await sb.auth.verifyOtp({ email: loginEmail, token, type: "email" });
  btn.disabled = false;
  if (error) loginMsg("Ce code est invalide ou expiré. Vérifie les chiffres ou demande un nouveau code.");
};

$("#l-back").onclick = () => { $("#f-code").hidden = true; $("#f-email").hidden = false; loginMsg(""); };

$("#logout").onclick = async () => {
  await sb.auth.signOut();
  try { localStorage.removeItem(CACHE_KEY); } catch {}
  recipes = []; renderList();
};

sb.auth.onAuthStateChange((_event, session) => {
  const next = session?.user ?? null;
  const changed = next?.id !== user?.id;
  user = next;
  $("#logout").hidden = !user;
  if (!user) { show("login"); return; }
  if (changed) onSignedIn();
});

async function onSignedIn() {
  loadCache();
  show("list");
  await loadRecipes();
  await consumeShare();
}

/* ---------------------------------------------------------------- *
 * Données
 * ---------------------------------------------------------------- */
const fromRow = (r) => ({
  id: r.id, title: r.title, servings: r.servings, prepMinutes: r.prep_minutes, cookMinutes: r.cook_minutes,
  ingredients: r.ingredients || [], steps: r.steps || [], tags: r.tags || [],
  sourceUrl: r.source_url, sourcePlatform: r.source_platform, createdAt: r.created_at,
});
const toRow = (r) => ({
  title: r.title, servings: r.servings, prep_minutes: r.prepMinutes, cook_minutes: r.cookMinutes,
  ingredients: r.ingredients, steps: r.steps, tags: r.tags,
  source_url: r.sourceUrl, source_platform: r.sourcePlatform, raw_caption: r.rawCaption,
});

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c && c.userId === user.id) { recipes = c.recipes; renderList(); }
  } catch {}
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: user.id, recipes })); } catch {}
}

async function loadRecipes() {
  const { data, error } = await sb
    .from("recipes")
    .select("id,title,servings,prep_minutes,cook_minutes,ingredients,steps,tags,source_url,source_platform,created_at")
    .order("created_at", { ascending: false });
  $("#offline").hidden = !error;
  if (error) { renderList(); return; }
  recipes = data.map(fromRow);
  saveCache();
  renderList();
}

/* ---------------------------------------------------------------- *
 * Liste
 * ---------------------------------------------------------------- */
const totalMin = (r) => { const t = (+r.prepMinutes || 0) + (+r.cookMinutes || 0); return t ? `${t} min` : ""; };

$("#q").oninput = renderList;
function renderList() {
  const q = $("#q").value.trim().toLowerCase();
  const shown = recipes.filter((r) => !q || [r.title, ...r.ingredients, ...r.tags].join(" ").toLowerCase().includes(q));
  $("#count").textContent = recipes.length ? `${recipes.length} recette${recipes.length > 1 ? "s" : ""}` : "Aucune recette pour l'instant";
  $("#empty").hidden = recipes.length > 0;
  $("#q").hidden = recipes.length === 0;
  $("#list").innerHTML = shown.map((r) => `
    <button class="card" data-id="${esc(r.id)}">
      <span class="row spread"><span class="t">${esc(r.title)}</span><span class="chip">${esc(r.sourcePlatform || "Web")}</span></span>
      <span class="meta">
        ${totalMin(r) ? `<span>${totalMin(r)}</span>` : ""}
        ${r.servings ? `<span>${r.servings} portions</span>` : ""}
        <span>${r.ingredients.length} ingrédients</span>
        ${r.tags.slice(0, 3).map((t) => `<span>#${esc(t)}</span>`).join("")}
      </span>
    </button>`).join("") || (recipes.length ? `<p class="muted">Aucune recette ne correspond à « ${esc(q)} ».</p>` : "");
  $("#list").querySelectorAll(".card").forEach((c) => (c.onclick = () => openRecipe(c.dataset.id)));
}

/* ---------------------------------------------------------------- *
 * Fiche recette
 * ---------------------------------------------------------------- */
function openRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  $("#act-row").hidden = false; $("#del-confirm").hidden = true;
  $("#detail").innerHTML = `
    <div class="row spread"><h2>${esc(r.title)}</h2><span class="chip">${esc(r.sourcePlatform || "Web")}</span></div>
    <div class="meta">
      ${r.servings ? `<span>${r.servings} portions</span>` : ""}
      ${r.prepMinutes ? `<span>Prépa ${r.prepMinutes} min</span>` : ""}
      ${r.cookMinutes ? `<span>Cuisson ${r.cookMinutes} min</span>` : ""}
    </div>
    <h3>Ingrédients</h3>
    <ul class="ing">${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join("") || "<li class='muted'>Aucun</li>"}</ul>
    <h3>Étapes</h3>
    <ol class="stp">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("") || "<li class='muted'>Aucune</li>"}</ol>
    ${r.sourceUrl ? `<h3>Source</h3><a class="src" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">${esc(r.sourceUrl)}</a>` : ""}`;
  show("detail");
  current = id;
}

$("#del").onclick = () => { $("#act-row").hidden = true; $("#del-confirm").hidden = false; };
$("#del-no").onclick = () => { $("#act-row").hidden = false; $("#del-confirm").hidden = true; };
$("#del-yes").onclick = async () => {
  const id = current;
  const { error } = await sb.from("recipes").delete().eq("id", id);
  if (error) { toast("La suppression a échoué. Vérifie ta connexion."); return; }
  recipes = recipes.filter((r) => r.id !== id); saveCache(); renderList();
  show("list"); toast("Recette supprimée");
};
$("#edit").onclick = () => {
  const r = recipes.find((x) => x.id === current);
  if (!r) return;
  resetImport();
  editingId = r.id;
  $("#i-url").value = r.sourceUrl || "";
  fillReview(r, "");
  show("import");
};

/* ---------------------------------------------------------------- *
 * Import
 * ---------------------------------------------------------------- */
function platformOf(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("instagram")) return "Instagram";
  if (u.includes("tiktok")) return "TikTok";
  if (u.includes("facebook") || u.includes("fb.watch")) return "Facebook";
  if (u.includes("pinterest") || u.includes("pin.it")) return "Pinterest";
  if (u.includes("youtube") || u.includes("youtu.be")) return "YouTube";
  return u ? "Web" : "Texte collé";
}
const firstUrl = (s) => (String(s || "").match(/https?:\/\/[^\s"'<>]+/) || [""])[0];

function step(n) {
  $("#imp-1").hidden = n !== 1; $("#imp-2").hidden = n !== 2;
  $("#st1").className = n === 1 ? "on" : ""; $("#st2").className = n === 2 ? "on" : "";
}
function tab(which) {
  $("#tab-text").setAttribute("aria-selected", String(which === "text"));
  $("#tab-image").setAttribute("aria-selected", String(which === "image"));
  $("#p-text").hidden = which !== "text"; $("#p-image").hidden = which !== "image";
}
$("#tab-text").onclick = () => tab("text");
$("#tab-image").onclick = () => tab("image");

function resetImport() {
  editingId = null;
  $("#i-url").value = ""; $("#i-caption").value = "";
  setImage(null);
  $("#imp-msg").hidden = true;
  $("#r-heading").textContent = "Vérifie la recette";
  $("#save").textContent = "Ajouter au cookbook";
  tab("text"); step(1);
}
$("#back-1").onclick = () => (editingId ? openRecipe(editingId) : step(1));

function setImage(blob) {
  imageBlob = blob;
  const img = $("#i-preview");
  if (img.src) URL.revokeObjectURL(img.src);
  if (blob) { img.src = URL.createObjectURL(blob); img.hidden = false; }
  else { img.removeAttribute("src"); img.hidden = true; }
  $("#i-clear").hidden = !blob;
  $("#i-drop-hint").hidden = !!blob;
}
$("#i-file").onchange = (e) => { const f = e.target.files?.[0]; if (f) setImage(f); e.target.value = ""; };
$("#i-clear").onclick = () => setImage(null);

const EXAMPLE = `Mes cookies ultra moelleux 🍪 (enregistre pour plus tard !)

Pour 12 cookies :
- 125 g de beurre mou
- 100 g de cassonade
- 50 g de sucre blanc
- 1 œuf
- 200 g de farine
- 1 c. à café de levure chimique
- 1 pincée de sel
- 150 g de pépites de chocolat

Préparation (15 min) :
1. Mélange le beurre avec les deux sucres jusqu'à ce que ce soit crémeux.
2. Ajoute l'œuf, puis la farine, la levure et le sel.
3. Incorpore les pépites de chocolat.
4. Forme des boules et dépose-les sur une plaque.
5. Cuis 10 min à 180 °C. Ils doivent être encore mous au centre !

#cookies #recettefacile #dessert`;
$("#try-example").onclick = () => {
  $("#i-url").value = "https://www.instagram.com/p/exemple-cookies/";
  $("#i-caption").value = EXAMPLE;
  tab("text");
};

// Réduit la capture avant envoi (l'IA n'a pas besoin de plus de ~1600 px)
async function imageToBase64(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: btoa(bin), mediaType: "image/jpeg" };
}

async function errorMessage(error) {
  try {
    const body = await error.context.json();
    if (body?.message) return body.message;
  } catch {}
  return "L'extraction a échoué. Vérifie ta connexion et réessaie.";
}

$("#extract").onclick = async () => {
  const url = $("#i-url").value.trim();
  const caption = $("#i-caption").value.trim();
  const msg = $("#imp-msg");
  msg.hidden = true;

  if (!caption && !imageBlob && !/tiktok\.com/i.test(url)) {
    msg.textContent = url
      ? "Pour ce réseau, on ne peut pas lire la légende depuis le lien. Colle le texte ou ajoute une capture d'écran."
      : "Colle la légende de la publication ou ajoute une capture d'écran.";
    msg.hidden = false;
    return;
  }

  const btn = $("#extract");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Analyse…';
  try {
    const body = { url, caption };
    if (imageBlob) body.image = await imageToBase64(imageBlob);
    const { data, error } = await sb.functions.invoke("extract-recipe", { body });
    if (error) throw error;
    if (data.captionFetched && data.caption) $("#i-caption").value = data.caption;
    fillReview(data.recipe, data.captionFetched
      ? "Légende récupérée depuis TikTok et analysée par Claude. Vérifie et corrige si besoin."
      : "Analysée par Claude. Vérifie et corrige si besoin.");
  } catch (err) {
    // Secours : analyse locale simple si le serveur est injoignable et qu'on a le texte
    const httpError = err?.name === "FunctionsHttpError";
    if (caption && !httpError) {
      fillReview(parseLocal(caption), "Analyse simple hors ligne. Vérifie bien chaque champ.");
    } else {
      msg.textContent = httpError ? await errorMessage(err) : "L'extraction a échoué. Vérifie ta connexion et réessaie.";
      msg.hidden = false;
    }
  } finally {
    btn.disabled = false; btn.textContent = "Extraire la recette";
  }
};

function fillReview(r, how) {
  const url = $("#i-url").value.trim();
  $("#r-platform").textContent = platformOf(url);
  $("#r-how").textContent = how; $("#r-how").hidden = !how;
  $("#r-title").value = r.title || "";
  $("#r-servings").value = r.servings ?? "";
  $("#r-prep").value = r.prepMinutes ?? "";
  $("#r-cook").value = r.cookMinutes ?? "";
  $("#r-ing").value = (r.ingredients || []).join("\n");
  $("#r-steps").value = (r.steps || []).join("\n");
  $("#r-tags").value = (r.tags || []).join(", ");
  $("#r-heading").textContent = editingId ? "Modifier la recette" : "Vérifie la recette";
  $("#save").textContent = editingId ? "Enregistrer" : "Ajouter au cookbook";
  $("#save-msg").hidden = true;
  step(2); window.scrollTo(0, 0);
}

$("#imp-2").onsubmit = async (e) => {
  e.preventDefault();
  const lines = (id) => $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
  const num = (id) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) && v >= 0 ? v : null; };
  const url = $("#i-url").value.trim();
  const r = {
    title: $("#r-title").value.trim(),
    servings: num("#r-servings"), prepMinutes: num("#r-prep"), cookMinutes: num("#r-cook"),
    ingredients: lines("#r-ing"), steps: lines("#r-steps"),
    tags: $("#r-tags").value.split(",").map((s) => s.trim().replace(/^#/, "").toLowerCase()).filter(Boolean),
    sourceUrl: url || null, sourcePlatform: platformOf(url),
    rawCaption: $("#i-caption").value.slice(0, 8000) || null,
  };
  const btn = $("#save"); btn.disabled = true;
  try {
    const row = toRow(r);
    if (editingId) delete row.raw_caption;
    const q = editingId
      ? sb.from("recipes").update(row).eq("id", editingId).select().single()
      : sb.from("recipes").insert(row).select().single();
    const { data, error } = await q;
    if (error) throw error;
    const saved = fromRow(data);
    recipes = [saved, ...recipes.filter((x) => x.id !== saved.id)]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    saveCache(); renderList();
    const wasEdit = !!editingId;
    editingId = null;
    openRecipe(saved.id);
    toast(wasEdit ? "Recette mise à jour" : "Ajoutée à ton cookbook");
  } catch {
    $("#save-msg").textContent = "La recette n'a pas pu être enregistrée. Vérifie ta connexion et réessaie.";
    $("#save-msg").hidden = false;
  } finally {
    btn.disabled = false;
  }
};

/* ---------------------------------------------------------------- *
 * Contenu partagé vers l'app
 *  - Android : feuille de partage -> service worker -> cache "share-inbox"
 *  - iPhone  : Raccourci Apple qui ouvre  ./?url=…  (ou ?text=…)
 * ---------------------------------------------------------------- */
async function readShare() {
  const p = new URLSearchParams(location.search);
  let share = null;

  if (p.get("shared") === "1" && "caches" in window) {
    const cache = await caches.open("share-inbox");
    const metaRes = await cache.match("./__shared/meta");
    const imgRes = await cache.match("./__shared/image");
    if (metaRes) {
      share = await metaRes.json();
      share.image = imgRes ? await imgRes.blob() : null;
    }
    await cache.delete("./__shared/meta");
    await cache.delete("./__shared/image");
  } else if (p.has("url") || p.has("text")) {
    share = { url: p.get("url") || "", text: p.get("text") || "", title: p.get("title") || "", image: null };
  }

  if (p.toString()) history.replaceState(null, "", location.pathname);
  return share;
}

async function consumeShare() {
  const share = pendingShare;
  pendingShare = null;
  if (!share) return;
  resetImport();
  const url = share.url || firstUrl(share.text) || firstUrl(share.title);
  // Le texte partagé est parfois juste le lien : on ne le garde comme légende que s'il contient autre chose.
  const text = [share.title, share.text].filter(Boolean).join("\n").replace(url, "").trim();
  $("#i-url").value = url;
  if (text.length > 20) $("#i-caption").value = text;
  if (share.image) { setImage(share.image); tab("image"); }
  show("import");

  const canAuto = share.image || text.length > 20 || /tiktok\.com/i.test(url);
  if (canAuto) $("#extract").click();
  else {
    const m = $("#imp-msg");
    m.textContent = "Lien reçu. Instagram ne donne pas la légende : colle-la ici ou ajoute une capture d'écran.";
    m.hidden = false;
  }
}

readShare().then(async (s) => {
  pendingShare = s;
  const { data } = await sb.auth.getSession();
  if (!data.session) show("login");
  else if (user) consumeShare(); // déjà connecté et liste chargée
}).catch(() => {});

/* ---------------------------------------------------------------- *
 * Analyse locale de secours (sans réseau)
 * ---------------------------------------------------------------- */
function parseLocal(text) {
  const clean = (s) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
  const tags = [...text.matchAll(/#([\p{L}\d_]+)/gu)].map((m) => m[1].toLowerCase()).slice(0, 4);
  const lines = text.split("\n").map((l) => l.replace(/#[\p{L}\d_]+/gu, "").trim()).filter(Boolean);
  const title = clean((lines[0] || "").replace(/\(.*?\)/g, ""));
  const ingredients = [], steps = [];
  let mode = null;
  for (const l of lines.slice(1)) {
    const low = l.toLowerCase();
    if (/ingr[ée]dient|^pour \d+/.test(low)) { mode = "i"; continue; }
    if (/pr[ée]paration|[ée]tapes|instructions/.test(low)) { mode = "s"; continue; }
    const bullet = /^[-•▪*·–]\s*/.test(l), numbered = /^\d+[.)]\s+/.test(l);
    const body = clean(l.replace(/^[-•▪*·–]\s*/, "").replace(/^\d+[.)]\s+/, ""));
    if (!body) continue;
    if (numbered || mode === "s") steps.push(body);
    else if (bullet || mode === "i") ingredients.push(body);
  }
  const g = (re) => { const m = text.match(re); return m ? parseInt(m[1], 10) : null; };
  return {
    title, tags, ingredients, steps,
    servings: g(/pour\s+(\d+)/i),
    prepMinutes: g(/pr[ée]paration\s*\(?\s*(\d+)\s*min/i),
    cookMinutes: g(/cuis\w*\s+(\d+)\s*min/i),
  };
}
