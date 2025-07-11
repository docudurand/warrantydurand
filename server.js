import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import mime from "mime-types";
import archiver from "archiver";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "demandes.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// Associe chaque magasin à une adresse mail responsable
const MAGASIN_MAILS = {
  "Annemasse": "respmagannemasse@durandservices.fr",
  "Bourgoin-Jallieu": "magasin5bourgoin@durandservices.fr",
  "Chasse-sur-Rhone": "magvl5chasse@durandservices.fr",
  "Chassieu": "magasin5chassieu@durandservices.fr",
  "Gleize": "mag5gleize@durandservices.fr",
  "La Motte-Servolex": "magasinlms@durandservices.fr",
  "Les Echets": "magasin5echets@durandservices.fr",
  "Rives": "magasin5rives@durandservices.fr",
  "Saint-Egreve": "mag5stegreve@durandservices.fr",
  "Saint-Jean-Bonnefonds": "magasin5sjbf@durandservices.fr",
  "Saint-martin-d'heres": "magasin5smh@durandservices.fr",
  "Seynod": "magasin5seynod@durandservices.fr"
};

// Nodemailer (GMAIL_USER / GMAIL_PASS)
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");

app.use(cors());
app.use(cookieParser());
app.use(express.json());
// On n'utilise plus app.use(express.static('public'));
app.use("/uploads", express.static(UPLOADS_DIR));

// Multer pour upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e8);
    cb(null, unique + "-" + file.originalname.replace(/\s/g, "_"));
  }
});
const upload = multer({ storage });

// Helpers
const readData = () => JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const writeData = (arr) => fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));

// --- ROUTES ---

// Soumission demande client (avec fichiers)
app.post("/api/demandes", upload.array("document"), async (req, res) => {
  try {
    let d = req.body;
    d.id = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
    d.date = new Date().toISOString();
    d.statut = "enregistré";
    d.files = (req.files||[]).map(f=>({
      url: path.basename(f.filename),
      original: f.originalname
    }));
    d.reponse = "";
    d.reponseFiles = [];
    const data = readData();
    data.push(d);
    writeData(data);

    // Envoi mail responsable magasin
    const respMail = MAGASIN_MAILS[d.magasin] || "";
    if (respMail) {
      await mailer.sendMail({
        from: process.env.GMAIL_USER,
        to: respMail,
        subject: `Nouvelle demande garantie (${d.magasin})`,
        html: `<b>Nouvelle demande reçue pour le magasin ${d.magasin}.</b><br>
          Client : ${d.nom} (${d.email})<br>
          Produit : ${d.produit_concerne||""}<br>
          <a href="[ADMIN_URL]">Accéder à l'admin</a>`,
        attachments: d.files.map(f=>({filename: f.original, path: path.join(UPLOADS_DIR, f.url)}))
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Liste dossiers pour admin
app.get("/api/admin/dossiers", (req, res) => {
  res.json(readData());
});

// Changement statut, ajout réponse et/ou fichiers (ADMIN)
app.post("/api/admin/dossier/:id", upload.array("reponseFiles"), async (req, res) => {
  let { id } = req.params;
  let data = readData();
  let dossier = data.find(x=>x.id===id);
  if (!dossier) return res.json({success:false, message:"Dossier introuvable"});
  let oldStatut = dossier.statut;

  // On accepte : soit changement de statut, soit réponse, soit fichier
  if (req.body.statut) dossier.statut = req.body.statut;
  if (req.body.reponse) dossier.reponse = req.body.reponse;
  if (req.files && req.files.length) {
    dossier.reponseFiles = (dossier.reponseFiles||[]).concat(
      req.files.map(f=>({url: path.basename(f.filename), original: f.originalname}))
    );
  }
  writeData(data);

  // Email client à chaque changement (statut, réponse ou pièce jointe)
  let changes = [];
  if (req.body.statut && req.body.statut !== oldStatut) changes.push("statut");
  if (req.body.reponse) changes.push("réponse");
  if (req.files && req.files.length) changes.push("pièce jointe");
  if (changes.length && dossier.email) {
    let att = (dossier.reponseFiles||[]).map(f=>({
      filename: f.original, path: path.join(UPLOADS_DIR, f.url)
    }));
    let html = `<div style="font-family:sans-serif;">
      Bonjour,<br>
      Votre dossier de garantie <b>${dossier.produit_concerne||""}</b> (${dossier.magasin}) a été mis à jour.<br>
      <ul>
        ${changes.includes("statut") ? `<li><b>Nouveau statut :</b> ${dossier.statut}</li>` : ""}
        ${changes.includes("réponse") ? `<li><b>Réponse :</b> ${dossier.reponse}</li>` : ""}
        ${changes.includes("pièce jointe") ? `<li><b>Documents ajoutés à votre dossier.</b></li>` : ""}
      </ul>
      <br><br>L'équipe Garantie Durand
    </div>`;
    await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: dossier.email,
      subject: `Votre dossier garantie - mise à jour`,
      html,
      attachments: att
    });
  }

  res.json({success:true});
});

// Auth admin (cookie sécurisé)
app.post("/api/admin/login", (req, res) => {
  let pw = "";
  if (req.body && req.body.password) pw = req.body.password;
  if (pw === ADMIN_PASSWORD) return res.json({success:true});
  res.json({success:false, message:"Mot de passe incorrect"});
});

// Dossiers du client (email)
app.get("/api/mes-dossiers", (req, res) => {
  let email = (req.query.email||"").toLowerCase();
  let dossiers = readData().filter(d=>d.email && d.email.toLowerCase()===email);
  res.json(dossiers);
});

// Télécharger fichier joint (sécurité)
app.get("/download/:file", (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9\-_.]/g,"");
  const filePath = path.join(UPLOADS_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");
  res.download(filePath);
});

// Page admin seulement (héberger admin.html à côté du server.js)
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));

app.listen(PORT, ()=>console.log("Serveur garanti sur "+PORT));
