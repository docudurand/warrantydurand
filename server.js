import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import mime from "mime-types";
import archiver from "archiver";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./demandes.json";
const UPLOADS_DIR = "./uploads";

// --- Authentification Admin par formulaire HTML ---
const ADMIN_USER = "admin";
const ADMIN_PASS = "secret";
const ADMIN_COOKIE = "adminsession";
let adminSessions = new Set();

app.use(cors());
app.use(express.json());
app.use(express.static(UPLOADS_DIR));
app.use(cookieParser());

// --- Multer pour upload fichiers ---
const upload = multer({ dest: UPLOADS_DIR });

// --- Fonctions utilitaires ---
function loadDemandes() {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveDemandes(demandes) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(demandes, null, 2));
}
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2,5);
}
function formatDateFr(date) {
    return new Date(date).toLocaleDateString("fr-FR");
}

// --- Authentification admin (cookie/session) ---
function checkAdmin(req, res, next) {
  if(req.cookies && req.cookies[ADMIN_COOKIE] && adminSessions.has(req.cookies[ADMIN_COOKIE])) {
    next();
  } else {
    res.redirect("/admin-login");
  }
}

// --- Page de login admin ---
app.get("/admin-login", (req, res) => {
  res.send(`
    <h2>Connexion Admin</h2>
    <form method="POST" action="/admin-login" style="max-width:350px;margin:auto;padding:16px;border:1px solid #ccc">
      <label>Utilisateur : <input name="user" /></label><br><br>
      <label>Mot de passe : <input type="password" name="pass" /></label><br><br>
      <button type="submit">Connexion</button>
      ${req.query.err ? "<div style='color:red;'>Identifiants incorrects</div>" : ""}
    </form>
  `);
});
app.post("/admin-login", express.urlencoded({extended:true}), (req, res) => {
  const {user, pass} = req.body;
  if(user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.add(token);
    res.cookie(ADMIN_COOKIE, token, { httpOnly:true, sameSite:"lax" });
    res.redirect("/admin");
  } else {
    res.redirect("/admin-login?err=1");
  }
});
app.get("/logout", (req, res) => {
  if(req.cookies && req.cookies[ADMIN_COOKIE]) adminSessions.delete(req.cookies[ADMIN_COOKIE]);
  res.clearCookie(ADMIN_COOKIE);
  res.redirect("/admin-login");
});

// --- Export ZIP complet des données (admin seulement) ---
app.get("/admin/export", checkAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="sauvegarde_garantie.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  // Ajoute le fichier demandes.json
  if (fs.existsSync(DATA_FILE)) archive.file(DATA_FILE, { name: 'demandes.json' });

  // Ajoute tout le dossier uploads (s'il existe)
  if (fs.existsSync(UPLOADS_DIR)) archive.directory(UPLOADS_DIR, 'uploads');

  archive.finalize();
});

// --- Création d'une demande ---
app.post("/api/demandes", upload.array("document", 10), (req, res) => {
    let demandes = loadDemandes();
    let { magasin, nom, email, commande, produit, desc } = req.body;
    let id = genId();
    let now = new Date().toISOString();
    let files = (req.files || []).map(f => ({
        original: f.originalname,
        url: f.filename
    }));
    let demande = {
        id, magasin, nom, email, commande, produit, desc,
        files, date: now,
        statut: "Enregistré",
        historique: [{ date: now, action: "Demande créée" }]
    };
    demandes.push(demande);
    saveDemandes(demandes);
    res.json({ success: true, id });
});

// --- Liste des dossiers d’un client ---
app.get("/api/mes-dossiers", (req, res) => {
    let { email } = req.query;
    if (!email) return res.json([]);
    let demandes = loadDemandes().filter(d => d.email.toLowerCase() === email.toLowerCase());
    res.json(demandes.map(d => ({
        id: d.id, produit: d.produit, commande: d.commande,
        statut: d.statut, date: d.date, files: d.files,
        historique: d.historique || [],
        reponse: d.reponse || null,
        reponseFiles: d.reponseFiles || []
    })));
});

