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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const LOGO_PATH = path.join(__dirname, "DSG.png"); // Mets ici le chemin correct si besoin

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
  } catch (e) {
    json = [];
  }
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
  const remotePath = path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder);
  await client.ensureDir(remotePath);
  const fileName = remoteFileName || path.basename(localPath);
  await client.uploadFrom(localPath, path.posix.join(remotePath, fileName));
  client.close();
  return fileName;
}

async function deleteFileFromFTP(remoteFileName) {
  const client = await getFTPClient();
  const remotePath = path.posix.join(UPLOADS_FTP, remoteFileName);
  try {
    await client.remove(remotePath);
  } catch (e) {}
  client.close();
}

async function streamFTPFileToRes(res, remotePath, fileName, mimeType) {
  const client = await getFTPClient();
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  if (mimeType) res.setHeader("Content-Type", mimeType);
  try {
    await client.downloadTo(res, remotePath);
  } catch (e) {
    res.status(404).send("Fichier introuvable");
  }
  client.close();
}

function nowSuffix() {
  const d = new Date();
  const pad = n => n.toString().padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

async function fetchFilesFromFTP(fileObjs) {
  const localPaths = [];
  if (!fileObjs || fileObjs.length === 0) return [];
  const client = await getFTPClient();
  await client.ensureDir(UPLOADS_FTP);
  for (const f of fileObjs) {
    const remotePath = path.posix.join(UPLOADS_FTP, f.url);
    const tmp = path.join(__dirname, "mailtmp_" + f.url);
    try {
      await client.downloadTo(tmp, remotePath);
      localPaths.push({ path: tmp, filename: f.original });
    } catch (e) {}
  }
  client.close();
  return localPaths;
}
function cleanupFiles(localPaths) {
  if (!localPaths) return;
  for (const f of localPaths) {
    try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
  }
}

async function saveBackupFTP() {
  const clientDL = await getFTPClient();
  const tmpJSON = path.join(__dirname, "temp_demandes.json");
  try {
    await clientDL.downloadTo(tmpJSON, JSON_FILE_FTP);
  } catch (e) {
    fs.writeFileSync(tmpJSON, "[]");
  }
  clientDL.close();

  const backupPath = path.join(__dirname, "backup_tmp.zip");
  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = fs.createWriteStream(backupPath);
  archive.pipe(output);
  archive.file(tmpJSON, { name: "demandes.json" });
  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.finalize();
  });
  fs.unlinkSync(tmpJSON);

  const clientUP = await getFTPClient();
  const fileName = "sauvegarde-garantie-" + nowSuffix() + ".zip";
  await clientUP.ensureDir(FTP_BACKUP_FOLDER);
  await clientUP.uploadFrom(backupPath, path.posix.join(FTP_BACKUP_FOLDER, fileName));
  await cleanOldBackupsFTP(clientUP);
  clientUP.close();
  fs.unlinkSync(backupPath);
}

