import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import mime from "mime-types";
import ftp from "basic-ftp";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import axios from "axios";
import ExcelJS from "exceljs";

// ✅ Mailjet (ou tout SMTP) via mailer.js commun
// ⚠️ Si ton mailer.js n'est pas dans le même dossier que ce fichier, ajuste le chemin (ex: ../mailer.js)
import { transporter, fromEmail } from "./mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const STATUTS = {
  ENREGISTRE: "enregistré",
  ACCEPTE: "accepté",
  REFUSE: "refusé",
  ATTENTE_INFO: "Avoir Commercial",
  ATTENTE_MO: "Attente MO",
};

const MAGASINS = [
  "Annemasse","Bourgoin-Jallieu","Chasse-sur-Rhone","Chassieu","Gleize","La Motte-Servolex",
  "Les Echets","Pavi","Rives","Saint-Egreve","Saint-Jean-Bonnefonds","Saint-martin-d'heres","Seynod"
];

const MAGASIN_MAILS = {
  "Annemasse": "respmagannemasse@durandservices.fr, magvl5annemasse@durandservices.fr",
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

const FOURNISSEUR_MAILS = {
  "FEBI": "documentsdurand@gmail.com",
  "METELLI": "magvl4gleize@durandservices.fr",
  "EFI": "sophie.pierret@efiautomotive.com",
  "MAGNETI": "adv.france@marelli.com",
  "QH": "commandes@quintonhazell.fr",
  "RIAL": "celine.loridant@pap-sud.fr",
  "AUTOGAMMA": "retours@autogamma.com",
  "DELPHI": "uklea.warranty@delphi.com",
  "MS MOTORS": "Lionel.Doutre@fr.rheinmetall.com",
  "NGK": "ngk-service-technique@ngkntk.fr",
  "NRF": "litiges@nrf.eu",
  "BOSCH FREINAGE": "magvl4gleize@durandservices.fr",
  "CORTECO": "frederic.jannet@corteco.fr",
  "KYB": "s.mainetti@kyb-europe.com",
  "VERNET": "coste@vernet.fr",
  "SEIM": "distribution@akwel-automotive.com",
  "SCHAEFFLER": "magvl4gleize@durandservices.fr",
};

const FOURNISSEUR_PDFS = {
  "FEBI": "FICHE_GARANTIE_FEBI.pdf",
  "METELLI": "formulaire_garantie_metelli.pdf",
  "EFI": "Formulaire_EFI.pdf",
  "MAGNETI": "FORMULAIRE_MAGNETI.pdf",
  "QH": "FORMULAIRE_QH.pdf",
  "RIAL": "DEMANDE_RIAL.pdf",
  "AUTOGAMMA": "Formulaire_ AUTOGAMMA.pdf",
  "DELPHI": "Formulaire_delphi.pdf",
  "MS MOTORS": "FORMULAIRE_ms.pdf",
  "NGK": "Formulaire_ngk.pdf",
  "NRF": "Formulaire_nrf.pdf",
  "SEIM": "Formulaire_SEIM.pdf"
};

const FTP_HOST = process.env.FTP_HOST;
const FTP_PORT = Number(process.env.FTP_PORT || 21);
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;

const FTP_BACKUP_FOLDER = process.env.FTP_BACKUP_FOLDER || "/Disque 1/sauvegardegarantie";
const JSON_FILE_FTP = path.posix.join(FTP_BACKUP_FOLDER, "demandes.json");
const UPLOADS_FTP = path.posix.join(FTP_BACKUP_FOLDER, "uploads");

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

const TEMP_UPLOAD_DIR = path.join(__dirname, "temp_uploads");
try { fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true }); } catch {}
const upload = multer({ dest: TEMP_UPLOAD_DIR });

function assertMailer(res) {
  if (!transporter) {
    res.status(500).json({ success: false, message: "smtp_not_configured" });
    return false;
  }
  return true;
}

async function getFTPClient() {
  const client = new ftp.Client(10000);
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
    return client;
  } catch (err) {
    client.close();
    console.error("[FTP] Erreur de connexion :", err && err.message ? err.message : err);
    throw new Error("Erreur de connexion au serveur FTP");
  }
}

