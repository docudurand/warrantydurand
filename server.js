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

async function creerPDFDemande(d, nomFichier) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        resolve(Buffer.concat(buffers));
      });

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const tableX = doc.page.margins.left + 18;
      const tableWidth = pageWidth - 36;
      let y = 50;

      const logoUrl = 'https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png';
      doc.image(logoUrl, tableX, y, { width: 62 });
      doc.font("Helvetica-Bold").fontSize(16).fillColor("#14548C")
        .text(d.magasin || "", tableX + 75, y + 8, { align: "left" });
      doc.font("Helvetica").fontSize(11).fillColor("#333")
        .text("Créé le : " + new Date(d.date).toLocaleDateString("fr-FR"), tableX + 75, y + 28, { align: "left" });
      y += 60;

      const rows = [
        [{ txt: "Informations client", section: true }],
        ["Nom du client", d.nom || ""],
        ["Email", d.email || ""],
        ["Magasin", d.magasin || ""],

        [{ txt: "Produit", section: true }],
        ["Marque du produit", d.marque_produit || ""],
        ["Produit concerné", d.produit_concerne || ""],
        ["Référence de la pièce", d.reference_piece || ""],
        ["Quantité posée", d.quantite_posee || ""],

        [{ txt: "Véhicule", section: true }],
        ["Immatriculation", d.immatriculation || ""],
        ["Marque", d.marque_vehicule || ""],
        ["Modèle", d.modele_vehicule || ""],
        ["Numéro de série", d.num_serie || ""],
        ["1ère immatriculation", d.premiere_immat || ""],

        [{ txt: "Problème", section: true }],
        ["Date de pose", d.date_pose || ""],
        ["Date du constat", d.date_constat || ""],
        ["Kilométrage à la pose", d.km_pose || ""],
        ["Kilométrage au constat", d.km_constat || ""],
        ["N° BL 1ère Vente", d.bl_pose || ""],
        ["N° BL 2ème Vente", d.bl_constat || ""],
        ["Problème rencontré", d.probleme_rencontre || ""],
      ];

      const rowHeight = 28;
      const leftColWidth = 155;
      const rightColWidth = tableWidth - leftColWidth;
      const heights = rows.map(row => {
        if (row[0] && row[0].section) return rowHeight;
        if (row[1]) {
          if (row[0] === "Problème rencontré") {
            return Math.max(rowHeight, doc.heightOfString(row[1], { width: rightColWidth - 16 }) + 12);
          }
        }
        return rowHeight;
      });
      const tableHeight = heights.reduce((a, b) => a + b, 0);

      const radius = 15;
      doc.save();
      doc.roundedRect(tableX, y, tableWidth, tableHeight, radius).fillAndStroke("#F8FAFD", "#90A7C3");
      doc.restore();

      let curY = y;
      for (let i = 0; i < rows.length; i++) {
        const h = heights[i];
        const row = rows[i];
        if (row[0] && row[0].section) {
          doc.rect(tableX, curY, tableWidth, h).fill("#e3eefb");
          doc.font("Helvetica-Bold").fontSize(12).fillColor("#14548C")
            .text(row[0].txt, tableX + 16, curY + 7, { align: "left" });
        } else {
          if (i > 0) {
            doc.moveTo(tableX, curY).lineTo(tableX + tableWidth, curY).strokeColor("#90A7C3").lineWidth(1).stroke();
          }
          doc.font("Helvetica").fontSize(11).fillColor("#14548C")
            .text(row[0], tableX + 14, curY + (h - 16) / 2, { width: leftColWidth - 18, align: "left" });
          doc.font("Helvetica").fontSize(11).fillColor("#222")
            .text(row[1], tableX + leftColWidth + 10, curY + (h - doc.heightOfString(row[1], { width: rightColWidth - 16 })) / 2, {
              width: rightColWidth - 16,
              align: "left"
            });
        }
        curY += h;
      }
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
          { filename: nomFichier, content: pdfBuffer, contentType: "application/pdf" }
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
