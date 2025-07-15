import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import mime from "mime-types";
import archiver from "archiver";
import unzipper from "unzipper";
import axios from "axios";
import FormData from "form-data";
import { fileURLToPath } from "url";


const PCLOUD_USER = process.env.PCLOUD_USER;
const PCLOUD_PASS = process.env.PCLOUD_PASS;
const PCLOUD_FOLDER = process.env.PCLOUD_FOLDER || "/sauvegardes";

let pcloudAuthToken = null;

async function getPCloudToken() {
  if (pcloudAuthToken) return pcloudAuthToken;
  try {
    const res = await axios.get("https://api.pcloud.com/login", {
      params: {
        getauth: 1,
        username: PCLOUD_USER,
        password: PCLOUD_PASS
      }
    });
    if (res.data && res.data.auth) {
      pcloudAuthToken = res.data.auth;
      return pcloudAuthToken;
    } else {
      throw new Error("Token pCloud non reçu");
    }
  } catch (err) {
    console.error("Erreur login pCloud :", err.response?.data || err.message);
    throw err;
  }
}

async function uploadBackupToPcloud(localPath, fileName = "sauvegarde-garantie.zip") {
  try {
    const auth = await getPCloudToken();

    await axios.get("https://api.pcloud.com/createfolderifnotexists", {
      params: {
        auth,
        path: PCLOUD_FOLDER
      }
    });

    try {
      await axios.get("https://api.pcloud.com/deletefile", {
        params: {
          auth,
          path: PCLOUD_FOLDER + "/" + fileName
        }
      });
    } catch {}

    const form = new FormData();
    form.append("file", fs.createReadStream(localPath));
    form.append("filename", fileName);
    form.append("auth", auth);
    form.append("path", PCLOUD_FOLDER);

    const res = await axios.post(
      "https://api.pcloud.com/uploadfile",
      form,
      { headers: form.getHeaders() }
    );
    if (res.data && res.data.result === 0) {
      console.log("Backup envoyé sur pCloud !");
    } else {
      throw new Error("Echec upload pCloud : " + (res.data?.error || JSON.stringify(res.data)));
    }
  } catch (err) {
    console.error("Erreur sauvegarde pCloud :", err.message);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "demandes.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

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
  "Seynod": "respmagseynod@durandservices.fr"
};

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
app.use("/uploads", express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e8);
    cb(null, unique + "-" + file.originalname.replace(/\s/g, "_"));
  }
});
const upload = multer({ storage });

const readData = () => JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const writeData = (arr) => fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));

function createBackupZip(callback) {
  const backupPath = path.join(__dirname, "backup_tmp.zip");
  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = fs.createWriteStream(backupPath);
  output.on("close", () => callback(backupPath));
  archive.pipe(output);
  archive.file(DATA_FILE, { name: "demandes.json" });
  if (fs.existsSync(UPLOADS_DIR)) {
    archive.directory(UPLOADS_DIR, "uploads");
  }
  archive.finalize();
}

async function autoBackup() {
  createBackupZip(async (zipPath) => {
    await uploadBackupToPcloud(zipPath);
    fs.unlink(zipPath, ()=>{});
  });
}

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

    const respMail = MAGASIN_MAILS[d.magasin] || "";
    if (respMail) {
      await mailer.sendMail({
        from: "Garantie <" + process.env.GMAIL_USER + ">",
        to: respMail,
        subject: `Nouvelle demande de garantie`,
        html: `<b>Nouvelle demande reçue pour le magasin ${d.magasin}.</b><br>
          Client : ${d.nom} (${d.email})<br>
          Marque du produit : ${d.marque_produit||""}<br>
          Date : ${(new Date()).toLocaleDateString("fr-FR")}<br>`,
        attachments: d.files.map(f=>({filename: f.original, path: path.join(UPLOADS_DIR, f.url)}))
      });
    }

    await autoBackup();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get("/api/admin/dossiers", (req, res) => {
  res.json(readData());
});