async function cleanOldBackupsFTP(client) {
  const list = await client.list(FTP_BACKUP_FOLDER);
  const backups = list
    .filter(f => /^sauvegarde-garantie-\d{4}-\d{2}-\d{2}_\d{2}h\d{2}\.zip$/.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (backups.length > 10) {
    const toDelete = backups.slice(10);
    for (const f of toDelete) {
      await client.remove(path.posix.join(FTP_BACKUP_FOLDER, f.name));
    }
  }
}

function creerPDFDemande(d, nomFichier) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 0, size: "A4" });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      const PAGE_W = 595.28;
      const MARGIN = 36, TABLE_W = PAGE_W - MARGIN*2, CELL_W = TABLE_W;
      let y = MARGIN;

      const logoSize = 56;
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, MARGIN+2, y, { width: logoSize });
      }
      doc.font("Helvetica-Bold").fontSize(15).fillColor("#14548C")
        .text(d.magasin || "", MARGIN + logoSize + 16, y + 5, { continued: true });
      doc.font("Helvetica").fontSize(11).fillColor("#222")
        .text("    Créé le : " + (d.date ? new Date(d.date).toLocaleDateString("fr-FR") : ""), MARGIN + logoSize + 170, y + 11);

      y += logoSize + 15;

      doc.save();
      doc.lineWidth(1.2);
      doc.roundedRect(MARGIN, y, CELL_W, 560, 12).stroke("#a5bddb");
      doc.restore();

      let ty = y + 12;

      const rows = [
        ["Nom du client", d.nom || ""],
        ["Email", d.email || ""],
        ["Magasin", d.magasin || ""],
        ["-", "-"], // SEP
        ["Marque du produit", d.marque_produit || ""],
        ["Produit concerné", d.produit_concerne || ""],
        ["Référence de la pièce", d.reference_piece || ""],
        ["Quantité posée", d.quantite_posee || ""],
        ["-", "-"], // SEP
        ["Immatriculation", d.immatriculation || ""],
        ["Marque", d.marque_vehicule || ""],
        ["Modèle", d.modele_vehicule || ""],
        ["Numéro de série", d.num_serie || ""],
        ["1ère immatriculation", d.premiere_immat || ""],
        ["-", "-"], // SEP
        ["Date de pose", d.date_pose || ""],
        ["Date du constat", d.date_constat || ""],
        ["Kilométrage à la pose", d.km_pose || ""],
        ["Kilométrage au constat", d.km_constat || ""],
        ["N° BL 1ère Vente", d.bl_pose || ""],
        ["N° BL 2ème Vente", d.bl_constat || ""],
      ];

      const sectionTitles = {
  0: "Informations client",
  4: "Produit",
  9: "Véhicule",
  14: "Problème"
};
const sepIndexes = [0, 4, 9, 14];

      let rowHeight = 26;
      let headerHeight = 22;

      for (let i = 0; i < rows.length; i++) {
        if (sepIndexes.includes(i)) {
          doc.save()
            .fillColor("#14548C")
            .rect(MARGIN, ty, CELL_W, headerHeight)
            .fill()
            .fillColor("white")
            .font("Helvetica-Bold")
            .fontSize(12)
            .text(sectionTitles[i], MARGIN + 10, ty + 5)
            .restore();
          doc.rect(MARGIN, ty, CELL_W, headerHeight).stroke("#a5bddb");
          ty += headerHeight;
        }
        if (rows[i][0] !== "-") {
          doc.save();
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#14548C")
            .text(rows[i][0], MARGIN + 10, ty + 7, { width: CELL_W/2 - 18, continued: true })
            .font("Helvetica").fillColor("#222")
            .text(rows[i][1], MARGIN + CELL_W/2 + 2, ty + 7, { width: CELL_W/2 - 16, align: "left" });
          doc.rect(MARGIN, ty, CELL_W, rowHeight).stroke("#a5bddb");
          doc.restore();
          ty += rowHeight;
        }
      }

      let pbText = d.probleme_rencontre || "";
      let pbHeight = doc.heightOfString(pbText, { width: CELL_W/2 - 16, align: "left", fontSize: 10, font: "Helvetica" });
      let pbCellH = Math.max(rowHeight, pbHeight + 16);

      doc.save();
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#14548C")
        .text("Problème rencontré", MARGIN + 10, ty + 7, { width: CELL_W/2 - 18, continued: true })
        .font("Helvetica").fillColor("#222")
        .text(pbText, MARGIN + CELL_W/2 + 2, ty + 7, { width: CELL_W/2 - 16, align: "left" });
      doc.rect(MARGIN, ty, CELL_W, pbCellH).stroke("#a5bddb");
      doc.restore();

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

