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

/*
 * Durand Services Garantie – Serveur complet
 *
 * Ce serveur regroupe les fonctionnalités nécessaires pour gérer les demandes
 * de garantie. Les données et pièces jointes sont sauvegardées sur un
 * serveur FTP afin de persister à travers les redémarrages de l'hébergeur.
 * Des notifications par e‑mail sont envoyées au client et au magasin
 * concerné lors de la création d'une demande. L'interface d'administration
 * permet de mettre à jour les dossiers, d'ajouter des documents et de
 * télécharger des sauvegardes complètes.
 */

// Détermination des chemins absolus
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Liste des magasins autorisés et mapping vers les e‑mails de contact
const MAGASINS = [
  "Annemasse",
  "Bourgoin-Jallieu",
  "Chasse-sur-Rhone",
  "Chassieu",
  "Gleize",
  "La Motte-Servolex",
  "Les Echets",
  "Pavi",
  "Rives",
  "Saint-Egreve",
  "Saint-Jean-Bonnefonds",
  "Saint-martin-d'heres",
  "Seynod",
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
  "Pavi": "adv@plateformepavi.fr",
};

// Paramètres FTP via variables d'environnement
const FTP_HOST = process.env.FTP_HOST;
const FTP_PORT = process.env.FTP_PORT;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_BACKUP_FOLDER = process.env.FTP_BACKUP_FOLDER || "/Disque 1/sauvegardegarantie";
const JSON_FILE_FTP   = path.posix.join(FTP_BACKUP_FOLDER, "demandes.json");
const UPLOADS_FTP     = path.posix.join(FTP_BACKUP_FOLDER, "uploads");

// Configuration du transporteur SMTP (utilise Gmail par défaut)
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Middlewares express
app.use(cors());
app.use(cookieParser());
app.use(express.json());
// Servir les fichiers statiques du dossier public
app.use(express.static(path.join(__dirname, "public")));

// Configuration de Multer : enregistrement temporaire des fichiers
const tempUploadsDir = path.join(__dirname, "temp_uploads");
fs.mkdirSync(tempUploadsDir, { recursive: true });
const upload = multer({ dest: tempUploadsDir });

/*
 * Fonctions utilitaires FTP
 */
async function getFTPClient() {
  const client = new ftp.Client();
  await client.access({
    host: FTP_HOST,
    port: FTP_PORT,
    user: FTP_USER,
    password: FTP_PASS,
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });
  return client;
}

// Lecture du fichier JSON des demandes depuis le FTP
async function readDataFTP() {
  const client = await getFTPClient();
  let json;
  try {
    const tmpFile = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmpFile, JSON_FILE_FTP);
    json = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    fs.unlinkSync(tmpFile);
  } catch (e) {
    json = [];
  }
  client.close();
  return json;
}

// Écriture du fichier JSON des demandes sur le FTP
async function writeDataFTP(data) {
  const client = await getFTPClient();
  const tmpFile = path.join(__dirname, "temp_demandes.json");
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  await client.ensureDir(FTP_BACKUP_FOLDER);
  await client.uploadFrom(tmpFile, JSON_FILE_FTP);
  fs.unlinkSync(tmpFile);
  client.close();
}

// Téléversement d'un fichier local vers le FTP
async function uploadFileToFTP(localPath, remoteSubfolder = "uploads", remoteFileName = null) {
  const client = await getFTPClient();
  const remoteName = remoteFileName || path.basename(localPath);
  const remotePath = path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder, remoteName);
  await client.ensureDir(path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder));
  await client.uploadFrom(localPath, remotePath);
  client.close();
}

// Suppression d'un fichier sur le FTP
async function deleteFileFromFTP(remoteFileName) {
  const client = await getFTPClient();
  const remotePath = path.posix.join(UPLOADS_FTP, remoteFileName);
  await client.remove(remotePath).catch(() => {});
  client.close();
}

