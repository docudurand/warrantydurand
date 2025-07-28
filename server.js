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
import PDFDocument from "pdfkit";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

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
const JSON_FILE_FTP = path.posix.join(FTP_BACKUP_FOLDER, "demandes.json");
const UPLOADS_FTP = path.posix.join(FTP_BACKUP_FOLDER, "uploads");

const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

app.use(cors());
app.use(cookieParser());
app.use(express.json());
const upload = multer({ dest: "temp_uploads/" });

function nowSuffixForZip() {
  const now = new Date();
  return (
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0") +
    "_" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0")
  );
}
function nowSuffix() {
  const d = new Date();
  return d.toISOString().slice(0,19).replace(/[-:T]/g,"");
}

async function getFTPClient() {
  const client = new ftp.Client();
  await client.access({
    host: FTP_HOST,
    port: FTP_PORT,
    user: FTP_USER,
    password: FTP_PASS,
    secure: true,
    secureOptions: { rejectUnauthorized: false }
  });
  return client;
}

async function readDataFTP() {
  const client = await getFTPClient();
  let json = [];
  try {
    const tmp = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmp, JSON_FILE_FTP);
    json = JSON.parse(fs.readFileSync(tmp, "utf8"));
    fs.unlinkSync(tmp);
  } catch (e) { json = []; }
  client.close();
  return json;
}

async function writeDataFTP(data) {
  const client = await getFTPClient();
  const tmp = path.join(__dirname, "temp_demandes.json");
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  await client.ensureDir(FTP_BACKUP_FOLDER);
  await client.uploadFrom(tmp, JSON_FILE_FTP);
  fs.unlinkSync(tmp);
  client.close();
}

async function uploadFileToFTP(localPath, remoteSubfolder = "uploads", remoteFileName = null) {
  const client = await getFTPClient();
  const remoteName = remoteFileName || path.basename(localPath);
  const remotePath = path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder, remoteName);
  await client.uploadFrom(localPath, remotePath);
  client.close();
}

async function deleteFileFromFTP(remoteFileName) {
  const client = await getFTPClient();
  const remotePath = path.posix.join(UPLOADS_FTP, remoteFileName);
  await client.remove(remotePath).catch(()=>{});
  client.close();
}

async function streamFTPFileToRes(res, remotePath, fileName, mimeType) {
  const client = await getFTPClient();
  let tempPath = path.join(__dirname, "tempdl_"+fileName);
  await client.downloadTo(tempPath, remotePath).catch(()=>{});
  client.close();
  if (fs.existsSync(tempPath)) {
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    if (mimeType) res.setHeader("Content-Type", mimeType);
    const s = fs.createReadStream(tempPath);
    s.pipe(res);
    s.on("end", ()=>fs.unlinkSync(tempPath));
  } else {
    res.status(404).send("Not found");
  }
}

async function fetchFilesFromFTP(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];
  const client = await getFTPClient();
  let files = [];
  for (let f of fileObjs) {
    let remote = path.posix.join(UPLOADS_FTP, f.url);
    let tempPath = path.join(__dirname, "att_"+f.url.replace(/[^\w.]/g,""));
    await client.downloadTo(tempPath, remote).catch(()=>{});
    files.push({ filename: f.original, path: tempPath });
  }
  client.close();
  return files;
}