app.post("/api/admin/dossier/:id", upload.array("reponseFiles"), async (req, res) => {
  let { id } = req.params;
  let data = readData();
  let dossier = data.find(x=>x.id===id);
  if (!dossier) return res.json({success:false, message:"Dossier introuvable"});
  let oldStatut = dossier.statut;

  if (req.body.statut) dossier.statut = req.body.statut;
  if (req.body.reponse) dossier.reponse = req.body.reponse;
  if (req.files && req.files.length) {
    dossier.reponseFiles = (dossier.reponseFiles||[]).concat(
      req.files.map(f=>({url: path.basename(f.filename), original: f.originalname}))
    );
  }
  writeData(data);

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
      Votre dossier de garantie a été mis à jour.<br>
      Produit : ${dossier.produit_concerne}<br>
      Date : ${(new Date()).toLocaleDateString("fr-FR")}<br>
      <ul>
        ${changes.includes("statut") ? `<li><b>Nouveau statut :</b> ${dossier.statut}</li>` : ""}
        ${changes.includes("réponse") ? `<li><b>Réponse :</b> ${dossier.reponse}</li>` : ""}
        ${changes.includes("pièce jointe") ? `<li><b>Documents ajoutés à votre dossier.</b></li>` : ""}
      </ul>
      <br><br>L'équipe Garantie Durand
    </div>`;
    await mailer.sendMail({
      from: "Garantie Durand Services <" + process.env.GMAIL_USER + ">",
      to: dossier.email,
      subject: `Mise à jour dossier garantie Durand Services`,
      html,
      attachments: att
    });
  }
  await autoBackup();
  res.json({success:true});
});

app.post("/api/admin/login", (req, res) => {
  let pw = "";
  if (req.body && req.body.password) pw = req.body.password;
  if (pw === ADMIN_PASSWORD) return res.json({success:true});
  res.json({success:false, message:"Mot de passe incorrect"});
});

app.get("/api/mes-dossiers", (req, res) => {
  let email = (req.query.email||"").toLowerCase();
  let dossiers = readData().filter(d=>d.email && d.email.toLowerCase()===email);
  res.json(dossiers);
});

app.get("/download/:file", (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9\-_.]/g,"");
  const filePath = path.join(UPLOADS_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).send("Fichier introuvable");
  res.download(filePath, undefined, (err)=>{
    if (err) res.status(500).send("Erreur lors du téléchargement");
  });
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));

app.get("/api/admin/exportzip", async (req, res) => {
  try {
    res.setHeader('Content-Disposition', 'attachment; filename="sauvegarde-garantie.zip"');
    res.setHeader('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).send({error: err.message}));
    archive.pipe(res);
    archive.file(DATA_FILE, { name: "demandes.json" });
    if (fs.existsSync(UPLOADS_DIR)) {
      archive.directory(UPLOADS_DIR, "uploads");
    }
    archive.finalize();
  } catch (e) {
    res.status(500).send({error: e.message});
  }
});

app.post("/api/admin/importzip", upload.single("backupzip"), async (req, res) => {
  if (!req.file) return res.json({success:false, message:"Aucun fichier reçu"});
  try {
    const zipPath = req.file.path;
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: path.join(__dirname, "tmp_restore") }))
      .promise();
    const jsonSrc = path.join(__dirname, "tmp_restore", "demandes.json");
    if (fs.existsSync(jsonSrc)) {
      fs.copyFileSync(jsonSrc, DATA_FILE);
    } else {
      throw new Error("Le fichier demandes.json est manquant dans l'archive");
    }
    const newUploads = path.join(__dirname, "tmp_restore", "uploads");
    if (fs.existsSync(newUploads)) {
      if (fs.existsSync(UPLOADS_DIR)) {
        fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
      }
      fs.renameSync(newUploads, UPLOADS_DIR);
    }
    fs.rmSync(path.join(__dirname, "tmp_restore"), { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    await autoBackup();
    res.json({success:true});
  } catch (e) {
    res.json({success:false, message:e.message});
  }
});

app.listen(PORT, ()=>console.log("Serveur garanti sur "+PORT));