async function readDataFTP() {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour lire demandes.json :", err.message || err);
    return [];
  }

  let json = [];
  try {
    const tmp = path.join(__dirname, "temp_demandes.json");
    await client.downloadTo(tmp, JSON_FILE_FTP);

    try {
      json = JSON.parse(fs.readFileSync(tmp, "utf8"));
    } catch (parseErr) {
      console.error("[FTP] Erreur de parsing de demandes.json :", parseErr.message || parseErr);
      json = [];
    }

    try { fs.unlinkSync(tmp); } catch {}
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.warn("[FTP] FIN inattendu en lecture de demandes.json, retour d'une liste vide.");
    } else {
      console.error("[FTP] Erreur lors de la lecture de demandes.json :", msg);
    }
    json = [];
  } finally {
    if (client) client.close();
  }

  if (Array.isArray(json)) {
    json.forEach(d => {
      if (d && typeof d.statut === "string") {
        if (d.statut.toLowerCase() === "en attente d'info") {
          d.statut = STATUTS.ATTENTE_INFO;
        }
      }
    });
  }

  return json;
}

async function writeDataFTP(data) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour écrire demandes.json :", err.message || err);
    throw new Error("Impossible de se connecter au FTP pour sauvegarder les données.");
  }

  const tmp = path.join(__dirname, "temp_demandes.json");
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    await client.ensureDir(FTP_BACKUP_FOLDER);
    await client.uploadFrom(tmp, JSON_FILE_FTP);
    console.log(`[SAVE] demandes.json mis à jour (${data.length} dossiers)`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.error("[FTP] FIN inattendu pendant l'écriture de demandes.json :", msg);
    } else {
      console.error("[FTP] Erreur lors de l'écriture de demandes.json :", msg);
    }
    throw new Error("Erreur lors de la sauvegarde des données sur le FTP.");
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    if (client) client.close();
  }
}

async function uploadFileToFTP(localPath, remoteSubfolder = "uploads", remoteFileName = null) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour uploader un fichier :", err.message || err);
    throw new Error("Erreur de connexion au FTP pour l'upload de fichier.");
  }

  const remoteName = remoteFileName || path.basename(localPath);
  const remoteDir  = path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder);
  const remotePath = path.posix.join(remoteDir, remoteName);

  try {
    await client.ensureDir(remoteDir);
    await client.uploadFrom(localPath, remotePath);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.error("[FTP] FIN inattendu pendant l'upload :", remotePath, msg);
    } else {
      console.error("[FTP] Erreur upload FTP :", remotePath, msg);
    }
    throw new Error("Erreur lors de l'envoi du fichier sur le FTP.");
  } finally {
    if (client) client.close();
  }
}

async function deleteFilesFromFTP(urls = []) {
  if (!urls.length) return;

  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour supprimer plusieurs fichiers :", err.message || err);
    return;
  }

  try {
    for (const remoteFileName of urls) {
      if (!remoteFileName) continue;
      const remotePath = path.posix.join(UPLOADS_FTP, remoteFileName);
      try {
        await client.remove(remotePath);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg.includes("Server sent FIN packet unexpectedly")) {
          console.warn("[FTP] FIN inattendu lors de la suppression (ignorée) :", remotePath, msg);
        } else {
          console.warn("[FTP] Erreur lors de la suppression du fichier (ignorée) :", remotePath, msg);
        }
      }
    }
  } finally {
    if (client) client.close();
  }
}

async function streamFTPFileToRes(res, remotePath, fileName) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour streamer un fichier :", err.message || err);
    if (!res.headersSent) res.status(500).send("Erreur de connexion au serveur de fichiers.");
    else res.end();
    return;
  }

  try {
    let size = 0;
    try { size = await client.size(remotePath); } catch {}

    const ctype = mime.lookup(fileName) || "application/octet-stream";
    if (!res.headersSent) {
      res.setHeader("Content-Type", ctype);
      if (size > 0) res.setHeader("Content-Length", String(size));

      const ext = (fileName || "").split(".").pop().toLowerCase();
      const inlineTypes = ["pdf","jpg","jpeg","png","gif","webp","bmp"];
      const disp = inlineTypes.includes(ext) ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${disp}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    }

    await client.downloadTo(res, remotePath);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Server sent FIN packet unexpectedly")) {
      console.error("[FTP] FIN inattendu pendant le streaming du fichier :", remotePath, msg);
    } else {
      console.error("[FTP] Erreur pendant le téléchargement du fichier :", remotePath, msg);
    }
    if (!res.headersSent) res.status(500).send("Erreur lors du téléchargement du fichier.");
    else res.end();
  } finally {
    if (client) client.close();
  }
}