// Streaming d'un fichier depuis le FTP vers la réponse HTTP
async function streamFTPFileToRes(res, remotePath, fileName, mimeType) {
  const client = await getFTPClient();
  const tmpPath = path.join(__dirname, "tmp_dl_" + fileName);
  await client.downloadTo(tmpPath, remotePath).catch(() => {});
  client.close();
  if (fs.existsSync(tmpPath)) {
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    if (mimeType) res.setHeader("Content-Type", mimeType);
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on("end", () => {
      fs.unlinkSync(tmpPath);
    });
  } else {
    res.status(404).send("Not found");
  }
}

// Génération d'un suffixe temporel au format AAAAMMJJHHMMSS pour les sauvegardes
function nowSuffix() {
  const d = new Date();
  return d.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

// Téléchargement temporaire des pièces jointes d'un dossier depuis le FTP
async function fetchFilesFromFTP(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];
  const client = await getFTPClient();
  const files = [];
  for (const f of fileObjs) {
    const remote = path.posix.join(UPLOADS_FTP, f.url);
    const tmpPath = path.join(__dirname, "att_" + f.url.replace(/[^\w.]/g, ""));
    await client.downloadTo(tmpPath, remote).catch(() => {});
    files.push({ filename: f.original, path: tmpPath });
  }
  client.close();
  return files;
}

