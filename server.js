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
import ftp from "basic-ftp";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "demandes.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

const MAGASINS = [
  "Annemasse","Bourgoin-Jallieu","Chasse-sur-Rhone","Chassieu","Gleize","La Motte-Servolex",
  "Les Echets","Pavi","Rives","Saint-Egreve","Saint-Jean-Bonnefonds","Saint-martin-d'heres","Seynod"
];

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
  "Pavi": "adv@plateformepavi.fr"
};

const FTP_HOST = process.env.FTP_HOST;
const FTP_PORT = process.env.FTP_PORT;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_BACKUP_FOLDER = process.env.FTP_BACKUP_FOLDER || "/Disque 1/sauvegardegarantie";

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

function nowSuffix() {
  const d = new Date();
  const pad = n => n.toString().padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

async function saveBackupFTP() {
  return new Promise((resolve, reject) => {
    const backupPath = path.join(__dirname, "backup_tmp.zip");
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(backupPath);
    output.on("close", async () => {
      const fileName = "sauvegarde-garantie-" + nowSuffix() + ".zip";
      try {
        await uploadBackupToFTP(backupPath, fileName);
        await cleanOldBackupsFTP();
        fs.unlinkSync(backupPath);
        resolve();
      } catch (err) {
        console.error("Erreur FTP backup:", err.message);
        reject(err);
      }
    });
    archive.pipe(output);
    archive.file(DATA_FILE, { name: "demandes.json" });
    if (fs.existsSync(UPLOADS_DIR)) {
      archive.directory(UPLOADS_DIR, "uploads");
    }
    archive.finalize();
  });
}

async function uploadBackupToFTP(localPath, remoteFilename) {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      port: FTP_PORT,
      user: FTP_USER,
      password: FTP_PASS,
      secure: true,
      secureOptions: { rejectUnauthorized: false }
    });
    await client.ensureDir(FTP_BACKUP_FOLDER);
    await client.uploadFrom(localPath, path.posix.join(FTP_BACKUP_FOLDER, remoteFilename));
    console.log("Backup uploadé sur le FTP !");
  } catch (err) {
    console.error("Erreur FTP :", err.message);
  }
  client.close();
}

async function cleanOldBackupsFTP() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      port: FTP_PORT,
      user: FTP_USER,
      password: FTP_PASS,
      secure: true,
      secureOptions: { rejectUnauthorized: false }
    });
    await client.ensureDir(FTP_BACKUP_FOLDER);
    const list = await client.list(FTP_BACKUP_FOLDER);
    const backups = list
      .filter(f => /^sauvegarde-garantie-\d{4}-\d{2}-\d{2}_\d{2}h\d{2}\.zip$/.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (backups.length > 10) {
      const toDelete = backups.slice(10);
      for (const f of toDelete) {
        await client.remove(path.posix.join(FTP_BACKUP_FOLDER, f.name));
        console.log("Suppression vieille sauvegarde FTP :", f.name);
      }
    }
  } catch (err) {
    console.error("Erreur nettoyage FTP :", err.message);
  }
  client.close();
}

mailer.sendMail({
  from: "Garantie Durand Services <" + process.env.GMAIL_USER + ">",
  to: "magvl4gleize@durandservices.fr",
  subject: "[ALERTE] Redémarrage du serveur Garantie Durand Services",
  html: `<b>Attention : le serveur de garantie vient de redémarrer sur Render.</b><br>
         Pense à vérifier les dossiers et à restaurer la sauvegarde si besoin.<br>
         Date : ${(new Date()).toLocaleString("fr-FR")}`
}, (err, info) => {
  if(err) console.error("Erreur envoi mail redémarrage :", err.message);
});

