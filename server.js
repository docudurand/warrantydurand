import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import cookieParser from "cookie-parser";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./demandes.json";
const UPLOADS_DIR = "./uploads";

// --- Authentification Admin par formulaire HTML ---
const ADMIN_USER = "admin";           // <-- modifie ici si besoin
const ADMIN_PASS = "secret";          // <-- modifie ici si besoin
const ADMIN_COOKIE = "adminsession";
let adminSessions = new Set();

app.use(cors());
app.use(express.json());
app.use(express.static(UPLOADS_DIR)); // Pour servir les pièces jointes
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
    // Création d'une session
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

// --- Création d'une demande ---
app.post("/api/demandes", upload.array("document", 10), (req, res) => { // accepte jusqu'à 10 PJ
    let demandes = loadDemandes();
    let { nom, email, commande, produit, desc } = req.body;
    let id = genId();
    let now = new Date().toISOString();
    let files = (req.files || []).map(f => ({
        original: f.originalname,
        url: f.filename
    }));
    let demande = {
        id, nom, email, commande, produit, desc,
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
              `<a href="/${f.url}" target="_blank" download="${f.original}">${f.original}</a>`
            ).join(" / ")
          : "Aucune"
      }</li>
      <li><b>Réponse admin :</b> ${d.reponse || "Aucune"}</li>
      <li><b>Documents admin :</b> ${
        (d.reponseFiles && d.reponseFiles.length)
          ? d.reponseFiles.map(f =>
              `<a href="/${f.url}" target="_blank" download="${f.original}">${f.original}</a>`
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

// --- Tableau de bord admin ---
app.get("/admin", checkAdmin, (req, res) => {
    let demandes = loadDemandes();
    let html = `
    <a href="/logout" style="float:right;">Déconnexion</a>
    <h2>Tableau de bord dossiers</h2>
    <table border="1" cellpadding="5" style="border-collapse:collapse;">
    <tr>
      <th>Date</th><th>Nom</th><th>Email</th><th>Produit</th><th>Commande</th><th>Statut</th><th>Actions</th>
    </tr>
    ${demandes.map(d => `
      <tr>
        <td>${formatDateFr(d.date)}</td>
        <td>${d.nom}</td>
        <td>${d.email}</td>
        <td>${d.produit}</td>
        <td>${d.commande}</td>
        <td>${d.statut}</td>
        <td>
          <form action="/api/dossier/${d.id}/admin" method="post" enctype="multipart/form-data">
            <select name="statut">
              <option${d.statut==="Enregistré"?" selected":""}>Enregistré</option>
              <option${d.statut==="Accepté"?" selected":""}>Accepté</option>
              <option${d.statut==="Refusé"?" selected":""}>Refusé</option>
              <option${d.statut==="En attente info"?" selected":""}>En attente info</option>
            </select>
            <input type="text" name="reponse" placeholder="Message ou commentaire..." style="width:120px;">
            <input type="file" name="reponseFiles" multiple>
            <button type="submit">Valider</button>
          </form>
          <a href="/dossier/${d.id}" target="_blank">Voir</a>
        </td>
      </tr>
    `).join("")}
    </table>
    `;
    res.send(html);
});

// --- Lancement serveur ---
app.listen(PORT, ()=>console.log("Serveur garantie en ligne sur port "+PORT));