// Nettoyage des fichiers locaux temporaires
function cleanupFiles(arr) {
  if (!arr || !arr.length) return;
  for (const f of arr) {
    if (f && f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
  }
}

// Création d'une sauvegarde dans le dossier FTP (conserve les 10 plus récentes)
async function saveBackupFTP() {
  const client = await getFTPClient();
  const suffix = nowSuffix();
  const backupName = `sauvegarde-${suffix}.json`;
  const remotePath = path.posix.join(FTP_BACKUP_FOLDER, backupName);
  // Télécharger le fichier JSON actuel dans un fichier temporaire
  const tmp = path.join(__dirname, "tmp_backup.json");
  await client.downloadTo(tmp, JSON_FILE_FTP).catch(() => {});
  if (fs.existsSync(tmp)) {
    await client.uploadFrom(tmp, remotePath);
    fs.unlinkSync(tmp);
  }
  // Supprimer les sauvegardes excédentaires
  const list = await client.list(FTP_BACKUP_FOLDER);
  const backups = list.filter((f) => f.name.startsWith("sauvegarde-")).sort((a, b) => a.name.localeCompare(b.name));
  while (backups.length > 10) {
    const b = backups.shift();
    await client.remove(path.posix.join(FTP_BACKUP_FOLDER, b.name)).catch(() => {});
  }
  client.close();
}

// Récupère l'image du logo depuis GitHub pour la génération de PDF
async function getLogoBuffer() {
  const url = "https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png";
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
}

// Génère un PDF récapitulatif de la demande
async function creerPDFDemande(d) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 32, size: "A4" });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      const logo = await getLogoBuffer();
      const PAGE_W = doc.page.width;
      const logoW = 55;
      const logoH = 55;
      const x0 = 36;
      let y0 = 36;
      // En-tête avec logo
      doc.image(logo, x0, y0, { width: logoW, height: logoH });
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#14548C");
      doc.text("DURAND SERVICES GARANTIE", x0 + logoW + 12, y0 + 6);
      doc.font("Helvetica").fontSize(14).fillColor("#14548C");
      doc.text(d.magasin || "", x0 + logoW + 12, y0 + 32);
      doc.fontSize(11).fillColor("#000");
      doc.text(
        "Créé le : " + (d.date ? new Date(d.date).toLocaleDateString("fr-FR") : ""),
        PAGE_W - 150,
        y0 + 6,
        { align: "left", width: 120 }
      );
      let y = y0 + logoH + 32;
      const tableW = PAGE_W - 2 * x0;
      const colLabelW = 155;
      const colValW = tableW - colLabelW;
      const rowHeight = 22;
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
        ["Problème rencontré", (d.probleme_rencontre || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "multiline"],
      ];
      // Calcul du nombre total de lignes en fonction des champs multiline
      let totalRows = 0;
      for (const row of rows) {
        const type = row[2];
        if (type === "multiline") {
          totalRows += row[1] ? row[1].split("\n").length : 1;
        } else {
          totalRows += 1;
        }
      }
      const tableH = rowHeight * totalRows;
      const cornerRad = 14;
      // Dessin du tableau
      doc.roundedRect(x0, y, tableW, tableH, cornerRad).fillAndStroke("#fff", "#3f628c");
      doc.lineWidth(1.7).roundedRect(x0, y, tableW, tableH, cornerRad).stroke("#3f628c");
      let yCursor = y;
      for (let i = 0; i < rows.length; i++) {
        const [label, value, type] = rows[i];
        const valueLines = type === "multiline" ? (value ? value.split("\n") : [""]) : [value];
        const cellHeight = rowHeight * valueLines.length;
        // Label
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(label, x0 + 16, yCursor + 4, {
          width: colLabelW - 16,
          align: "left",
        });
        // Valeur(s)
        doc.font("Helvetica").fontSize(11).fillColor("#000");
        for (let k = 0; k < valueLines.length; k++) {
          doc.text(valueLines[k], x0 + colLabelW + 8, yCursor + 4 + k * rowHeight, {
            width: colValW - 16,
            align: "left",
          });
        }
        // Ligne séparatrice si nécessaire
        let drawLine = false;
        if (type === "rowline") drawLine = true;
        else if (i < rows.length - 1 && rows[i + 1][2] !== "multiline" && type !== "multiline") drawLine = true;
        if (i === rows.length - 1) drawLine = false;
        if (drawLine) {
          doc
            .moveTo(x0 + 8, yCursor + cellHeight)
            .lineTo(x0 + tableW - 8, yCursor + cellHeight)
            .strokeColor("#b3c5df")
            .lineWidth(1)
            .stroke();
        }
        yCursor += cellHeight;
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/*
 * ROUTES HTTP
 */

// Enregistrement d'une nouvelle demande
app.post("/api/demandes", upload.any(), async (req, res) => {
  try {
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const body = req.body || {};
    const d = { ...body };
    d.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    d.date = new Date().toISOString();
    d.statut = "enregistré";
    // Champs facultatifs initialisés
    d.files = [];
    d.reponse = "";
    d.reponseFiles = [];
    d.documentsAjoutes = [];
    // Traiter les pièces jointes envoyées
    for (const f of req.files || []) {
      const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${f.originalname.replace(/\s/g, "_")}`;
      await uploadFileToFTP(f.path, "uploads", remoteName);
      d.files.push({ url: remoteName, original: f.originalname });
      fs.unlinkSync(f.path);
    }
    data.push(d);
    await writeDataFTP(data);
    await saveBackupFTP();
    // Création du PDF et envoi de mail au client
    let pdfBuffer;
    try {
      pdfBuffer = await creerPDFDemande(d);
    } catch (e) {
      pdfBuffer = null;
    }
    if (d.email) {
      try {
        await mailer.sendMail({
          from: `Garantie <${process.env.GMAIL_USER}>`,
          to: d.email,
          subject: "Demande de Garantie Envoyée",
          text:
            `Bonjour, votre demande de garantie a été envoyée avec succès.\n\nMerci d'imprimer et de joindre le fichier ci‑joint avec votre pièce.\n\nCordialement\nL'équipe Durand Services Garantie.`,
          attachments: pdfBuffer
            ? [
                {
                  filename: `dossier-${d.id}.pdf`,
                  content: pdfBuffer,
                  contentType: "application/pdf",
                },
              ]
            : [],
        });
      } catch (e) {
        // ignore erreur d'envoi
      }
    }
    // Envoi du mail au magasin concerné avec pièces jointes
    const respMail = MAGASIN_MAILS[d.magasin] || "";
    if (respMail) {
      const attachments = await fetchFilesFromFTP(d.files);
      try {
        await mailer.sendMail({
          from: `Garantie <${process.env.GMAIL_USER}>`,
          to: respMail,
          subject: `Nouvelle demande de garantie`,
          html: `<b>Nouvelle demande reçue pour le magasin ${d.magasin}.</b><br>Client : ${d.nom} (${d.email})<br>Marque du produit : ${d.marque_produit || ""}<br>Date : ${new Date().toLocaleDateString("fr-FR")}<br><br>`,
          attachments: attachments.map((f) => ({ filename: f.filename, path: f.path })),
        });
      } catch (e) {
        // ignore
      }
      cleanupFiles(attachments);
    }
    res.json(d);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de la demande." });
  }
});

// Récupération des demandes (filtrage possible par email, magasin, statut)
app.get("/api/demandes", async (req, res) => {
  try {
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const { email, magasin, statut } = req.query;
    let results = data;
    if (email) {
      const e = email.toLowerCase();
      results = results.filter((d) => d.email && d.email.toLowerCase() === e);
    }
    if (magasin) {
      results = results.filter((d) => d.magasin === magasin);
    }
    if (statut) {
      results = results.filter((d) => d.statut === statut);
    }
    // Retourner un clone afin d'éviter les mutations accidentelles
    res.json(results.map((r) => ({ ...r })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur de récupération des demandes." });
  }
});

// Récupération d'une demande par ID
app.get("/api/demandes/:id", async (req, res) => {
  try {
    const data = await readDataFTP();
    const d = data.find((r) => r.id === req.params.id);
    if (!d) return res.status(404).json({ error: "Demande introuvable." });
    res.json({ ...d });
  } catch (e) {
    res.status(500).json({ error: "Erreur de recherche." });
  }
});

// Mise à jour d'un dossier par l'admin (statut, réponse, pièces jointes)
app.post(
  "/api/admin/dossier/:id",
  upload.fields([
    { name: "reponseFiles", maxCount: 10 },
    { name: "documentsAjoutes", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;
      let data = await readDataFTP();
      if (!Array.isArray(data)) data = [];
      const dossier = data.find((x) => x.id === id);
      if (!dossier) return res.json({ success: false, message: "Dossier introuvable" });

      const oldStatut = dossier.statut;
      const oldReponse = dossier.reponse;
      const oldFilesLength = dossier.reponseFiles ? dossier.reponseFiles.length : 0;

      // Mise à jour des champs simples
      if (req.body.statut !== undefined) dossier.statut = req.body.statut;
      if (req.body.reponse !== undefined) dossier.reponse = req.body.reponse;
      if (req.body.numero_avoir !== undefined) dossier.numero_avoir = req.body.numero_avoir;

      dossier.reponseFiles = dossier.reponseFiles || [];
      dossier.documentsAjoutes = dossier.documentsAjoutes || [];
      // Téléversement des fichiers de réponse
      if (req.files && req.files.reponseFiles) {
        for (const f of req.files.reponseFiles) {
          const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${f.originalname.replace(/\s/g, "_")}`;
          await uploadFileToFTP(f.path, "uploads", remoteName);
          dossier.reponseFiles.push({ url: remoteName, original: f.originalname });
          dossier.documentsAjoutes.push({ url: remoteName, original: f.originalname });
          fs.unlinkSync(f.path);
        }
      }
      // Téléversement des documents supplémentaires
      if (req.files && req.files.documentsAjoutes) {
        for (const f of req.files.documentsAjoutes) {
          const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${f.originalname.replace(/\s/g, "_")}`;
          await uploadFileToFTP(f.path, "uploads", remoteName);
          dossier.documentsAjoutes.push({ url: remoteName, original: f.originalname });
          fs.unlinkSync(f.path);
        }
      }
      // Sauvegarde
      await writeDataFTP(data);
      await saveBackupFTP();
      // Déterminer s'il faut envoyer un mail au client
      let mailDoitEtreEnvoye = false;
      const changes = [];
      if (req.body.statut && req.body.statut !== oldStatut) {
        changes.push("statut");
        mailDoitEtreEnvoye = true;
      }
      if (req.body.reponse && req.body.reponse !== oldReponse) {
        changes.push("réponse");
        mailDoitEtreEnvoye = true;
      }
      if (
        req.files &&
        req.files.reponseFiles &&
        req.files.reponseFiles.length > 0 &&
        dossier.reponseFiles.length !== oldFilesLength
      ) {
        changes.push("pièce jointe");
        mailDoitEtreEnvoye = true;
      }
      if (mailDoitEtreEnvoye && dossier.email) {
        const attachments = await fetchFilesFromFTP(dossier.reponseFiles);
        let html = `<div style="font-family:sans-serif;">Bonjour,<br>Votre dossier de garantie a été mis à jour.<br>Produit : ${dossier.produit_concerne}<br>Date : ${new Date().toLocaleDateString("fr-FR")}<br><ul>`;
        if (changes.includes("statut")) html += `<li><b>Nouveau statut :</b> ${dossier.statut}</li>`;
        if (changes.includes("réponse")) html += `<li><b>Réponse :</b> ${dossier.reponse}</li>`;
        if (changes.includes("pièce jointe")) html += `<li><b>Documents ajoutés à votre dossier.</b></li>`;
        html += `</ul><br><br>L'équipe Garantie Durand<br><br></div>`;
        try {
          await mailer.sendMail({
            from: `Garantie Durand Services <${process.env.GMAIL_USER}>`,
            to: dossier.email,
            subject: `Mise à jour dossier garantie Durand Services`,
            html,
            attachments: attachments.map((f) => ({ filename: f.filename, path: f.path })),
          });
        } catch (e) {
          // ignore
        }
        cleanupFiles(attachments);
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: err.message });
    }
  }
);

