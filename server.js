import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import mime from "mime-types";
import archiver from "archiver";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./demandes.json";
const UPLOADS_DIR = "./uploads";

const MAGASIN_MAILS = {
  "Annemasse":    "respmagannemasse@durandservices.fr",
  "Bourgoin-Jallieu":    "magasin5bourgoin@durandservices.fr",
  "Chasse-sur-Rhone":    "magvl5chasse@durandservices.fr",
  "Chassieu":    "respmagchassieu@durandservices.fr",
  "Gleize":    "magvl4gleize@durandservices.fr",
  "La Motte-Servolex":    "respmaglms@durandservices.fr",
  "Les Echets":    "magvlmiribel@durandservices.fr",
  "Rives":    "magvl3rives@durandservices.fr",
  "Saint-Egreve":    "magvlstegreve@durandservices.fr",
  "Saint-Jean-Bonnefonds":    "respmagsjb@durandservices.fr",
  "Saint-martin-d'heres":   "magvl1smdh@durandservices.fr",
  "Seynod":    "respmagseynod@durandservices.fr",
};

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

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
function checkAdmin(req, res, next) {
  if(req.cookies && req.cookies[ADMIN_COOKIE] && adminSessions.has(req.cookies[ADMIN_COOKIE])) {
    next();
  } else {
    res.redirect("/admin-login");
  }
}

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

app.get("/admin/export", checkAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="sauvegarde_garantie.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  if (fs.existsSync(DATA_FILE)) archive.file(DATA_FILE, { name: 'demandes.json' });
  if (fs.existsSync(UPLOADS_DIR)) archive.directory(UPLOADS_DIR, 'uploads');
  archive.finalize();
});

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
    let seen = new Set();
    files = files.filter(f => {
      if (seen.has(f.original)) return false;
      seen.add(f.original);
      return true;
    });
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

    const destinataire = MAGASIN_MAILS[magasin] || GMAIL_USER;
    transporter.sendMail({
      from: `"Garantie" <${GMAIL_USER}>`,
      to: destinataire,
      subject: "Nouvelle demande de garantie",
      text: `Bonjour,

Un client vient d'enregistrer un dossier de garantie.

Nom : ${nom}
Email client : ${email}
Marque du produit : ${marque_produit}
Date : ${new Date().toLocaleDateString("fr-FR")}
`
    }, (err, info) => {
      if(err) console.log("Erreur envoi mail magasin:", err);
      else console.log("Mail envoyé magasin", info.messageId);
    });

    res.json({ success: true, id });
});

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

app.get("/api/dossier/:id", checkAdmin, (req, res) => {
    let d = loadDemandes().find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json(d);
});

app.post("/api/dossier/:id/add-doc", upload.array("document", 10), (req, res) => {
    let demandes = loadDemandes();
    let d = demandes.find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    let files = (req.files || []).map(f => ({
        original: f.originalname,
        url: f.filename
    }));
    let already = new Set((d.files||[]).map(f=>f.original));
    files = files.filter(f=>!already.has(f.original));
    d.files.push(...files);
    (d.historique = d.historique || []).push({ date: new Date().toISOString(), action: "Doc ajouté par client" });
    saveDemandes(demandes);
    res.json({ success: true });
});