app.post("/api/demandes", upload.array("document"), async (req, res) => {
  try {
    let data = await readDataFTP();
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
    data.push(d);
    await writeDataFTP(data);
    await saveBackupFTP();

    let clientNom = (d.nom||"Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    let dateStr = "";
    if (d.date) {
      let dt = new Date(d.date);
      if (!isNaN(dt)) {
        dateStr = dt.toISOString().slice(0,10);
      }
    }
    let nomFichier = `DURAND_SERVICES_${d.magasin ? d.magasin.toUpperCase() + "_" : ""}${dateStr}`.replace(/[\s]/g, "") + ".pdf";
    const pdfBuffer = await creerPDFDemande(d, nomFichier.replace(/\.pdf$/, ""));

    if (d.email) {
      const attachments = await fetchFilesFromFTP(d.files);
      await mailer.sendMail({
        from: "Garantie <" + process.env.GMAIL_USER + ">",
        to: d.email,
        subject: "Demande de Garantie Envoyée",
        text:
`Bonjour votre demande de garantie a été envoyée avec succès, merci de joindre le fichier ci-joint avec votre pièce.

Cordialement
L'équipe Durand Services Garantie.
`,
        attachments: [
          ...attachments.map(f=>({filename: f.filename, path: f.path})),
          {
            filename: nomFichier,
            content: pdfBuffer,
            contentType: "application/pdf"
          }
        ]
      });
      cleanupFiles(attachments);
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

app.post("/api/admin/dossier/:id", upload.array("reponseFiles"), async (req, res) => {
  let { id } = req.params;
  let data = await readDataFTP();
  let dossier = data.find(x=>x.id===id);
  if (!dossier) return res.json({success:false, message:"Dossier introuvable"});

  const oldStatut = dossier.statut;
  const oldReponse = dossier.reponse;
  const oldFilesLength = (dossier.reponseFiles||[]).length;

  if (req.body.statut !== undefined) dossier.statut = req.body.statut;
  if (req.body.reponse !== undefined) dossier.reponse = req.body.reponse;
  if (req.body.numero_avoir !== undefined) dossier.numero_avoir = req.body.numero_avoir;

  dossier.reponseFiles = dossier.reponseFiles || [];
  for (const f of req.files || []) {
    const remoteName = Date.now() + "-" + Math.round(Math.random() * 1e8) + "-" + f.originalname.replace(/\s/g, "_");
    await uploadFileToFTP(f.path, "uploads", remoteName);
    dossier.reponseFiles.push({ url: remoteName, original: f.originalname });
    fs.unlinkSync(f.path);
  }
  await writeDataFTP(data);
  await saveBackupFTP();

  let mailDoitEtreEnvoye = false;
  let changes = [];
  if (req.body.statut && req.body.statut !== oldStatut) { changes.push("statut"); mailDoitEtreEnvoye = true; }
  if (req.body.reponse && req.body.reponse !== oldReponse) { changes.push("réponse"); mailDoitEtreEnvoye = true; }
  if (req.files && req.files.length > 0 && (dossier.reponseFiles.length !== oldFilesLength)) {
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
  let idx = data.findIndex(x=>x.id===id);
  if (idx === -1) return res.json({success:false, message:"Introuvable"});
  let dossier = data[idx];
  if(dossier.files){
    for(const f of dossier.files){
      await deleteFileFromFTP(f.url);
    }
  }
  if(dossier.reponseFiles){
    for(const f of dossier.reponseFiles){
      await deleteFileFromFTP(f.url);
    }
  }
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
    archive.on('error', err => res.status(500).send({error: err.message}));
    const tmp = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmp, JSON_FILE_FTP);
    archive.file(tmp, { name: "demandes.json" });
    const uploadFiles = await client.list(UPLOADS_FTP);
    for(const f of uploadFiles){
      const tmpFile = path.join(__dirname, "temp_upload_"+f.name);
      await client.downloadTo(tmpFile, path.posix.join(UPLOADS_FTP, f.name));
      archive.file(tmpFile, { name: path.posix.join("uploads", f.name) });
      archive.on('end', ()=>{ if(fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); });
    }
    const output = fs.createWriteStream(path.join(__dirname, "backup_tmp.zip"));
    archive.pipe(res);
    archive.pipe(output);
    archive.finalize();
    output.on("close", ()=>{
      if(fs.existsSync(tmp)) fs.unlinkSync(tmp);
      if(fs.existsSync(path.join(__dirname, "backup_tmp.zip"))) fs.unlinkSync(path.join(__dirname, "backup_tmp.zip"));
      client.close();
    });
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

app.listen(PORT, ()=>console.log("Serveur garanti 100% FTP sur "+PORT));
