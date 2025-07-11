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
  "Annemasse": "respmagannemasse@durandservices.fr",
  "Bourgoin-Jallieu": "magasin5bourgoin@durandservices.fr",
  "Chasse-sur-Rhone": "magvl5chasse@durandservices.fr",
  "Chassieu": "respmagchassieu@durandservices.fr",
  "Gleize": "magvl4gleize@durandservices.fr",
  "La Motte-Servolex": "respmaglms@durandservices.fr",
  "Les Echets": "magvlmiribel@durandservices.fr",
  "Rives": "magvl3rives@durandservices.fr",
  "Saint-Egreve": "magvlstegreve@durandservices.fr",
  "Saint-Jean-Bonnefonds": "respmagsjb@durandservices.fr",
  "Saint-martin-d'heres": "magvl1smdh@durandservices.fr",
  "Seynod": "respmagseynod@durandservices.fr",
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
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}
function checkAdmin(req, res, next) {
  if (req.cookies && req.cookies[ADMIN_COOKIE] && adminSessions.has(req.cookies[ADMIN_COOKIE])) {
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
app.post("/admin-login", express.urlencoded({ extended: true }), (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.add(token);
    res.cookie(ADMIN_COOKIE, token, { httpOnly: true, sameSite: "lax" });
    res.redirect("/admin");
  } else {
    res.redirect("/admin-login?err=1");
  }
});
app.get("/logout", (req, res) => {
  if (req.cookies && req.cookies[ADMIN_COOKIE]) adminSessions.delete(req.cookies[ADMIN_COOKIE]);
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
    if (err) console.log("Erreur envoi mail magasin:", err);
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
  let already = new Set((d.files || []).map(f => f.original));
  files = files.filter(f => !already.has(f.original));
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
    let already = new Set((d.reponseFiles).map(f => f.original));
    let toAdd = req.files.map(f => ({ original: f.originalname, url: f.filename }))
      .filter(f => !already.has(f.original));
    d.reponseFiles.push(...toAdd);
  }
  (d.historique = d.historique || []).push({
    date: new Date().toISOString(),
    action: "Statut changé ou réponse ajoutée par admin"
  });
  saveDemandes(demandes);

  if (d.email) {
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
      if (err) console.log("Erreur envoi mail client:", err);
      else console.log("Mail envoyé client", info.messageId);
    });
  }

  res.json({ success: true });
});

