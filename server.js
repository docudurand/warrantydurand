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
  "Pavi": "adv@plateformepavi.fr",
  "Rives": "magvl3rives@durandservices.fr",
  "Saint-Egreve": "magvlstegreve@durandservices.fr",
  "Saint-Jean-Bonnefonds": "respmagsjb@durandservices.fr",
  "Saint-martin-d'heres": "magvl1smdh@durandservices.fr",
  "Seynod": "respmagseynod@durandservices.fr"
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

    const pdfBuffer = await generateFichePDF(d);

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

    if (d.email) {
      let clientNom = (d.nom||"Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      let dateStr = d.date ? d.date.slice(0,10) : "";
      let nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}.pdf`;
      await mailer.sendMail({
        from: "Garantie Durand Services <" + process.env.GMAIL_USER + ">",
        to: d.email,
        subject: "Demande envoyée avec succès",
        text:
`Votre demande de Garantie a été envoyée avec succès.

Cordialement
L'équipe Durand Services Garantie.`,
        attachments: [
          {
            filename: nomFichier,
            content: pdfBuffer
          }
        ]
      });
    }

    await saveBackupFTP();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

function generateFichePDF(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({margin: 40});
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));

    doc.fontSize(22).fillColor('#006e90').text('Demande de Garantie', {align: 'center'});
    doc.moveDown();

    doc.fontSize(12).fillColor('#17537a');
    doc.text(`Nom du client : ${d.nom||""}`);
    doc.text(`Email : ${d.email||""}`);
    doc.text(`Magasin : ${d.magasin||""}`);
    doc.moveDown();

    doc.fillColor('#006e90').fontSize(16).text('Produit', {underline:true});
    doc.fontSize(12).fillColor('#222');
    doc.text(`Marque du produit : ${d.marque_produit||""}`);
    doc.text(`Produit concerné : ${d.produit_concerne||""}`);
    doc.text(`Référence de la pièce : ${d.reference_piece||""}`);
    doc.text(`Quantité posée : ${d.quantite_posee||""}`);
    doc.moveDown();

    doc.fillColor('#006e90').fontSize(16).text('Véhicule', {underline:true});
    doc.fontSize(12).fillColor('#222');
    doc.text(`Immatriculation : ${d.immatriculation||""}`);
    doc.text(`Marque : ${d.marque_vehicule||""}`);
    doc.text(`Modèle : ${d.modele_vehicule||""}`);
    doc.text(`Numéro de série : ${d.num_serie||""}`);
    doc.text(`1ère immatriculation : ${d.premiere_immat||""}`);
    doc.moveDown();

    doc.fillColor('#006e90').fontSize(16).text('Problème', {underline:true});
    doc.fontSize(12).fillColor('#222');
    doc.text(`Date de pose : ${d.date_pose||""}`);
    doc.text(`Date du constat : ${d.date_constat||""}`);
    doc.text(`Kilométrage à la pose : ${d.km_pose||""}`);
    doc.text(`Kilométrage au constat : ${d.km_constat||""}`);
    doc.text(`N° BL 1ère Vente : ${d.bl_pose||""}`);
    doc.text(`N° BL 2ème Vente : ${d.bl_constat||""}`);
    doc.text(`Problème rencontré : ${d.probleme_rencontre||""}`);

    doc.end();
  });
}

import("./routes/adminRoutes.js").catch(() => { });

app.listen(PORT, ()=>console.log("Serveur garanti sur "+PORT));