async function fetchFilesFromFTP(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];

  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour récupérer les pièces jointes :", err.message || err);
    return [];
  }

  const files = [];
  try {
    for (const f of fileObjs) {
      if (!f || !f.url) continue;
      const remote = path.posix.join(UPLOADS_FTP, f.url);
      const safeLocal = "att_" + f.url.replace(/[^\w.\-]/g,"_");
      const tempPath = path.join(__dirname, safeLocal);

      try {
        await client.downloadTo(tempPath, remote);
        files.push({ filename: f.original, path: tempPath });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg.includes("Server sent FIN packet unexpectedly")) {
          console.warn("[FTP] FIN inattendu pendant le téléchargement d'une PJ (ignorée) :", remote, msg);
        } else {
          console.warn("[FTP] Erreur lors du téléchargement d'une PJ (ignorée) :", remote, msg);
        }
      }
    }
  } finally {
    if (client) client.close();
  }

  return files;
}

function cleanupFiles(arr) {
  if (!arr || !arr.length) return;
  for (const f of arr) {
    if (f && f.path && fs.existsSync(f.path)) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }
}

async function getLogoBuffer() {
  const url = "https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png";
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
}

function formatDateJJMMAAAA(input) {
  if (!input) return "";
  const s = String(input).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    const dt = new Date(s);
    if (isNaN(dt)) return s;
    y = dt.getFullYear(); mo = dt.getMonth() + 1; d = dt.getDate();
  }
  return `${String(d).padStart(2,"0")}/${String(mo).padStart(2,"0")}/${String(y)}`;
}

