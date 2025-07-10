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

const ADMIN_USER = "admin";
const ADMIN_PASS = "secret";
const ADMIN_COOKIE = "adminsession";
let adminSessions = new Set();

app.use(cors());
app.use(express.json());
app.use(express.static(UPLOADS_DIR));
app.use(cookieParser());

const upload = multer({ dest: UPLOADS_DIR });

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
function checkAdmin(req, res, next) {
  if(req.cookies && req.cookies[ADMIN_COOKIE] && adminSessions.has(req.cookies[ADMIN_COOKIE])) {
    next();
  } else {
    res.redirect("/admin-login");
  }
}

// --- Authentification admin ---
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

// --- Export ZIP ---
app.get("/admin/export", checkAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="sauvegarde_garantie.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  if (fs.existsSync(DATA_FILE)) archive.file(DATA_FILE, { name: 'demandes.json' });
  if (fs.existsSync(UPLOADS_DIR)) archive.directory(UPLOADS_DIR, 'uploads');
  archive.finalize();
});

// --- Import ZIP ---
app.post("/admin/import", checkAdmin, upload.single("backupzip"), async (req, res) => {
  if (!req.file) return res.send("Aucun fichier reçu !");
  const unzipper = await import('unzipper');
  const backupPath = req.file.path;
  const extractPath = process.cwd();
  fs.createReadStream(backupPath)
    .pipe(unzipper.Extract({ path: extractPath }))
    .on('close', () => {
      fs.unlinkSync(backupPath);
      res.send(`<p style="color:green;">Sauvegarde restaurée avec succès ! <a href="/admin">Retour admin</a></p>`);
    })
    .on('error', (err) => {
      res.send(`<p style="color:red;">Erreur lors de la restauration : ${err.message}</p>`);
    });
});