function cleanupFiles(arr) {
  if (!arr || !arr.length) return;
  for (let f of arr) {
    if (f && f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
  }
}

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

app.get("/api/admin/dossiers", async (req, res) => {
  let data = await readDataFTP();
  res.json(data);
});

app.post("/api/demandes", upload.array("document"), async (req, res) => {
  try {
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    let d = req.body;
    d.id = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
    d.date = new Date().toISOString();
    d.statut = "enregistré";
    d.files = [];
    for (const f of req.files || []) {
      const remoteName = Date.now() + "-" + Math.round(Math.random() * 1e8) + "-" + f.originalname.replace(/\s/g, "_");
      await uploadFileToFTP(f.path, "uploads", remoteName);
      d.files.push({ url: remoteName, original: f.originalname });
      fs.unlinkSync(f.path);
    }
    d.reponse = "";
    d.reponseFiles = [];
    d.documentsAjoutes = [];
    data.push(d);
    await writeDataFTP(data);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post("/api/admin/dossier/:id", upload.fields([
  { name: "reponseFiles", maxCount: 10 },
  { name: "documentsAjoutes", maxCount: 10 }
]), async (req, res) => {
  let { id } = req.params;
  let data = await readDataFTP();
  if (!Array.isArray(data)) data = [];
  let dossier = data.find(x=>x.id===id);
  if (!dossier) return res.json({success:false, message:"Dossier introuvable"});

  if (req.body.statut !== undefined) dossier.statut = req.body.statut;
  if (req.body.reponse !== undefined) dossier.reponse = req.body.reponse;
  if (req.body.numero_avoir !== undefined) dossier.numero_avoir = req.body.numero_avoir;

  dossier.reponseFiles = dossier.reponseFiles || [];
  dossier.documentsAjoutes = dossier.documentsAjoutes || [];

  if (req.files && req.files.reponseFiles) {
    for (const f of req.files.reponseFiles) {
      const remoteName = Date.now() + "-" + Math.round(Math.random() * 1e8) + "-" + f.originalname.replace(/\s/g, "_");
      await uploadFileToFTP(f.path, "uploads", remoteName);
      dossier.reponseFiles.push({ url: remoteName, original: f.originalname });
      dossier.documentsAjoutes.push({ url: remoteName, original: f.originalname });
      fs.unlinkSync(f.path);
    }
  }
  if (req.files && req.files.documentsAjoutes) {
    for (const f of req.files.documentsAjoutes) {
      const remoteName = Date.now() + "-" + Math.round(Math.random() * 1e8) + "-" + f.originalname.replace(/\s/g, "_");
      await uploadFileToFTP(f.path, "uploads", remoteName);
      dossier.documentsAjoutes.push({ url: remoteName, original: f.originalname });
      fs.unlinkSync(f.path);
    }
  }

  await writeDataFTP(data);
  res.json({success:true});
});

app.get("/api/mes-dossiers", async (req, res) => {
  let email = (req.query.email||"").toLowerCase();
  let data = await readDataFTP();
  let dossiers = data.filter(d=>d.email && d.email.toLowerCase()===email);
  res.json(dossiers);
});

app.get("/download/:file", async (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9\-_.]/g,"");
  const remotePath = path.posix.join(UPLOADS_FTP, file);
  const mimeType = mime.lookup(file) || undefined;
  await streamFTPFileToRes(res, remotePath, file, mimeType);
});

app.get("/api/admin/exportzip", async (req, res) => {
  console.log("====> exportzip: démarrage");
  const client = await getFTPClient();
  try {
    const tmp = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmp, JSON_FILE_FTP);
    console.log("====> exportzip: téléchargement demandes.json");

    let uploadFiles = [];
    try {
      uploadFiles = await client.list(UPLOADS_FTP);
      uploadFiles = uploadFiles.filter(f => f.type === 0);
      console.log("====> exportzip: fichiers uploads trouvés", uploadFiles.length);
    } catch (e) {
      console.log("====> exportzip: ERREUR listage", e);
    }

    let tmpFiles = [];
    for(const f of uploadFiles){
      const tmpFile = path.join(__dirname, "temp_upload_" + f.name);
      try {
        await client.downloadTo(tmpFile, path.posix.join(UPLOADS_FTP, f.name));
        tmpFiles.push({local: tmpFile, archive: path.posix.join("uploads", f.name)});
      } catch (err) {
        console.log("====> exportzip: ERREUR download", f.name, err);
      }
    }
    client.close();

    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Disposition', `attachment; filename="sauvegarde-garantie-${nowSuffix()}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    archive.on('error', err => {
      console.error("Erreur archiver:", err);
      if (!res.headersSent) res.status(500).send({error: err.message});
    });

    archive.file(tmp, { name: "demandes.json" });
    for(const f of tmpFiles){
      archive.file(f.local, { name: f.archive });
    }

    archive.pipe(res);
    archive.finalize();

    archive.on('end', ()=>{
      if(fs.existsSync(tmp)) fs.unlinkSync(tmp);
      for(const f of tmpFiles){
        if(fs.existsSync(f.local)) fs.unlinkSync(f.local);
      }
      console.log("====> exportzip: nettoyage terminé");
    });

  } catch (e) {
    client.close();
    console.error("Erreur exportzip:", e);
    if (!res.headersSent) res.status(500).send({error: e.message});
  }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "suivi.html")));
app.listen(PORT, ()=>console.log("Serveur OK "+PORT));