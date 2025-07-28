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

function nowSuffix() {
  const d = new Date();
  return d.toISOString().slice(0,19).replace(/[-:T]/g,"");
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

async function saveBackupFTP() {
	console.log("====> saveBackupFTP: démarrage");

   const client = await getFTPClient();
  const d = new Date();
  const suffix = nowSuffix();
  const name = `sauvegarde-${suffix}.zip`;
  const remoteZipPath = path.posix.join(FTP_BACKUP_FOLDER, name);

  const tempDir = path.join(__dirname, "tmp_zip_" + suffix);
  fs.mkdirSync(tempDir, { recursive: true });

  const localJson = path.join(tempDir, "demandes.json");
  try {
    await client.downloadTo(localJson, JSON_FILE_FTP);
    console.log("====> saveBackupFTP: demandes.json téléchargé");
  } catch (e) {
    fs.writeFileSync(localJson, "[]");
    console.log("====> saveBackupFTP: demandes.json absent, fichier vide créé");
  }

  const uploadsDir = path.join(tempDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  let uploadFiles = [];
  try {
    uploadFiles = await client.list(UPLOADS_FTP);
    console.log("====> saveBackupFTP: fichiers upload listés");
  } catch (e) {
    console.log("====> saveBackupFTP: erreur listing uploads", e);
  }
  for(const f of uploadFiles) {
    const filePath = path.join(uploadsDir, f.name);
    try {
      await client.downloadTo(filePath, path.posix.join(UPLOADS_FTP, f.name));
      console.log(`====> saveBackupFTP: ${f.name} téléchargé`);
    } catch (e) {
      console.log(`====> saveBackupFTP: ERREUR download ${f.name}`, e);
    }
  }
  client.close();

  const localZip = path.join(__dirname, name);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(localZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(localJson, { name: "demandes.json" });
    archive.directory(uploadsDir, "uploads");
    archive.finalize();
  });
  console.log("====> saveBackupFTP: zip local créé", localZip);

  const client2 = await getFTPClient();
  await client2.uploadFrom(localZip, remoteZipPath);
  console.log("====> saveBackupFTP: zip uploadé sur FTP", remoteZipPath);
  client2.close();

  fs.rmSync(tempDir, { recursive: true, force: true });
  if (fs.existsSync(localZip)) fs.unlinkSync(localZip);

  const client3 = await getFTPClient();
  const files = await client3.list(FTP_BACKUP_FOLDER);
  const backups = files.filter(f=>/^sauvegarde-\d+\.zip$/.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
  while (backups.length > 5) {
    await client3.remove(path.posix.join(FTP_BACKUP_FOLDER, backups[0].name));
    backups.shift();
  }
  console.log("====> saveBackupFTP: purge des anciens backups terminée");
  client3.close();
}


async function getLogoBuffer() {
  const url = "https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png";
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
}

async function creerPDFDemande(d, nomFichier) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 32, size: "A4" });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      const logo = await getLogoBuffer();
      const PAGE_W = doc.page.width;
      const logoW = 55, logoH = 55;
      const x0 = 36;
      let y0 = 36;
      doc.image(logo, x0, y0, { width: logoW, height: logoH });
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#14548C");
      doc.text("DURAND SERVICES GARANTIE", x0 + logoW + 12, y0 + 6, { align: "left", continued: false });
      doc.font("Helvetica").fontSize(14).fillColor("#14548C");
      doc.text(d.magasin || "", x0 + logoW + 12, y0 + 32, { align: "left" });
      doc.fontSize(11).fillColor("#000");
      doc.text("Créé le : " + (d.date ? new Date(d.date).toLocaleDateString("fr-FR") : ""), PAGE_W - 150, y0 + 6, { align: "left", width: 120 });
      let y = y0 + logoH + 32;
      const tableW = PAGE_W - 2 * x0;
      const colLabelW = 155;
      const colValW = tableW - colLabelW;
      const rowHeight = 22;
      const labelFont = "Helvetica-Bold";
      const valueFont = "Helvetica";
      const rows = [
        ["Nom du client", d.nom || ""],
        ["Email", d.email || ""],
        ["Magasin", d.magasin || "", "rowline"],
        ["Marque du produit", d.marque_produit || ""],
        ["Produit concerné", d.produit_concerne || ""],
        ["Référence de la pièce", d.reference_piece || ""],
        ["Quantité posée", d.quantite_posee || "", "rowline"],
        ["Immatriculation", d.immatriculation || ""],
        ["Marque", d.marque_vehicule || ""],
        ["Modèle", d.modele_vehicule || ""],
        ["Numéro de série", d.num_serie || ""],
        ["1ère immatriculation", d.premiere_immat || "", "rowline"],
        ["Date de pose", d.date_pose || ""],
        ["Date du constat", d.date_constat || ""],
        ["Kilométrage à la pose", d.km_pose || ""],
        ["Kilométrage au constat", d.km_constat || ""],
        ["N° BL 1ère Vente", d.bl_pose || ""],
        ["N° BL 2ème Vente", d.bl_constat || "", "rowline"],
        ["Problème rencontré", (d.probleme_rencontre||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n"), "multiline"]
      ];
      let totalRow = rows.reduce((sum, row) => sum + ((row[2] === "multiline") ? (row[1].split("\n").length) : 1), 0);
      let tableH = rowHeight * totalRow;
      let cornerRad = 14;
      doc.roundedRect(x0, y, tableW, tableH, cornerRad).fillAndStroke("#fff", "#3f628c");
      doc.lineWidth(1.7).roundedRect(x0, y, tableW, tableH, cornerRad).stroke("#3f628c");
      let yCursor = y;
      for (let i = 0; i < rows.length; i++) {
        const [label, value, type] = rows[i];
        let valueLines = (type === "multiline") ? value.split("\n") : [value];
        let cellHeight = rowHeight * valueLines.length;
        doc.font(labelFont).fontSize(11).fillColor("#000")
          .text(label, x0 + 16, yCursor + 4, { width: colLabelW - 16, align: "left" });
        doc.font(valueFont).fontSize(11).fillColor("#000");
        for (let k = 0; k < valueLines.length; k++) {
          doc.text(valueLines[k], x0 + colLabelW + 8, yCursor + 4 + k * rowHeight, { width: colValW - 16, align: "left" });
        }
        let drawLine = false;
        if (type === "rowline") drawLine = true;
        else if (i < rows.length - 1 && rows[i+1][2] !== "multiline" && type !== "multiline") drawLine = true;
        if (i === rows.length - 1) drawLine = false;
        if (drawLine) {
          doc.moveTo(x0 + 8, yCursor + cellHeight).lineTo(x0 + tableW - 8, yCursor + cellHeight).strokeColor("#b3c5df").lineWidth(1).stroke();
        }
        yCursor += cellHeight;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

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
    await saveBackupFTP();
    let clientNom = (d.nom||"Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    let dateStr = "";
    if (d.date) {
      let dt = new Date(d.date);
      if (!isNaN(dt)) dateStr = dt.toISOString().slice(0,10);
    }
    let nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}.pdf`;
    const pdfBuffer = await creerPDFDemande(d, nomFichier.replace(/\.pdf$/, ""));
    if (d.email) {
      await mailer.sendMail({
        from: "Garantie <" + process.env.GMAIL_USER + ">",
        to: d.email,
        subject: "Demande de Garantie Envoyée",
        text:
`Bonjour votre demande de garantie a été envoyée avec succès, merci d'imprimer et de joindre le fichier ci-joint avec votre pièce.

Cordialement
L'équipe Durand Services Garantie.
`,
        attachments: [
          {
            filename: nomFichier,
            content: pdfBuffer,
            contentType: "application/pdf"
          }
        ]
      });
    }
    const respMail = MAGASIN_MAILS[d.magasin] || "";
    if (respMail) {
      const attachments = await fetchFilesFromFTP(d.files);
      await mailer.sendMail({
        from: "Garantie <" + process.env.GMAIL_USER + ">",
        to: respMail,
        subject: `Nouvelle demande de garantie`,
        html: `<b>Nouvelle demande reçue pour le magasin ${d.magasin}.</b><br>
          Client : ${d.nom} (${d.email})<br>
          Marque du produit : ${d.marque_produit||""}<br>
          Date : ${(new Date()).toLocaleDateString("fr-FR")}<br><br><br>`,
        attachments: attachments.map(f=>({filename: f.filename, path: f.path}))
      });
      cleanupFiles(attachments);
    }
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

  const oldStatut = dossier.statut;
  const oldReponse = dossier.reponse;
  const oldFilesLength = (dossier.reponseFiles||[]).length;

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
  await saveBackupFTP();

  let mailDoitEtreEnvoye = false;
  let changes = [];
  if (req.body.statut && req.body.statut !== oldStatut) { changes.push("statut"); mailDoitEtreEnvoye = true; }
  if (req.body.reponse && req.body.reponse !== oldReponse) { changes.push("réponse"); mailDoitEtreEnvoye = true; }
  if (req.files && req.files.reponseFiles && req.files.reponseFiles.length > 0 && (dossier.reponseFiles.length !== oldFilesLength)) {
    changes.push("pièce jointe"); mailDoitEtreEnvoye = true;
  }
  if (mailDoitEtreEnvoye && dossier.email) {
    const attachments = await fetchFilesFromFTP(dossier.reponseFiles);
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
      attachments: attachments.map(f=>({filename: f.filename, path: f.path}))
    });
    cleanupFiles(attachments);
  }
  res.json({success:true});
});

app.get("/api/admin/dossiers", async (req, res) => {
  let data = await readDataFTP();
  res.json(data);
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
  let data = await readDataFTP();
  if (!Array.isArray(data)) data = [];
  let idx = data.findIndex(x=>x.id===id);
  if (idx === -1) return res.json({success:false, message:"Introuvable"});
  let dossier = data[idx];
  if(dossier.files){ for(const f of dossier.files){ await deleteFileFromFTP(f.url); } }
  if(dossier.reponseFiles){ for(const f of dossier.reponseFiles){ await deleteFileFromFTP(f.url); } }
  if(dossier.documentsAjoutes){ for(const f of dossier.documentsAjoutes){ await deleteFileFromFTP(f.url); } }
  data.splice(idx,1);
  await writeDataFTP(data);
  await saveBackupFTP();
  res.json({success:true});
});

app.get("/api/admin/exportzip", async (req, res) => {
  try {
    const client = await getFTPClient();
    const fileName = "sauvegarde-garantie-" + nowSuffix() + ".zip";
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error("Erreur archiver:", err);
      if (!res.headersSent) res.status(500).send({error: err.message});
    });

    const tmp = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmp, JSON_FILE_FTP);

    const uploadFiles = await client.list(UPLOADS_FTP);
    let tmpFiles = [];
    for(const f of uploadFiles){
      const tmpFile = path.join(__dirname, "temp_upload_"+f.name);
      await client.downloadTo(tmpFile, path.posix.join(UPLOADS_FTP, f.name));
      tmpFiles.push({local: tmpFile, archive: path.posix.join("uploads", f.name)});
    }
    client.close();

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
    });

  } catch (e) {
    console.error("Erreur exportzip:", e);
    if (!res.headersSent) res.status(500).send({error: e.message});
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
      const data = JSON.parse(fs.readFileSync(jsonSrc,"utf8"));
      await writeDataFTP(data);
    } else {
      throw new Error("Le fichier demandes.json est manquant dans l'archive");
    }
    const newUploads = path.join(__dirname, "tmp_restore", "uploads");
    if (fs.existsSync(newUploads)) {
      const files = fs.readdirSync(newUploads);
      for(const f of files){
        await uploadFileToFTP(path.join(newUploads, f), "uploads", f);
      }
    }
    fs.rmSync(path.join(__dirname, "tmp_restore"), { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    await saveBackupFTP();
    res.json({success:true});
  } catch (e) {
    res.json({success:false, message:e.message});
  }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "suivi.html")));
app.listen(PORT, ()=>console.log("Serveur OK "+PORT));