app.post("/api/dossier/:id/admin", checkAdmin, upload.array("reponseFiles", 10), (req, res) => {
    let demandes = loadDemandes();
    let d = demandes.find(d => d.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    let { statut, reponse } = req.body;
    if (statut) d.statut = statut;
    if (reponse) d.reponse = reponse;
    if (req.files && req.files.length) {
        d.reponseFiles = d.reponseFiles || [];
        let already = new Set((d.reponseFiles).map(f=>f.original));
        let toAdd = req.files.map(f=>({ original: f.originalname, url: f.filename }))
                      .filter(f=>!already.has(f.original));
        d.reponseFiles.push(...toAdd);
    }
    (d.historique = d.historique || []).push({
        date: new Date().toISOString(),
        action: "Statut changé ou réponse ajoutée par admin"
    });
    saveDemandes(demandes);

    if(d.email){
      transporter.sendMail({
        from: `"Garantie Durand Services" <${GMAIL_USER}>`,
        to: d.email,
        subject: "Mise à jour dossier garantie Durand Services",
        text: `
Une mise à jour a été apportée à un dossier de garantie, merci de consulter votre suivi.

Produit : ${d.produit_concerne}
Statut : ${d.statut}
Date : ${new Date().toLocaleDateString("fr-FR")}

Merci de ne pas répondre à cet email.
`
      }, (err, info) => {
        if(err) console.log("Erreur envoi mail client:", err);
        else console.log("Mail envoyé client", info.messageId);
      });
    }

    res.json({ success: true });
});

app.get("/admin", checkAdmin, (req, res) => {
    let demandes = loadDemandes();
    const magasins = ["Annemasse", "Bourgoin-Jallieu", "Chasse-sur-Rhone", "Chassieu", "Gleize", "La Motte-Servolex", "Les Echets", "Rives", "Saint-Egreve", "Saint-Jean-Bonnefonds", "Saint-martin-d'heres", "Saint-Priest", "Seynod"];
    let allMonths = new Set();
    let allYears = new Set();
    for (let d of demandes) {
      if(d.date){
        let dd = new Date(d.date);
        allMonths.add(('0'+(dd.getMonth()+1)).slice(-2));
        allYears.add(dd.getFullYear());
      }
    }
    allMonths = Array.from(allMonths).sort();
    allYears = Array.from(allYears).sort();

    let html = `
  <style>
    body { margin:0; padding:0; }
    .banniere-admin {
      width:100vw;
      min-width:100vw;
      max-width:100vw;
      display:block;
      margin:0;
      border-radius:0;
      box-shadow:0 4px 20px #0002;
    }
	.stat-cards { display:flex; gap:18px; margin-bottom:18px; }
    <img src="https://raw.githubusercontent.com/docudurand/warrantydurand/main/banniere.png" alt="Bannière"
	<a href="/logout" style="float:right;">Déconnexion</a>
      style="display:block; width:100%; max-width:980px; margin:25px auto 8px auto; border-radius:14px; box-shadow:0 4px 20px #0002;">
    <a href="/logout" style="float:right;">Déconnexion</a>
    <form id="importForm" action="/admin/import" method="post" enctype="multipart/form-data" style="display:inline-block; margin-bottom:15px; margin-right:18px; background:#eee; padding:8px 12px; border-radius:6px;">
      <label>🔁 Importer une sauvegarde (.zip):</label>
      <input type="file" name="backupzip" accept=".zip" required>
      <button type="submit">Importer</button>
    </form>
    <a href="/admin/export" style="display:inline-block; margin-bottom:15px; background:#006e90; color:#fff; padding:8px 16px; border-radius:5px; text-decoration:none;">⏬ Exporter toutes les données (.zip)</a>
    <h2>Tableau de bord dossiers</h2>
    <div style="margin-bottom:10px;">
      ${magasins.map((m, i) =>
        `<button class="onglet-magasin" data-magasin="${m}" style="padding:7px 18px; margin-right:7px; background:#${i==0?'006e90':'eee'}; color:#${i==0?'fff':'222'}; border:none; border-radius:6px; cursor:pointer;">${m}</button>`
      ).join('')}
    </div>
    <div style="margin-bottom:10px;">
      <label>Mois :
        <select id="moisFilter">
          <option value="">Tous</option>
          ${["01","02","03","04","05","06","07","08","09","10","11","12"].map(m=>`<option value="${m}">${m}</option>`).join('')}
        </select>
      </label>
      <label style="margin-left:24px;">Année :
        <select id="anneeFilter">
          <option value="">Toutes</option>
          ${allYears.map(y=>`<option value="${y}">${y}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="statistiques"></div>
    <div id="contenu-admin"></div>
    <style>
      .stat-cards { display:flex; gap:18px; margin-bottom:18px; }
      .stat-card {
        min-width:190px; flex:1;
        background:#f9fafb; border-radius:11px; box-shadow:0 3px 12px #0001;
        padding:18px 20px 12px 20px; display:flex; flex-direction:column; align-items:center;
        font-family:Arial,sans-serif; font-size:1.17em; 
      }
      .stat-title { font-size:1em; font-weight:bold; margin-bottom:12px;}
      .stat-num { font-size:2.1em; font-weight:bold; margin-bottom:2px;}
      .stat-enreg {color:#1373be;}
      .stat-accept {color:#259a54;}
      .stat-attente {color:#d39213;}
      .stat-refus {color:#b23b3b;}
      @media(max-width:850px) {.stat-cards{flex-direction:column;gap:12px;}}
    </style>
    <script>
      // ... (JS de gestion du tableau, filtres, voirDossier, identique à ta version précédente)
    </script>
    `;
    res.send(html);
});

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