app.get("/admin", checkAdmin, (req, res) => {
  let demandes = loadDemandes();
  const magasins = ["Annemasse", "Bourgoin-Jallieu", "Chasse-sur-Rhone", "Chassieu", "Gleize", "La Motte-Servolex", "Les Echets", "Rives", "Saint-Egreve", "Saint-Jean-Bonnefonds", "Saint-martin-d'heres", "Seynod"];
  let allMonths = new Set();
  let allYears = new Set();
  for (let d of demandes) {
    if (d.date) {
      let dd = new Date(d.date);
      allMonths.add(('0' + (dd.getMonth() + 1)).slice(-2));
      allYears.add(dd.getFullYear());
    }
  }
  allMonths = Array.from(allMonths).sort();
  allYears = Array.from(allYears).sort();

  let html = `
    <img src="https://raw.githubusercontent.com/docudurand/warrantydurand/main/banniere.png" alt="Bannière"
      style="display:block; width:100%; max-width:980px; margin:25px auto 8px auto; border-radius:14px; box-shadow:0 4px 20px #0002;">
    <a href="/logout" style="float:right;">Déconnexion</a>
    <form id="importForm" action="/admin/import" method="post" enctype="multipart/form-data" style="display:inline-block; margin-bottom:15px; margin-right:18px; background:#eee; padding:8px 12px; border-radius:6px;">
      <label>🔁 Importer une sauvegarde (.zip):</label>
      <input type="file" name="backupzip" accept=".zip" required>
      <button type="submit">Importer</button>
    </form>
    <a href="/admin/export" style="display:inline-block; margin-bottom:15px; background:#006e90; color:#fff; padding:8px 16px; border-radius:5px; text-decoration:none;">⏬ Exporter toutes les données (.zip)</a>
    <h2>Tableau de bord dossiers</h2>
    <div id="onglets-magasins" style="margin-bottom:10px;">
      ${magasins.map((m, i) =>
        `<button class="onglet-magasin" data-magasin="${m}" style="padding:7px 18px; margin-right:7px; background:#${i == 0 ? '006e90' : 'eee'}; color:#${i == 0 ? 'fff' : '222'}; border:none; border-radius:6px; cursor:pointer;">${m}</button>`
      ).join('')}
    </div>
    <div style="margin-bottom:10px;">
      <label>Mois :
        <select id="moisFilter">
          <option value="">Tous</option>
          ${["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </label>
      <label style="margin-left:24px;">Année :
        <select id="anneeFilter">
          <option value="">Toutes</option>
          ${allYears.map(y => `<option value="${y}">${y}</option>`).join('')}
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
      let demandes = ${JSON.stringify(demandes)};
      let magasins = ${JSON.stringify(magasins)};
      let activeMagasin = magasins[0];
      let moisFilter = "";
      let anneeFilter = "";

      function renderStats(magasin, mois, annee) {
        let d = demandes.filter(x => x.magasin === magasin);
        if (mois) d = d.filter(x => {
          if (!x.date) return false;
          let dd = new Date(x.date);
          return ('0' + (dd.getMonth() + 1)).slice(-2) === mois;
        });
        if (annee) d = d.filter(x => {
          if (!x.date) return false;
          let dd = new Date(x.date);
          return dd.getFullYear().toString() === annee;
        });

        let nbEnreg = d.filter(x => x.statut === "Enregistré").length;
        let nbAccept = d.filter(x => x.statut === "Accepté").length;
        let nbAttente = d.filter(x => x.statut === "En attente info").length;
        let nbRefus = d.filter(x => x.statut === "Refusé").length;

        let html =
          '<div class="stat-cards">' +
          '<div class="stat-card"><div class="stat-title">Dossiers enregistrés</div><div class="stat-num stat-enreg">' + nbEnreg + '</div></div>' +
          '<div class="stat-card"><div class="stat-title">Dossiers acceptés</div><div class="stat-num stat-accept">' + nbAccept + '</div></div>' +
          '<div class="stat-card"><div class="stat-title">Dossiers en attente info</div><div class="stat-num stat-attente">' + nbAttente + '</div></div>' +
          '<div class="stat-card"><div class="stat-title">Dossiers refusés</div><div class="stat-num stat-refus">' + nbRefus + '</div></div>' +
          '</div>';
        document.getElementById("statistiques").innerHTML = html;
      }

      function renderTable(magasin, mois, annee) {
        activeMagasin = magasin;
        let d = demandes.filter(x => x.magasin === magasin);
        if (mois) d = d.filter(x => {
          if (!x.date) return false;
          let dd = new Date(x.date);
          return ('0' + (dd.getMonth() + 1)).slice(-2) === mois;
        });
        if (annee) d = d.filter(x => {
          if (!x.date) return false;
          let dd = new Date(x.date);
          return dd.getFullYear().toString() === annee;
        });

        renderStats(magasin, mois, annee);

        let html = "<table border='1' cellpadding='5' style='border-collapse:collapse; width:100%;'><tr><th>Date</th><th>Nom</th><th>Email</th><th>Produit</th><th>Immatriculation</th><th>Statut</th><th>Pièces jointes</th><th>Réponse / Docs admin</th><th>Actions</th><th>Voir</th></tr>";
        html += d.map(function(x) {
          return "<tr>" +
            "<td>" + (x.date ? (new Date(x.date).toLocaleDateString('fr-FR')) : '') + "</td>" +
            "<td>" + (x.nom || '') + "</td>" +
            "<td>" + (x.email || '') + "</td>" +
            "<td>" + (x.produit_concerne || '') + "</td>" +
            "<td>" + (x.immatriculation || '') + "</td>" +
            "<td>" + (x.statut) + "</td>" +
            "<td>" +
              ((x.files && x.files.length)
                ? x.files.map(function(f) {
                    let ext = f.original.split('.').pop().toLowerCase();
                    if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) {
                      return '<a href=\"/download/' + f.url + '\" target=\"_blank\" rel=\"noopener\"><img src=\"/download/' + f.url + '\" style=\"max-width:80px;max-height:60px;border-radius:4px;box-shadow:0 1px 3px #0002;margin-bottom:2px;\"></a>';
                    } else {
                      return '<a href=\"/download/' + f.url + '\" target=\"_blank\" rel=\"noopener noreferrer\">' + f.original + '</a>';
                    }
                  }).join("<br>")
                : '—') +
            "</td>" +
            "<td>" +
              (x.reponse ? ('<div>' + x.reponse + '</div>') : '') +
              ((x.reponseFiles && x.reponseFiles.length)
                ? x.reponseFiles.map(function(f) {
                    return '<a href=\"/download/' + f.url + '\" target=\"_blank\" rel=\"noopener noreferrer\">' + f.original + '</a>';
                  }).join("<br>")
                : '') +
            "</td>" +
            "<td>" +
              "<form class=\"admin-form\" action=\"/api/dossier/" + x.id + "/admin\" method=\"post\" enctype=\"multipart/form-data\">" +
                "<select name=\"statut\">" +
                  "<option" + (x.statut==="Enregistré"?" selected":"") + ">Enregistré</option>" +
                  "<option" + (x.statut==="Accepté"?" selected":"") + ">Accepté</option>" +
                  "<option" + (x.statut==="Refusé"?" selected":"") + ">Refusé</option>" +
                  "<option" + (x.statut==="En attente info"?" selected":"") + ">En attente info</option>" +
                "</select>" +
                "<input type=\"text\" name=\"reponse\" placeholder=\"Message ou commentaire...\" style=\"width:120px;\">" +
                "<input type=\"file\" name=\"reponseFiles\" multiple>" +
                "<button type=\"submit\">Valider</button>" +
              "</form>" +
            "</td>" +
            "<td><button class=\"bouton\" onclick=\"voirDossier('" + x.id + "')\">Voir</button></td>" +
          "</tr>";
        }).join('');
        html += "</table>";
        document.getElementById("contenu-admin").innerHTML = html;

        document.querySelectorAll('.admin-form').forEach(function(form) {
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

      function attachOngletEvents() {
        document.querySelectorAll(".onglet-magasin").forEach(function(btn) {
          btn.onclick = function() {
            document.querySelectorAll(".onglet-magasin").forEach(function(b){b.style.background="#eee"; b.style.color="#222";});
            btn.style.background="#006e90"; btn.style.color="#fff";
            renderTable(btn.dataset.magasin, moisFilter, anneeFilter);
            attachOngletEvents();
          };
        });
      }

      document.getElementById("moisFilter").onchange = function () {
        moisFilter = this.value;
        renderTable(activeMagasin, moisFilter, anneeFilter);
        attachOngletEvents();
      };
      document.getElementById("anneeFilter").onchange = function () {
        anneeFilter = this.value;
        renderTable(activeMagasin, moisFilter, anneeFilter);
        attachOngletEvents();
      };

      window.voirDossier = function(id) {
        let d = demandes.find(function(x){return x.id===id;});
        if(!d) return alert("Dossier introuvable !");
        let detailHtml =
          "<html><head><meta charset=\"UTF-8\"><title>Détail dossier</title>" +
          "<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f9fafb;margin:0;}.fiche-table{max-width:700px;margin:30px auto;background:#fff;border-radius:10px;border:1px solid #e5e7eb;padding:18px 24px 14px 24px;}.fiche-table table{width:100%;border-collapse:collapse;}.fiche-table th,.fiche-table td{text-align:left;padding:8px 10px;border:none;}.fiche-table th{color:#194e72;font-size:1.06em;text-align:left;width:220px;vertical-align:top;}.fiche-table tr{border-bottom:1px solid #f0f0f0;}.fiche-title{font-weight:bold;color:#006e90;padding-top:24px;font-size:1.08em;}.pj-img{max-width:180px;max-height:120px;display:block;margin-bottom:6px;border-radius:5px;box-shadow:0 2px 6px #0002;}</style>" +
          "</head><body>" +
          "<div class=\"fiche-table\"><table>" +
            "<tr><th>Nom du client</th><td>"+(d.nom||"")+"</td></tr>" +
            "<tr><th>Email</th><td>"+(d.email||"")+"</td></tr>" +
            "<tr><th>Magasin</th><td>"+(d.magasin||"")+"</td></tr>" +
            "<tr><td colspan=\"2\" class=\"fiche-title\">Produit</td></tr>" +
            "<tr><th>Marque du produit</th><td>"+(d.marque_produit||"")+"</td></tr>" +
            "<tr><th>Produit concerné</th><td>"+(d.produit_concerne||"")+"</td></tr>" +
            "<tr><th>Référence de la pièce</th><td>"+(d.reference_piece||"")+"</td></tr>" +
            "<tr><th>Quantité posée</th><td>"+(d.quantite_posee||"")+"</td></tr>" +
            "<tr><td colspan=\"2\" class=\"fiche-title\">Véhicule</td></tr>" +
            "<tr><th>Immatriculation</th><td>"+(d.immatriculation||"")+"</td></tr>" +
            "<tr><th>Marque</th><td>"+(d.marque_vehicule||"")+"</td></tr>" +
            "<tr><th>Modèle</th><td>"+(d.modele_vehicule||"")+"</td></tr>" +
            "<tr><th>Numéro de série</th><td>"+(d.num_serie||"")+"</td></tr>" +
            "<tr><th>1ère immatriculation</th><td>"+(d.premiere_immat||"")+"</td></tr>" +
            "<tr><td colspan=\"2\" class=\"fiche-title\">Problème</td></tr>" +
            "<tr><th>Date de pose</th><td>"+(d.date_pose||"")+"</td></tr>" +
            "<tr><th>Date du constat</th><td>"+(d.date_constat||"")+"</td></tr>" +
            "<tr><th>Kilométrage à la pose</th><td>"+(d.km_pose||"")+"</td></tr>" +
            "<tr><th>Kilométrage au constat</th><td>"+(d.km_constat||"")+"</td></tr>" +
            "<tr><th>Problème rencontré</th><td>"+(d.probleme_rencontre||"")+"</td></tr>" +
            "<tr><th>Date de création du dossier</th><td>"+(d.date?(new Date(d.date)).toLocaleDateString('fr-FR'):"")+"</td></tr>" +
            "<tr><th>Statut</th><td>"+(d.statut||"")+"</td></tr>" +
            "<tr><th>Pièces jointes</th><td>"+
                ((d.files||[]).length === 0
                  ? 'Aucune'
                  : d.files.map(function(f){
                      let ext = f.original.split('.').pop().toLowerCase();
                      if(['jpg','jpeg','png','gif','webp','bmp'].includes(ext)){
                        return '<a href=\"/download/'+f.url+'\" target=\"_blank\" rel=\"noopener\"><img src=\"/download/'+f.url+'\" class=\"pj-img\"></a>';
                      } else {
                        return '<a href=\"/download/'+f.url+'\" target=\"_blank\" rel=\"noopener noreferrer\">'+f.original+'</a>';
                      }
                    }).join("<br>")
                ) +
              "</td></tr>" +
              "<tr><th>Réponse / documents admin</th><td>"+
                (d.reponse||"") +
                ((d.reponseFiles||[]).length
                  ? "<br>"+d.reponseFiles.map(function(f){return '<a href=\"/download/'+f.url+'\" target=\"_blank\" rel=\"noopener noreferrer\">'+f.original+'</a>';}).join("<br>")
                  : "") +
              "</td></tr>" +
            "</table></div></body></html>";
        let w = window.open("", "_blank", "width=820,height=900");
        w.document.write(detailHtml);
        w.document.close();
      };

      document.getElementById("importForm").onsubmit = function () {
        setTimeout(() => {
          alert("Import en cours... Actualisez la page admin dans quelques secondes pour voir le résultat.");
        }, 200);
      };

      renderTable(activeMagasin, moisFilter, anneeFilter);
      attachOngletEvents();
    </script>
  `;
  res.send(html);
});

app.get("/download/:fileid", (req, res) => {
  const fileid = req.params.fileid;
  const demandes = loadDemandes();
  let found = null;
  for (const d of demandes) {
    let f = (d.files || []).find(f => f.url === fileid);
    if (f) { found = f; break; }
    if (d.reponseFiles) {
      let fr = d.reponseFiles.find(f2 => f2.url === fileid);
      if (fr) { found = fr; break; }
    }
  }
  if (!found) return res.status(404).send("Fichier introuvable");
  const filePath = path.join(UPLOADS_DIR, fileid);
  const contentType = mime.lookup(found.original) || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename="${found.original}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.listen(PORT, () => console.log("Serveur garantie en ligne sur port " + PORT));