app.post("/api/demandes", upload.array("document"), async (req, res) => {
  try {
    const data = readData();
    if (!data || data.length === 0) {
      return res.json({
        success: false,
        message: "Maintenance en cours (aucune sauvegarde restaurée). Merci de réessayer dans quelques minutes."
      });
    }
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
          Date : ${(new Date()).toLocaleDateString("fr-FR")}<br><br><br>`,
        attachments: d.files.map(f=>({filename: f.original, path: path.join(UPLOADS_DIR, f.url)}))
      });
    }
    await saveBackupFTP();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get("/api/admin/dossiers", (req, res) => {
  const data = readData();
  res.json(data);
});

app.post("/api/admin/dossier/:id", upload.array("reponseFiles"), async (req, res) => {
  let { id } = req.params;
  let data = readData();
  let dossier = data.find(x=>x.id===id);
  if (!dossier) return res.json({success:false, message:"Dossier introuvable"});

  let oldStatut = dossier.statut;
  let oldReponse = dossier.reponse;
  let oldFilesLength = (dossier.reponseFiles||[]).length;

  if (req.body.statut !== undefined) dossier.statut = req.body.statut;
  if (req.body.reponse !== undefined) dossier.reponse = req.body.reponse;
  if (req.body.numero_avoir !== undefined) dossier.numero_avoir = req.body.numero_avoir;
  if (req.files && req.files.length) {
    dossier.reponseFiles = (dossier.reponseFiles||[]).concat(
      req.files.map(f=>({url: path.basename(f.filename), original: f.originalname}))
    );
  }

  writeData(data);

  let mailDoitEtreEnvoye = false;
  let changes = [];
  if (req.body.statut && req.body.statut !== oldStatut) { changes.push("statut"); mailDoitEtreEnvoye = true; }
  if (req.body.reponse && req.body.reponse !== oldReponse) { changes.push("réponse"); mailDoitEtreEnvoye = true; }
  if (req.files && req.files.length > 0 && (dossier.reponseFiles.length !== oldFilesLength)) {
    changes.push("pièce jointe"); mailDoitEtreEnvoye = true;
  }

  if (mailDoitEtreEnvoye && dossier.email) {
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
      <br><br>L'équipe Garantie Durand<br><br>
    </div>`;
    await mailer.sendMail({
      from: "Garantie Durand Services <" + process.env.GMAIL_USER + ">",
      to: dossier.email,
      subject: `Mise à jour dossier garantie Durand Services`,
      html,
      attachments: att
    });
  }

  await saveBackupFTP();
  res.json({success:true});
});

app.post("/api/admin/login", (req, res) => {
  let pw = (req.body && req.body.password) ? req.body.password : "";
  if (pw === process.env["superadmin-pass"]) return res.json({success:true, isSuper:true, isAdmin:true});
  if (pw === process.env["admin-pass"]) return res.json({success:true, isSuper:false, isAdmin:true});
  for (const magasin of MAGASINS) {
    const key = "magasin-"+magasin.replace(/[^\w]/g, "-")+"-pass";
    if (process.env[key] && pw === process.env[key]) {
      return res.json({success:true, isSuper:false, isAdmin:false, magasin});
    }
  }
  res.json({success:false, message:"Mot de passe incorrect"});
});

app.delete("/api/admin/dossier/:id", async (req, res) => {
  if (!req.headers['x-superadmin']) return res.json({success:false, message:"Non autorisé"});
  let { id } = req.params;
  let data = readData();
  let idx = data.findIndex(x=>x.id===id);
  if (idx === -1) return res.json({success:false, message:"Introuvable"});
  let dossier = data[idx];
  if(dossier.files){
    dossier.files.forEach(f=>{
      let p = path.join(UPLOADS_DIR, f.url);
      if(fs.existsSync(p)) try{fs.unlinkSync(p);}catch{}
    });
  }
  if(dossier.reponseFiles){
    dossier.reponseFiles.forEach(f=>{
      let p = path.join(UPLOADS_DIR, f.url);
      if(fs.existsSync(p)) try{fs.unlinkSync(p);}catch{}
    });
  }
  data.splice(idx,1);
  writeData(data);
  await saveBackupFTP();
  res.json({success:true});
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
    const fileName = "sauvegarde-garantie-" + nowSuffix() + ".zip";
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).send({error: err.message}));
    archive.file(DATA_FILE, { name: "demandes.json" });
    if (fs.existsSync(UPLOADS_DIR)) {
      archive.directory(UPLOADS_DIR, "uploads");
    }
    const backupPath = path.join(__dirname, "backup_tmp.zip");
    const output = fs.createWriteStream(backupPath);
    archive.pipe(res);
    archive.pipe(output);

    output.on("close", async () => {
      await uploadBackupToFTP(backupPath, fileName);
      await cleanOldBackupsFTP();
      fs.unlinkSync(backupPath);
    });
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
    await saveBackupFTP();
    res.json({success:true});
  } catch (e) {
    res.json({success:false, message:e.message});
  }
});

app.listen(PORT, ()=>console.log("Serveur garanti sur "+PORT));
