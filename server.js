import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import basicAuth from "basic-auth";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./demandes.json";
const UPLOADS_DIR = "./uploads";

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(UPLOADS_DIR)); // Permet le download des pièces jointes

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

// --- Route : créer une demande ---
app.post("/api/demandes", upload.array("document", 5), (req, res) => {
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

// --- Route : liste des dossiers d’un client ---
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

// --- Route : voir détail d’une demande ---
app.get("/api/dossier/:id", (req, res) => {
    let d = loadDemandes().find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json(d);
});

// --- Route : client ajoute un document à un dossier (option) ---
app.post("/api/dossier/:id/add-doc", upload.array("document", 5), (req, res) => {
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

function checkAdmin(req, res, next) { next(); }
app.post("/api/dossier/:id/admin", checkAdmin, upload.array("reponseFiles", 5), (req, res) => {
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

// --- Page d’admin ultra-simple (accès via /admin, login basique HTTP) ---
app.get("/admin", checkAdmin, (req, res) => {
    let demandes = loadDemandes();
    let html = `
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
        <td>${d.commande}</td>
        <td>${d.produit}</td>
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
          <a href="/api/dossier/${d.id}" target="_blank">Voir</a>
        </td>
      </tr>
    `).join("")}
    </table>
    `;
    res.send(html);
});

// --- Lancement serveur ---
app.listen(PORT, ()=>console.log("Serveur garantie en ligne sur port "+PORT));