// Liste des dossiers pour l'administration
app.get("/api/admin/dossiers", async (req, res) => {
  try {
    const data = await readDataFTP();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Erreur lors de la récupération des dossiers." });
  }
});

// Liste des dossiers pour un utilisateur (filtré par email)
app.get("/api/mes-dossiers", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    const data = await readDataFTP();
    const dossiers = data.filter((d) => d.email && d.email.toLowerCase() === email);
    res.json(dossiers);
  } catch (e) {
    res.status(500).json({ error: "Erreur lors de la récupération des dossiers." });
  }
});

// Téléchargement d'un fichier depuis le FTP via /download/:file
app.get("/download/:file", async (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9\-_.]/g, "");
  const remotePath = path.posix.join(UPLOADS_FTP, file);
  const mimeType = mime.lookup(file) || undefined;
  await streamFTPFileToRes(res, remotePath, file, mimeType);
});

// Fournir également les fichiers via /uploads/ pour compatibilité avec le front-end
app.get("/uploads/:file", async (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9\-_.]/g, "");
  const remotePath = path.posix.join(UPLOADS_FTP, file);
  const mimeType = mime.lookup(file) || undefined;
  await streamFTPFileToRes(res, remotePath, file, mimeType);
});

// Authentification de l'admin / superadmin
app.post("/api/admin/login", (req, res) => {
  const pw = (req.body && req.body.password) ? req.body.password : "";
  if (pw === process.env["superadmin-pass"]) return res.json({ success: true, isSuper: true, isAdmin: true });
  if (pw === process.env["admin-pass"]) return res.json({ success: true, isSuper: false, isAdmin: true });
  for (const magasin of MAGASINS) {
    const key = "magasin-" + magasin.replace(/[^\w]/g, "-") + "-pass";
    if (process.env[key] && pw === process.env[key]) {
      return res.json({ success: true, isSuper: false, isAdmin: false, magasin });
    }
  }
  res.json({ success: false, message: "Mot de passe incorrect" });
});