// --- Voir détail d’une demande (JSON brut, pour API ou debug) ---
app.get("/api/dossier/:id", checkAdmin, (req, res) => {
    let d = loadDemandes().find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json(d);
});

// --- Vue HTML résumé pour l’admin (humain lisible !) ---
app.get("/dossier/:id", checkAdmin, (req, res) => {
  let d = loadDemandes().find(d => d.id === req.params.id);
  if (!d) return res.status(404).send("Demande non trouvée");
  res.send(`
    <h2>Détail de la demande</h2>
    <ul>
      <li><b>Date :</b> ${formatDateFr(d.date)}</li>
      <li><b>Nom :</b> ${d.nom}</li>
      <li><b>Email :</b> ${d.email}</li>
      <li><b>Commande :</b> ${d.commande}</li>
      <li><b>Produit :</b> ${d.produit}</li>
      <li><b>Description :</b> ${d.desc}</li>
      <li><b>Statut :</b> ${d.statut}</li>
      <li><b>Pièces jointes :</b> ${
        (d.files && d.files.length)
          ? d.files.map(f =>
              `<a href="/download/${f.url}" target="_blank" rel="noopener noreferrer">${f.original}</a>`
            ).join(" / ")
          : "Aucune"
      }</li>
      <li><b>Réponse admin :</b> ${d.reponse || "Aucune"}</li>
      <li><b>Documents admin :</b> ${
        (d.reponseFiles && d.reponseFiles.length)
          ? d.reponseFiles.map(f =>
              `<a href="/download/${f.url}" target="_blank" rel="noopener noreferrer">${f.original}</a>`
            ).join(" / ")
          : "Aucun"
      }</li>
      <li><b>Historique :</b>
        <ul>
          ${(d.historique||[]).map(h => `<li>${formatDateFr(h.date)} — ${h.action}</li>`).join('')}
        </ul>
      </li>
    </ul>
    <a href="/admin">Retour admin</a>
  `);
});

// --- Client ajoute un document à un dossier (option) ---
app.post("/api/dossier/:id/add-doc", upload.array("document", 10), (req, res) => {
    let demandes = loadDemandes();
    let d = demandes.find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    let files = (req.files || []).map(f => ({
        original: f.originalname,
        url: f.filename
    }));
    d.files.push(...files);
    (d.historique = d.historique || []).push({ date: new Date().toISOString(), action: "Doc ajouté par client" });
    saveDemandes(demandes);
    res.json({ success: true });
});

// --- Admin : change statut + ajoute réponse ou pièce jointe ---
app.post("/api/dossier/:id/admin", checkAdmin, upload.array("reponseFiles", 10), (req, res) => {
    let demandes = loadDemandes();
    let d = demandes.find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    let { statut, reponse } = req.body;
    if (statut) d.statut = statut;
    if (reponse) d.reponse = reponse;
    if (req.files && req.files.length) {
        d.reponseFiles = d.reponseFiles || [];
        d.reponseFiles.push(...req.files.map(f=>({ original: f.originalname, url: f.filename })));
    }
    (d.historique = d.historique || []).push({
        date: new Date().toISOString(),
        action: "Statut changé ou réponse ajoutée par admin"
    });
    saveDemandes(demandes);
    res.json({ success: true });
});

