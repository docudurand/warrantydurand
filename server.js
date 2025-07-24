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
  try { await client.remove(remotePath); } catch (e) {}
  client.close();
}
async function streamFTPFileToRes(res, remotePath, fileName, mimeType) {
  const client = await getFTPClient();
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  if (mimeType) res.setHeader("Content-Type", mimeType);
  try { await client.downloadTo(res, remotePath); }
  catch (e) { res.status(404).send("Fichier introuvable"); }
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
  try { await clientDL.downloadTo(tmpJSON, JSON_FILE_FTP); }
  catch (e) { fs.writeFileSync(tmpJSON, "[]"); }
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

async function creerPDFDemande(d, nomFichier) {
  const logoUrl = "https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png";
  let logoBuffer = null;
  try {
    const logoRes = await axios.get(logoUrl, { responseType: "arraybuffer" });
    logoBuffer = logoRes.data;
  } catch {
    logoBuffer = null;
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 36
      });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      const pageWidth = doc.page.width;
      const margin = 36;
      const tableX = margin;
      const tableY = 115;
      const tableWidth = pageWidth - margin * 2;
      const leftCol = tableX + 16;
      const midCol = tableX + 180;
      const rightCol = tableX + 220;
      let y = tableY;

      if (logoBuffer) doc.image(logoBuffer, margin+4, 32, { width: 58 });
      doc.font("Helvetica-Bold").fontSize(22).fillColor("#15549b").text("DURAND SERVICES GARANTIE", margin+75, 32, {align:"left"});
      doc.font("Helvetica").fontSize(14).fillColor("#111").text((d.magasin || ""), margin+77, 58, {align:"left"});
      doc.fontSize(12).fillColor("#000").text("Créé le : " + (d.date ? new Date(d.date).toLocaleDateString("fr-FR") : ""), pageWidth-margin-170, 44, {align:"left"});

      doc.save();
      doc.roundedRect(tableX, tableY, tableWidth, 460, 18).lineWidth(1.8).stroke("#14548C");
      doc.restore();

      const champs = [
        { section: "Informations client", items: [
          { label: "Nom du client", value: d.nom||"" },
          { label: "Email", value: d.email||"" },
          { label: "Magasin", value: d.magasin||"" }
        ]},
        { section: "Produit", items: [
          { label: "Marque du produit", value: d.marque_produit||"" },
          { label: "Produit concerné", value: d.produit_concerne||"" },
          { label: "Référence de la pièce", value: d.reference_piece||"" },
          { label: "Quantité posée", value: d.quantite_posee||"" }
        ]},
        { section: "Véhicule", items: [
          { label: "Immatriculation", value: d.immatriculation||"" },
          { label: "Marque", value: d.marque_vehicule||"" },
          { label: "Modèle", value: d.modele_vehicule||"" },
          { label: "Numéro de série", value: d.num_serie||"" },
          { label: "1ère immatriculation", value: d.premiere_immat||"" }
        ]},
        { section: "Problème", items: [
          { label: "Date de pose", value: d.date_pose||"" },
          { label: "Date du constat", value: d.date_constat||"" },
          { label: "Kilométrage à la pose", value: d.km_pose||"" },
          { label: "Kilométrage au constat", value: d.km_constat||"" },
          { label: "N° BL 1ère Vente", value: d.bl_pose||"" },
          { label: "N° BL 2ème Vente", value: d.bl_constat||"" },
          { label: "Problème rencontré", value: d.probleme_rencontre||"" }
        ]}
      ];

      let currentY = tableY+20;
      doc.fontSize(13);

      champs.forEach((section, idxS) => {
        if(idxS !== 0) currentY += 5;
        doc.font("Helvetica-Bold").fillColor("#14548C").text(section.section, leftCol, currentY, { width: tableWidth-32, continued:false });
        currentY += 20;

        section.items.forEach((ch, idxI) => {

          doc.font("Helvetica").fontSize(12).fillColor("#333")
            .text(ch.label, leftCol, currentY+2, { width: 165, continued: false });

          let value = ch.value ? String(ch.value) : "";
          let isLast = (idxI === section.items.length-1 && idxS === champs.length-1);

          let cellHeight = doc.heightOfString(value, { width: tableWidth-220-30, align: "center", lineGap: 1 }) + 7;
          if(cellHeight < 20) cellHeight = 20;
          let valueY = currentY + (cellHeight > 20 ? 0 : 4);

          doc.font("Helvetica").fontSize(12).fillColor("#111")
            .text(value, rightCol, valueY, {
              width: tableWidth-220-30, align: "center"
            });

          if (!isLast) {
            doc.moveTo(tableX+14, currentY+cellHeight+1).lineTo(tableX+tableWidth-14, currentY+cellHeight+1)
              .lineWidth(1).strokeColor("#b3c2db").stroke();
          }

          currentY += cellHeight+2;
        });
      });

      doc.end();
    } catch(e) { reject(e); }
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
    let nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}.pdf`;
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

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "suivi.html")));

app.listen(PORT, ()=>console.log("Serveur garanti 100% FTP sur "+PORT));
