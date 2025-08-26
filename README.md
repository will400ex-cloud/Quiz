# Quiz Live (type Kahoot) — Pack prêt à déployer (Render compatible)

## Démarrage local
```bash
npm install
node server.js
```
- Page animateur : http://localhost:3000/host
- Page joueurs :   http://localhost:3000/

## Déploiement Render (Blueprint)
1. Poussez ces fichiers dans un repo GitHub.
2. Sur https://render.com → **New** → **Blueprint**.
3. Sélectionnez ce repo; Render lit `render.yaml` et crée le service.
4. Aucune route spéciale côté Render : la route `/host` est gérée par Express.
5. URL finale :
   - `https://votre-app.onrender.com/` → joueurs
   - `https://votre-app.onrender.com/host` → animateur
   - `https://votre-app.onrender.com/export/<PIN>` → CSV

---
Généré le 2025-08-26 00:39:35
