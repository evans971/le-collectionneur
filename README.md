# Le Collectionneur — version en ligne

Ce dossier contient le jeu complet et son serveur :

- `public/` : le jeu (s'ouvre dans le navigateur, PC et mobile).
- `server.js` : le serveur. Il gère les salons entre amis (code d'accès), la file « En ligne » (départ en 30 s) et le classement.

Tout le monde peut jouer avec le lien, sans compte.

---

## Mettre le jeu en ligne gratuitement (Render, environ 15 minutes)

### 1. Mettre le dossier sur GitHub
1. Crée un compte sur https://github.com.
2. Crée un nouveau dépôt (bouton **New**), par exemple `le-collectionneur`.
3. Sur la page du dépôt, clique **uploading an existing file**.
4. Glisse **tout le contenu** de ce dossier, avec les dossiers `public`, puis clique **Commit changes**.

### 2. Héberger sur Render
1. Crée un compte sur https://render.com (« Sign in with GitHub », c'est le plus simple).
2. Clique **New +** puis **Blueprint**, et choisis ton dépôt. Render lit le fichier `render.yaml`.
   Si on te demande `DATABASE_URL`, laisse vide pour l'instant (voir l'étape 3).
3. Clique **Apply**. Au bout de 2 à 3 minutes, Render te donne une adresse du type
   `https://le-collectionneur.onrender.com`. C'est le lien du jeu à partager.

### 3. Garder les comptes et le classement (indispensable)
Le jeu a des comptes joueurs (pièces, personnages achetés, leurres, succès) et un classement.
Sur l'offre gratuite de Render, les fichiers sont effacés à chaque redémarrage : **sans base de données, tous les comptes seraient perdus**.
Pour le garder, branche une base de données gratuite :
1. Crée un compte sur https://neon.tech et un projet (gratuit).
2. Copie la « connection string » (elle commence par `postgresql://`).
3. Sur Render : ton service, puis **Environment**, puis **Add Environment Variable** :
   nom `DATABASE_URL`, valeur = la connection string. Enregistre : Render redémarre le serveur.

Le serveur crée tout seul la table des scores.

### Bon à savoir
- Sur l'offre gratuite, Render met le serveur en veille après 15 minutes sans joueur.
  La première connexion après une pause prend environ 1 minute, ensuite c'est rapide.
- Pour mettre à jour le jeu, remplace les fichiers sur GitHub : Render redéploie tout seul.

---

## Option : afficher le jeu sur itch.io
itch.io est une plateforme de jeux très connue. Le serveur reste sur Render, itch.io affiche juste le jeu.
1. Ouvre `public/config.js` et écris l'adresse de ton serveur Render :
   `window.GAME_SERVER = "https://le-collectionneur.onrender.com";`
2. Fais un fichier .zip qui contient **le contenu** du dossier `public` (index.html à la racine du zip).
3. Sur https://itch.io : **Upload new project**, type **HTML**, envoie le zip,
   coche **This file will be played in the browser**, et active **Mobile friendly** et **Fullscreen button**.

---

## Tester sur ton ordinateur
Il faut Node.js 18 ou plus (https://nodejs.org).
```
npm install
npm start
```
Puis ouvre http://localhost:3000 dans deux onglets pour tester un salon entre amis.

---

## Mise à jour automatique sur itch.io
Le fichier `.github/workflows/itch.yml` envoie le dossier `public` sur itch.io à chaque modification sur GitHub.
À faire une seule fois :
1. Sur itch.io : **Settings → API keys → Generate new API key**, puis copie la clé.
2. Sur GitHub, dans ce dépôt : **Settings → Secrets and variables → Actions → New repository secret**.
   Nom : `BUTLER_API_KEY`, valeur : la clé itch.io.
3. Onglet **Actions** du dépôt → « Publier sur itch.io » → **Run workflow**.
4. Sur itch.io, dans **Edit game → Uploads**, un fichier « html5 » apparaît : coche **This file will be played in the browser**,
   supprime l'ancien zip envoyé à la main, puis **Save**.
Ensuite, chaque mise à jour du jeu arrive toute seule sur itch.io en 1 à 2 minutes.