// --- Création d'une demande : chaque champ est séparé ! ---
app.post("/api/demandes", upload.array("document", 10), (req, res) => {
    let demandes = loadDemandes();
    let {
      nom, email, magasin,
      marque_produit, produit_concerne, reference_piece, quantite_posee,
      immatriculation, marque_vehicule, modele_vehicule, num_serie, premiere_immat,
      date_pose, date_constat, km_pose, km_constat, probleme_rencontre
    } = req.body;
    let id = genId();
    let now = new Date().toISOString();
    let files = (req.files || []).map(f => ({
        original: f.originalname,
        url: f.filename
    }));
    let demande = {
      id, nom, email, magasin,
      marque_produit, produit_concerne, reference_piece, quantite_posee,
      immatriculation, marque_vehicule, modele_vehicule, num_serie, premiere_immat,
      date_pose, date_constat, km_pose, km_constat, probleme_rencontre,
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
    let demandes = loadDemandes().filter(d => d.email && d.email.toLowerCase() === email.toLowerCase());
    res.json(demandes.map(d => ({
        ...d,
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
      <li><b>Magasin :</b> ${d.magasin || ""}</li>
      <li><b>Nom :</b> ${d.nom || ""}</li>
      <li><b>Email :</b> ${d.email || ""}</li>
      <li><b>Produit :</b> ${d.marque_produit||""} / ${d.produit_concerne||""} / ${d.reference_piece||""} / ${d.quantite_posee||""}</li>
      <li><b>Véhicule :</b> ${d.immatriculation||""} / ${d.marque_vehicule||""} / ${d.modele_vehicule||""} / ${d.num_serie||""} / ${d.premiere_immat||""}</li>
      <li><b>Problème :</b> ${d.date_pose||""} / ${d.date_constat||""} / ${d.km_pose||""} / ${d.km_constat||""}</li>
      <li><b>Problème rencontré :</b> ${d.probleme_rencontre||""}</li>
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

// --- Ajout doc client (option) ---
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

// --- Admin : change statut + réponse/pièces jointes ---
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

// --- Admin : tableau de bord avec bouton "Voir" (fiche détaillée en grille) ---
app.get("/admin", checkAdmin, (req, res) => {
    let demandes = loadDemandes();
    const magasins = ["Gleize", "Miribel", "St-Jean-Bonnefond"];
    let html = `
    <a href="/logout" style="float:right;">Déconnexion</a>
    <form id="importForm" action="/admin/import" method="post" enctype="multipart/form-data" style="display:inline-block; margin-bottom:15px; margin-right:18px; background:#eee; padding:8px 12px; border-radius:6px;">
      <label>🔁 Importer une sauvegarde (.zip):</label>
      <input type="file" name="backupzip" accept=".zip" required>
      <button type="submit">Importer</button>
    </form>
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
        let html = "<table border='1' cellpadding='5' style='border-collapse:collapse; width:100%;'><tr><th>Date</th><th>Nom</th><th>Email</th><th>Produit</th><th>Immatriculation</th><th>Statut</th><th>Pièces jointes</th><th>Réponse / Docs admin</th><th>Actions</th><th>Voir</th></tr>";
        html += d.map(x=>\`
          <tr>
            <td>\${new Date(x.date).toLocaleDateString("fr-FR")}</td>
            <td>\${x.nom||''}</td>
            <td>\${x.email||''}</td>
            <td>\${x.produit_concerne||''}</td>
            <td>\${x.immatriculation||''}</td>
            <td>\${x.statut}</td>
            <td>
              \${(x.files && x.files.length) 
                ? x.files.map(f=>\`<a href="/download/\${f.url}" target="_blank" rel="noopener noreferrer">\${f.original}</a>\`).join("<br>")
                : '—'}
            </td>
            <td>
              \${(x.reponse ? \`<div>\${x.reponse}</div>\` : '')}
              \${(x.reponseFiles && x.reponseFiles.length)
                ? x.reponseFiles.map(f=>\`<a href="/download/\${f.url}" target="_blank" rel="noopener noreferrer">\${f.original}</a>\`).join("<br>")
                : ''}
            </td>
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
            </td>
            <td><button class="bouton" onclick="voirDossier('\${x.id}')">Voir</button></td>
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

      window.voirDossier = function(id) {
        let d = demandes.find(x=>x.id===id);
        if(!d) return alert("Dossier introuvable !");
        let detailHtml = \`
        <html><head>
          <meta charset="UTF-8">
          <title>Détail dossier</title>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; background:#f9fafb; margin:0; }
            .grid { max-width:900px; margin:24px auto; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
            .bloc { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 13px 18px 12px 18px; min-height: 94px; }
            .bloc label, .bloc .titre { font-weight: bold; font-size: 1.07em; color: #194e72; display: block; margin-bottom: 8px;}
            .bloc .sublabel { font-weight:normal; color:#555; margin-bottom:3px; }
            .full { grid-column:1/3; }
            @media (max-width:900px) { .grid { grid-template-columns: 1fr; } .full { grid-column:1/2; } }
          </style>
        </head><body>
          <div class="grid">
            <div class="bloc">
              <label>Nom du client :</label>
              <div>\${d.nom||""}</div>
              <label class="sublabel">Email :</label>
              <div>\${d.email||""}</div>
            </div>
            <div class="bloc">
              <label>Magasin :</label>
              <div>\${d.magasin||""}</div>
            </div>
            <div class="bloc">
              <span class="titre">Produit</span>
              <label class="sublabel">Marque du produit :</label>
              <div>\${d.marque_produit||""}</div>
              <label class="sublabel">Produit concerné :</label>
              <div>\${d.produit_concerne||""}</div>
              <label class="sublabel">Référence de la pièce :</label>
              <div>\${d.reference_piece||""}</div>
              <label class="sublabel">Quantité posée :</label>
              <div>\${d.quantite_posee||""}</div>
            </div>
            <div class="bloc">
              <span class="titre">Véhicule</span>
              <label class="sublabel">Immatriculation :</label>
              <div>\${d.immatriculation||""}</div>
              <label class="sublabel">Marque :</label>
              <div>\${d.marque_vehicule||""}</div>
              <label class="sublabel">Modèle :</label>
              <div>\${d.modele_vehicule||""}</div>
              <label class="sublabel">Numéro de série :</label>
              <div>\${d.num_serie||""}</div>
              <label class="sublabel">1ère immatriculation :</label>
              <div>\${d.premiere_immat||""}</div>
            </div>
            <div class="bloc">
              <span class="titre">Problème</span>
              <label class="sublabel">Date de pose :</label>
              <div>\${d.date_pose||""}</div>
              <label class="sublabel">Date du constat :</label>
              <div>\${d.date_constat||""}</div>
              <label class="sublabel">Kilométrage à la pose :</label>
              <div>\${d.km_pose||""}</div>
              <label class="sublabel">Kilométrage au constat :</label>
              <div>\${d.km_constat||""}</div>
            </div>
            <div class="bloc">
              <span class="titre">Problème rencontré :</span>
              <div>\${d.probleme_rencontre||""}</div>
            </div>
            <div class="bloc">
              <label>Date de création du dossier :</label>
              <div>\${(new Date(d.date)).toLocaleDateString("fr-FR")}</div>
              <label>Statut :</label>
              <div>\${d.statut||""}</div>
            </div>
            <div class="bloc">
              <label>Pièces jointes :</label>
              <div>
              \${(d.files||[]).map(f=>{
                let ext = f.original.split('.').pop().toLowerCase();
                if(["jpg","jpeg","png","gif","webp","bmp"].includes(ext)){
                  return \`<a href="/download/\${f.url}" target="_blank" rel="noopener"><img src="/download/\${f.url}" style="max-width:180px;max-height:120px;display:block;margin-bottom:5px;border-radius:4px;"></a>\`;
                }
                return \`<a href="/download/\${f.url}" target="_blank" rel="noopener noreferrer">\${f.original}</a><br>\`;
              }).join("")}
              </div>
              <label>Réponse / documents admin :</label>
              <div>
              \${(d.reponse||"")}<br>
              \${(d.reponseFiles||[]).map(f=>{
                return \`<a href="/download/\${f.url}" target="_blank" rel="noopener noreferrer">\${f.original}</a><br>\`;
              }).join("")}
              </div>
            </div>
          </div>
        </body></html>
        \`;
        let w = window.open("", "_blank", "width=900,height=900");
        w.document.write(detailHtml);
        w.document.close();
      }
      document.getElementById("importForm").onsubmit = function() {
        setTimeout(() => {
          alert("Import en cours... Actualisez la page admin dans quelques secondes pour voir le résultat.");
        }, 200);
      };
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

app.listen(PORT, ()=>console.log("Serveur garantie en ligne sur port "+PORT));