// Suppression d'un dossier (superadmin uniquement)
app.delete("/api/admin/dossier/:id", async (req, res) => {
  if (!req.headers["x-superadmin"]) return res.json({ success: false, message: "Non autorisé" });
  const { id } = req.params;
  try {
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const idx = data.findIndex((x) => x.id === id);
    if (idx === -1) return res.json({ success: false, message: "Introuvable" });
    const dossier = data[idx];
    // Supprimer toutes les pièces jointes liées au dossier
    if (dossier.files) {
      for (const f of dossier.files) {
        await deleteFileFromFTP(f.url);
      }
    }
    if (dossier.reponseFiles) {
      for (const f of dossier.reponseFiles) {
        await deleteFileFromFTP(f.url);
      }
    }
    if (dossier.documentsAjoutes) {
      for (const f of dossier.documentsAjoutes) {
        await deleteFileFromFTP(f.url);
      }
    }
    data.splice(idx, 1);
    await writeDataFTP(data);
    await saveBackupFTP();
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ success: false, message: e.message });
  }
});

// Export de toutes les données et pièces jointes dans un fichier ZIP
app.get("/api/admin/exportzip", async (req, res) => {
  try {
    const client = await getFTPClient();
    const fileName = `sauvegarde-garantie-${nowSuffix()}.zip`;
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/zip");
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => res.status(500).send({ error: err.message }));
    // Fichier JSON
    const tmpJSON = path.join(__dirname, "tmp_export_demandes.json");
    await client.downloadTo(tmpJSON, JSON_FILE_FTP).catch(() => {});
    archive.file(tmpJSON, { name: "demandes.json" });
    // Tous les fichiers uploadés
    const files = await client.list(UPLOADS_FTP);
    for (const f of files) {
      const tmpFile = path.join(__dirname, "tmp_export_" + f.name);
      await client.downloadTo(tmpFile, path.posix.join(UPLOADS_FTP, f.name));
      archive.file(tmpFile, { name: path.posix.join("uploads", f.name) });
      archive.on("end", () => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      });
    }
    archive.pipe(res);
    archive.finalize();
    archive.on("end", () => {
      if (fs.existsSync(tmpJSON)) fs.unlinkSync(tmpJSON);
      client.close();
    });
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

// Import d'une archive ZIP (remplace le jeu de données actuel)
app.post("/api/admin/importzip", upload.single("backupzip"), async (req, res) => {
  if (!req.file) return res.json({ success: false, message: "Aucun fichier reçu" });
  try {
    const zipPath = req.file.path;
    // Extraire le contenu du zip dans un dossier temporaire
    const extractPath = path.join(__dirname, "tmp_restore");
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .promise();
    // Restaurer le JSON
    const jsonSrc = path.join(extractPath, "demandes.json");
    if (fs.existsSync(jsonSrc)) {
      const data = JSON.parse(fs.readFileSync(jsonSrc, "utf8"));
      await writeDataFTP(data);
    } else {
      throw new Error("Le fichier demandes.json est manquant dans l'archive");
    }
    // Restaurer les uploads
    const newUploadsDir = path.join(extractPath, "uploads");
    if (fs.existsSync(newUploadsDir)) {
      const files = fs.readdirSync(newUploadsDir);
      for (const f of files) {
        await uploadFileToFTP(path.join(newUploadsDir, f), "uploads", f);
      }
    }
    fs.rmSync(extractPath, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    await saveBackupFTP();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Route pour l'interface d'administration
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Redirection racine vers la page d'index du front-end
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Serveur Garantie Durand démarré sur le port ${PORT}`);
});