// --- Tableau de bord admin (AJAX + bouton export + pop-up confirmation) ---
app.get("/admin", checkAdmin, (req, res) => {
    let demandes = loadDemandes();
    const magasins = ["Gleize", "Miribel", "St-Jean-Bonnefond"];

    let html = `
    <a href="/logout" style="float:right;">Déconnexion</a>
    <a href="/admin/export" style="display:inline-block; margin-bottom:15px; background:#006e90; color:#fff; padding:8px 16px; border-radius:5px; text-decoration:none;">⏬ Exporter toutes les données (.zip)</a>
    <h2>Tableau de bord dossiers</h2>
    <div style="margin-bottom:14px;">
      ${magasins.map((m, i) =>
        `<button class="onglet-magasin" data-magasin="${m}" style="padding:7px 18px; margin-right:7px; background:#${i==0?'006e90':'eee'}; color:#${i==0?'fff':'222'}; border:none; border-radius:6px; cursor:pointer;">${m}</button>`
      ).join('')}
    </div>
    <div id="contenu-admin"></div>
    <script>
      let demandes = ${JSON.stringify(demandes)};
      let magasins = ${JSON.stringify(magasins)};
      let activeMagasin = magasins[0];

      function renderTable(magasin) {
        activeMagasin = magasin;
        let d = demandes.filter(x=>x.magasin===magasin);
        let html = "<table border='1' cellpadding='5' style='border-collapse:collapse; width:100%;'><tr><th>Date</th><th>Nom</th><th>Email</th><th>Produit</th><th>Commande</th><th>Statut</th><th>Actions</th></tr>";
        html += d.map(x=>\`
          <tr>
            <td>\${new Date(x.date).toLocaleDateString("fr-FR")}</td>
            <td>\${x.nom}</td>
            <td>\${x.email}</td>
            <td>\${x.produit}</td>
            <td>\${x.commande}</td>
            <td>\${x.statut}</td>
            <td>
              <form class="admin-form" action="/api/dossier/\${x.id}/admin" method="post" enctype="multipart/form-data">
                <select name="statut">
                  <option\${x.statut==="Enregistré"?" selected":""}>Enregistré</option>
                  <option\${x.statut==="Accepté"?" selected":""}>Accepté</option>
                  <option\${x.statut==="Refusé"?" selected":""}>Refusé</option>
                  <option\${x.statut==="En attente info"?" selected":""}>En attente info</option>
                </select>
                <input type="text" name="reponse" placeholder="Message ou commentaire..." style="width:120px;">
                <input type="file" name="reponseFiles" multiple>
                <button type="submit">Valider</button>
              </form>
              <a href="/dossier/\${x.id}" target="_blank">Voir</a>
            </td>
          </tr>
        \`).join('');
        html += "</table>";
        document.getElementById("contenu-admin").innerHTML = html;

        document.querySelectorAll('.admin-form').forEach(form => {
          form.onsubmit = async function(e){
            e.preventDefault();
            const formData = new FormData(form);
            const action = form.action;
            let resp = await fetch(action, {method:'POST', body:formData});
            let res = await resp.json();
            if(res.success){
              alert("Modification enregistrée !");
              location.reload();
            } else {
              alert("Erreur lors de la modification.");
            }
          };
        });
      }
      document.querySelectorAll(".onglet-magasin").forEach(btn=>{
        btn.onclick = function(){
          document.querySelectorAll(".onglet-magasin").forEach(b=>{b.style.background="#eee"; b.style.color="#222";});
          btn.style.background="#006e90"; btn.style.color="#fff";
          renderTable(btn.dataset.magasin);
        };
      });
      renderTable(activeMagasin);
    </script>
    `;
    res.send(html);
});


// --- Route de téléchargement de PJ avec extension ---
app.get("/download/:fileid", (req, res) => {
  const fileid = req.params.fileid;
  const demandes = loadDemandes();
  let found = null;
  for(const d of demandes){
    let f = (d.files||[]).find(f => f.url === fileid);
    if(f) { found = f; break; }
    if(d.reponseFiles) {
      let fr = d.reponseFiles.find(f2=>f2.url === fileid);
      if(fr) { found = fr; break; }
    }
  }
  if(!found) return res.status(404).send("Fichier introuvable");
  const filePath = path.join(UPLOADS_DIR, fileid);
  const contentType = mime.lookup(found.original) || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename="${found.original}"`);
  fs.createReadStream(filePath).pipe(res);
});

// --- Lancement serveur ---
app.listen(PORT, ()=>console.log("Serveur garantie en ligne sur port "+PORT));
