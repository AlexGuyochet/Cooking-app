Mon Cookbook — PWA + Supabase
Une app web installable sur téléphone pour garder les recettes vues sur Instagram, TikTok, Pinterest…
Import par légende collée, par capture d'écran, ou par lien TikTok (légende récupérée automatiquement).
Extraction par Claude côté serveur (Edge Function Supabase) : titre, portions, temps, ingrédients, étapes, tags.
Cookbook : liste, recherche, fiche, modification, suppression. Lecture hors ligne.
Partage depuis Instagram : directement dans la feuille de partage sur Android, via un Raccourci sur iPhone.
Connexion par code à 6 chiffres envoyé par courriel (pas de mot de passe).
```
cookbook-pwa/
├── index.html            écrans de l'app
├── styles.css
├── app.js                logique (Supabase, import, partage)
├── config.js             ← à remplir (URL + clé anon Supabase)
├── manifest.webmanifest  installation + cible de partage Android
├── sw.js                 service worker (hors ligne + réception des partages)
├── icons/
└── supabase/
    ├── migrations/0001_recipes.sql      table + sécurité RLS
    └── functions/extract-recipe/index.ts appel à Claude
```
Aucune étape de build : ce sont des fichiers statiques.
---
1. Créer le projet Supabase (10 min)
Crée un compte sur supabase.com puis New project.
SQL Editor → colle le contenu de `supabase/migrations/0001_recipes.sql` → Run.
Project Settings → API : copie la Project URL et la clé anon public dans `config.js`.
Connexion par code
Par défaut Supabase envoie un lien magique. Sur iPhone, ce lien s'ouvrirait dans Safari et pas dans l'app installée, donc on utilise un code.
Authentication → Email Templates : dans Magic Link et dans Confirm signup (utilisé à la première connexion), remplace le contenu par :
```html
<h2>Ton code Cookbook</h2>
<p>Entre ce code dans l'app : <strong>{{ .Token }}</strong></p>
<p>Il expire dans une heure.</p>
```
> Le service de courriel intégré de Supabase est limité à quelques envois par heure : parfait pour tester. Avant d'inviter des utilisateurs, branche un SMTP (Resend, Postmark…) dans **Authentication → SMTP Settings**.
2. Déployer la fonction d'extraction (10 min)
Il te faut une clé API Anthropic : console.anthropic.com → API Keys.
Avec la CLI Supabase (installation) :
```bash
cd cookbook-pwa
supabase login
supabase link --project-ref TON_PROJECT_REF      # visible dans l'URL du dashboard
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy extract-recipe
```
Sans la CLI : Edge Functions → Deploy a new function → Via editor, nomme-la `extract-recipe`, colle `index.ts`, puis ajoute le secret `ANTHROPIC_API_KEY` dans Edge Functions → Secrets.
Le modèle par défaut est Claude Haiku 4.5 (rapide et peu coûteux). Pour en changer, ajoute le secret `ANTHROPIC_MODEL`.
La fonction exige un utilisateur connecté (vérification du JWT activée par défaut) : personne ne peut consommer ta clé Anthropic sans compte.
3. Mettre l'app en ligne (5 min)
Une PWA doit être servie en HTTPS. Le plus simple :
Netlify : app.netlify.com/drop → glisse le dossier `cookbook-pwa`.
ou Vercel, Cloudflare Pages, GitHub Pages : n'importe quel hébergement statique.
L'app doit être à la racine du domaine (ex. `https://mon-cookbook.netlify.app/`).
Ensuite dans Supabase, Authentication → URL Configuration : mets ton URL dans Site URL.
Pour tester en local : `npx serve .` puis ouvre `http://localhost:3000`.
4. Installer l'app sur le téléphone
iPhone : ouvre l'URL dans Safari → bouton Partager → Sur l'écran d'accueil.
Android : ouvre l'URL dans Chrome → menu ⋮ → Installer l'application.
5. Partager depuis Instagram
Android — automatique
Une fois l'app installée depuis Chrome, Cookbook apparaît dans la feuille de partage.
Dans Instagram : ••• ou ✈︎ → Partager vers… → Cookbook.
Partager une capture d'écran (depuis la galerie) → l'extraction démarre toute seule.
Partager un lien TikTok → la légende est récupérée et l'extraction démarre.
Partager un lien Instagram → l'app s'ouvre avec le lien ; colle la légende ou ajoute une capture.
iPhone — avec un Raccourci Apple
iOS ne laisse pas les PWA apparaître dans la feuille de partage. Un Raccourci fait le pont :
Ouvre l'app Raccourcis → +.
Touche le nom → renomme en Ajouter au Cookbook.
Touche ⓘ → active Afficher dans la feuille de partage. Types acceptés : URL et Texte.
Ajoute l'action Encoder en URL (entrée : Entrée du raccourci).
Ajoute l'action Texte avec : `https://TON-DOMAINE/?url=` puis la variable Texte encodé en URL.
Ajoute l'action Ouvrir les URL.
Dans Instagram : ✈︎ → Plus → Ajouter au Cookbook.
> Sur iPhone, le Raccourci ouvre le lien dans Safari, pas dans l'app installée (qui a sa propre session). Connecte-toi donc aussi dans Safari, ou colle la légende directement dans l'app. Pour une vraie intégration dans la feuille de partage d'iOS, il faudra une app native (Expo + Share Extension).
---
Limites connues
Instagram ne fournit pas la légende à partir d'un lien (pas d'API publique simple, et le scraping enfreint leurs conditions). D'où la légende collée ou la capture d'écran.
Les recettes dites à l'oral dans une vidéo ne sont pas extraites (étape suivante : transcription).
Hors ligne, on peut consulter le cookbook mais pas importer.
Coûts indicatifs
Supabase : gratuit pour démarrer.
Hébergement statique : gratuit.
Claude Haiku : une extraction coûte une fraction de centime (plus avec une capture d'écran).
Mettre à jour l'app
Après une modification des fichiers, change `VERSION` dans `sw.js` (ex. `cookbook-v2`) pour que les téléphones récupèrent la nouvelle version.