async function creerPDFDemande(d, _nomFichier) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 32, size: "A4" });
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      const logo = await getLogoBuffer();
      const PAGE_W = doc.page.width;
      const logoW = 55, logoH = 55;
      const x0 = 36; let y0 = 36;

      doc.image(logo, x0, y0, { width: logoW, height: logoH });
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#14548C");
      doc.text("DURAND SERVICES GARANTIE", x0 + logoW + 12, y0 + 6);
      doc.font("Helvetica").fontSize(14).fillColor("#14548C");
      doc.text(d.magasin || "", x0 + logoW + 12, y0 + 32);

      doc.fontSize(11).fillColor("#000");
      const dateStrFr = d.date ? new Date(d.date).toLocaleDateString("fr-FR") : "";
      const numero = d.numero_dossier || "";
      doc.text("Créé le : " + dateStrFr, PAGE_W - 150, y0 + 6, { width: 120 });
      doc.text("Numéro de dossier : " + numero, PAGE_W - 150, y0 + 20, { width: 120 });

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
        ["1ère immatriculation", formatDateJJMMAAAA(d.premiere_immat) || "", "rowline"],
        ["Date de pose", formatDateJJMMAAAA(d.date_pose) || ""],
        ["Date du constat", formatDateJJMMAAAA(d.date_constat) || ""],
        ["Kilométrage à la pose", d.km_pose || ""],
        ["Kilométrage au constat", d.km_constat || ""],
        ["N° BL 1ère Vente", d.bl_pose || ""],
        ["N° BL 2ème Vente", d.bl_constat || "", "rowline"],
        ["Problème rencontré", (d.probleme_rencontre||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n"), "multiline"]
      ];

      const sidePad = 16;
      const cornerRad = 14;
      function cellHeightFor(row) {
        const [ , value, type] = row;
        if (type === "multiline") {
          const h = doc.font(valueFont).fontSize(11).heightOfString(value || "", {
            width: colValW - (sidePad * 2), align: "left"
          });
          const lines = Math.max(1, Math.ceil(h / rowHeight));
          return lines * rowHeight;
        }
        return rowHeight;
      }
      const heights = rows.map(cellHeightFor);
      const tableH = heights.reduce((a,b)=>a+b,0);

      doc.roundedRect(x0, y, tableW, tableH, cornerRad).fillAndStroke("#fff", "#3f628c");
      doc.lineWidth(1.7).roundedRect(x0, y, tableW, tableH, cornerRad).stroke("#3f628c");

      let yCursor = y;
      for (let i = 0; i < rows.length; i++) {
        const [label, value, type] = rows[i];
        const cellHeight = heights[i];

        doc.font(labelFont).fontSize(11).fillColor("#000")
          .text(label, x0 + sidePad, yCursor + 4, { width: colLabelW - sidePad, align: "left" });

        doc.font(valueFont).fontSize(11).fillColor("#000")
          .text(value || "", x0 + colLabelW + sidePad, yCursor + 4, { width: colValW - (sidePad * 2), align: "left" });

        let drawLine = false;
        if (type === "rowline") drawLine = true;
        else if (i < rows.length - 1 && rows[i+1][2] !== "multiline" && type !== "multiline") drawLine = true;
        if (i === rows.length - 1) drawLine = false;
        if (drawLine) {
          doc.moveTo(x0 + 8, yCursor + cellHeight).lineTo(x0 + tableW - 8, yCursor + cellHeight)
            .strokeColor("#b3c5df").lineWidth(1).stroke();
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

    const d = req.body;
    d.id = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
    d.date = new Date().toISOString();

    let maxNum = 0;
    for (const dossier of data) {
      const n = parseInt(dossier.numero_dossier, 10);
      if (!Number.isNaN(n) && n > maxNum) maxNum = n;
    }
    d.numero_dossier = String(maxNum + 1).padStart(4, "0");

    d.statut = STATUTS.ENREGISTRE;
    d.attente_mo = false;

    d.files = [];
    for (const f of req.files || []) {
      const cleanedOriginal = f.originalname.replace(/\s/g, "_");
      const remoteName = `${Date.now()}-${Math.round(Math.random()*1e8)}-${cleanedOriginal}`;
      await uploadFileToFTP(f.path, "uploads", remoteName);
      d.files.push({ url: remoteName, original: f.originalname });
      try { fs.unlinkSync(f.path); } catch {}
    }

    d.reponse = "";
    d.reponseFiles = [];
    d.documentsAjoutes = [];
    data.push(d);
    await writeDataFTP(data);

    const clientNom = (d.nom||"Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    let dateStr = "";
    if (d.date) {
      const dt = new Date(d.date);
      if (!isNaN(dt)) dateStr = dt.toISOString().slice(0,10);
    }
    const nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}.pdf`;
    const pdfBuffer = await creerPDFDemande(d, nomFichier.replace(/\.pdf$/, ""));

    if (d.email) {
      if (!assertMailer(res)) return;
      await transporter.sendMail({
        from: `Garantie <${fromEmail}>`,
        to: d.email,
        subject: "Demande de Garantie Envoyée",
        text: `Votre demande de Garantie a été envoyée avec succès.

Cordialement
L'équipe Durand Services Garantie.
`,
        attachments: [{ filename: nomFichier, content: pdfBuffer, contentType: "application/pdf" }]
      });
    }

    const respMail = MAGASIN_MAILS[d.magasin] || "";
    if (respMail) {
      if (!assertMailer(res)) return;
      const attachments = await fetchFilesFromFTP(d.files);
      await transporter.sendMail({
        from: `Garantie <${fromEmail}>`,
        to: respMail,
        replyTo: d.email || undefined,
        subject: `Nouvelle demande de garantie`,
        html: `<b>Nouvelle demande reçue pour le magasin ${d.magasin}.</b><br>
          Client : ${d.nom} (${d.email})<br>
          Marque du produit : ${d.marque_produit||""}<br>
          Date : ${(new Date()).toLocaleDateString("fr-FR")}<br><br><br>`,
        attachments: attachments.map(f=>({ filename: f.filename, path: f.path }))
      });
      cleanupFiles(attachments);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/demandes :", err.message || err);
    res.json({ success: false, message: err.message });
  }
});

// ... le reste du fichier (admin, export, etc.) reste identique à ta version,
// à part les 3 endroits où mailer.sendMail() a été remplacé par transporter.sendMail().

app.listen(PORT, () => console.log("Serveur OK " + PORT));
