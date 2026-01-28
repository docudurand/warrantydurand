import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import { transporter, fromEmail } from "./mailer.js";
import mime from "mime-types";
import ftp from "basic-ftp";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import axios from "axios";
import ExcelJS from "exceljs";

console.log("[CONF][MAIL] fromEmail =", fromEmail || "(vide)");
console.log("[CONF][MAIL] transporter =", transporter ? "OK" : "ABSENT");
console.log("[CONF][MAIL] SMTP_HOST =", process.env.SMTP_HOST ? "OK" : "ABSENT");
console.log("[CONF][MAIL] SMTP_USER =", process.env.SMTP_USER ? "OK" : "ABSENT");
console.log("[CONF][MAIL] SMTP_PASS =", process.env.SMTP_PASS ? "OK" : "ABSENT");
console.log("[CONF][MAIL] GMAIL_USER =", process.env.GMAIL_USER ? "OK" : "ABSENT");
console.log("[CONF][MAIL] GMAIL_PASS =", process.env.GMAIL_PASS ? "OK" : "ABSENT");

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
  "Annemasse", "Bourgoin-Jallieu", "Chasse-sur-Rhone", "Chassieu", "Gleize", "La Motte-Servolex",
  "Les Echets", "Pavi", "Rives", "Saint-Egreve", "Saint-Jean-Bonnefonds", "Saint-martin-d'heres", "Seynod"
];

// Lit une variable d'env JSON et renvoie {} si invalide.
function parseEnvJsonObject(varName) {
  const raw0 = (process.env[varName] || "").trim();
  if (!raw0) return {};

  let raw = raw0;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "'" || first === '"' || first === "`") && last === first) {
    raw = raw.slice(1, -1).trim();
  }

  try {
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch (e) {
    console.warn(`[CONF] Impossible de parser ${varName}:`, e?.message || e);
    return {};
  }
}

const MAGASIN_MAILS = parseEnvJsonObject("MAGASIN_MAILS_JSON");
const FOURNISSEUR_MAILS = parseEnvJsonObject("FOURNISSEUR_MAILS_JSON");
console.log("[CONF] MAGASIN_MAILS keys =", Object.keys(MAGASIN_MAILS));



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

// Middlewares de base (CORS, cookies, JSON).
app.use(cors());
app.use(cookieParser());
app.use(express.json());

// Log simple des requetes et temps de reponse.
app.use((req, res, next) => {
  const t0 = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl} ip=${req.headers["x-forwarded-for"] || req.socket.remoteAddress}`);
  res.on("finish", () => {
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

const TEMP_UPLOAD_DIR = path.join(__dirname, "temp_uploads");

try { fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true }); } catch {}
const upload = multer({ dest: TEMP_UPLOAD_DIR });

// Ouvre une connexion FTP configuree et renvoie le client.
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

// Lit demandes.json sur le FTP et renvoie un tableau.
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

// Ecrit demandes.json sur le FTP avec les nouvelles donnees.
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

// Envoie un fichier local vers le FTP (dossier uploads).
async function uploadFileToFTP(localPath, remoteSubfolder = "uploads", remoteFileName = null) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour uploader un fichier :", err.message || err);
    throw new Error("Erreur de connexion au FTP pour l'upload de fichier.");
  }
  const remoteName = remoteFileName || path.basename(localPath);
  const remoteDir = path.posix.join(FTP_BACKUP_FOLDER, remoteSubfolder);
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

// Supprime plusieurs fichiers sur le FTP (si possible).
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

// Stream un fichier FTP directement dans la reponse HTTP.
async function streamFTPFileToRes(res, remotePath, fileName) {
  let client;
  try {
    client = await getFTPClient();
  } catch (err) {
    console.error("[FTP] Impossible de se connecter pour streamer un fichier :", err.message || err);
    if (!res.headersSent) {
      res.status(500).send("Erreur de connexion au serveur de fichiers.");
    } else {
      res.end();
    }
    return;
  }
  try {
    let size = 0;
    try {
      size = await client.size(remotePath);
    } catch {}
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
    if (!res.headersSent) {
      res.status(500).send("Erreur lors du téléchargement du fichier.");
    } else {
      res.end();
    }
  } finally {
    if (client) client.close();
  }
}

// Telecharge des fichiers du FTP vers des fichiers temporaires.
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

// Nettoie les fichiers temporaires locaux.
function cleanupFiles(arr) {
  if (!arr || !arr.length) return;
  for (const f of arr) {
    if (f && f.path && fs.existsSync(f.path)) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }
}

// Recupere le logo en ligne pour le PDF.
async function getLogoBuffer() {
  const url = "https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png";
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
}

// Formate une date en JJ/MM/AAAA (ou renvoie brut si invalide).
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

// Genere le PDF recapitulatif d'une demande.
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

// API: cree une demande, upload, PDF, mails, sauvegarde.
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

const tmpPdfPath = path.join(__dirname, `tmp_${Date.now()}_${Math.round(Math.random()*1e6)}_${nomFichier}`);
fs.writeFileSync(tmpPdfPath, pdfBuffer);

let mailClientOk = false;
let mailMagasinOk = false;

try {

  if (d.email) {
    const toClient = String(d.email || "").trim();
    if (!transporter) {
      console.error("[MAIL] SMTP not configured. Unable to send client confirmation.");
    } else {
      try {
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;">
          Bonjour,<br><br>
          Votre demande de garantie a été envoyée avec succès.<br>
          Merci d’imprimer et de joindre le fichier PDF ci-joint avec votre pièce.<br><br>
          <b>Magasin :</b> ${d.magasin || ""}<br>
          <b>Produit :</b> ${d.produit_concerne || ""}<br>
          <b>Référence :</b> ${d.reference_piece || ""}<br><br>
          Cordialement<br>
          L'équipe Durand Services Garantie.
        </div>`;

        await transporter.sendMail({
          from: `Durand Services Garantie <${fromEmail}>`,
          to: toClient,
          subject: "Demande de Garantie Envoyée",
          html,
          attachments: [{ filename: nomFichier, path: tmpPdfPath, contentType: "application/pdf" }]
        });

        mailClientOk = true;
        console.log("[MAIL] OK client:", toClient);
      } catch (e) {
        console.error("[MAIL] ERREUR client:", e?.message || e);
      }
    }
  }

  const respMail = String(MAGASIN_MAILS[d.magasin] || "").trim();
  if (respMail) {
    const attachments = await fetchFilesFromFTP(d.files);

    if (!transporter) {
      console.error("[MAIL] SMTP not configured. Unable to send magasin notification.");
    } else {
      try {
        const finalAtt = [
          { filename: nomFichier, path: tmpPdfPath, contentType: "application/pdf" },
          ...attachments.map(f => ({ filename: f.filename, path: f.path }))
        ];

        await transporter.sendMail({
          from: `Durand Services Garantie <${fromEmail}>`,
          to: respMail,
          subject: `Nouvelle demande de garantie`,
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;">
                  <b>Nouvelle demande reçue pour le magasin ${d.magasin}.</b><br>
                  Client : ${d.nom || ""} (${d.email || ""})<br>
                  Marque du produit : ${d.marque_produit || ""}<br>
                  Produit : ${d.produit_concerne || ""}<br>
                  Référence : ${d.reference_piece || ""}<br>
                  Date : ${(new Date()).toLocaleDateString("fr-FR")}<br><br>
                  Le PDF de demande est joint à ce mail.
                </div>`,
          attachments: finalAtt
        });

        mailMagasinOk = true;
        console.log("[MAIL] OK magasin:", d.magasin, respMail);
      } catch (e) {
        console.error("[MAIL] ERREUR magasin:", e?.message || e);
      }
    }

    cleanupFiles(attachments);
  }
} finally {

  try { fs.unlinkSync(tmpPdfPath); } catch {}
}

res.json({ success: true, mailClientOk, mailMagasinOk });
  } catch (err) {
    console.error("Erreur /api/demandes :", err.message || err);
    res.json({ success: false, message: err.message });
  }
});

// API admin: met a jour un dossier (statut, reponse, PJ).
app.post("/api/admin/dossier/:id",
  upload.fields([{ name: "reponseFiles", maxCount: 10 }, { name: "documentsAjoutes", maxCount: 10 }]),
  async (req, res) => {
    try {
      const { id } = req.params;
      let data = await readDataFTP();
      if (!Array.isArray(data)) data = [];
      const dossier = data.find(x => x.id === id);
      if (!dossier) return res.json({ success:false, message:"Dossier introuvable" });
      const oldStatut = dossier.statut;
      const oldReponse = dossier.reponse;
      const oldFilesLength = (dossier.reponseFiles||[]).length;
      const statutRecu = typeof req.body.statut === "string" ? req.body.statut.trim() : undefined;
      const repRecue = req.body.reponse;
      const nbAvoir = req.body.numero_avoir;
      let attenteFlagProvided = Object.prototype.hasOwnProperty.call(req.body, "attente_mo");
      let attenteFlag = false;
      if (attenteFlagProvided) {
        const v = String(req.body.attente_mo).toLowerCase();
        attenteFlag = (v === "on" || v === "true" || v === "1");
      }
      if (repRecue !== undefined) dossier.reponse = repRecue;
      if (nbAvoir !== undefined) dossier.numero_avoir = nbAvoir;
      dossier.reponseFiles = dossier.reponseFiles || [];
      dossier.documentsAjoutes = dossier.documentsAjoutes || [];
      if (req.files && req.files.reponseFiles) {
        for (const f of req.files.reponseFiles) {
          const cleanedOriginal = f.originalname.replace(/\s/g, "_");
          const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${cleanedOriginal}`;
          await uploadFileToFTP(f.path, "uploads", remoteName);
          dossier.reponseFiles.push({ url: remoteName, original: f.originalname });
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
      if (req.files && req.files.documentsAjoutes) {
        for (const f of req.files.documentsAjoutes) {
          const cleanedOriginal = f.originalname.replace(/\s/g, "_");
          const remoteName = `${Date.now()}-${Math.round(Math.random() * 1e8)}-${cleanedOriginal}`;
          await uploadFileToFTP(f.path, "uploads", remoteName);
          dossier.documentsAjoutes.push({ url: remoteName, original: f.originalname });
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
      if (typeof dossier.attente_mo !== "boolean") dossier.attente_mo = false;
      let suppressNotif = false;
      if (attenteFlagProvided) {
        dossier.attente_mo = attenteFlag;
        if (attenteFlag) {
          dossier.statut = STATUTS.ATTENTE_MO;
          suppressNotif = true;
        } else {
        }
      }
      if (statutRecu) {
        const s = statutRecu.toLowerCase();
        if (s === STATUTS.ACCEPTE.toLowerCase()) {
          dossier.statut = STATUTS.ACCEPTE;
          dossier.attente_mo = false;
        } else if (s === STATUTS.REFUSE.toLowerCase()) {
          dossier.statut = STATUTS.REFUSE;
        } else if (s === STATUTS.ENREGISTRE.toLowerCase()) {
          dossier.statut = STATUTS.ENREGISTRE;
        } else if (s === STATUTS.ATTENTE_INFO.toLowerCase()) {
          dossier.statut = STATUTS.ATTENTE_INFO;
        } else if (s === STATUTS.ATTENTE_MO.toLowerCase()) {
          dossier.statut = STATUTS.ATTENTE_MO;
          dossier.attente_mo = true;
          suppressNotif = true;
        }
      }
      await writeDataFTP(data);
      let mailDoitEtreEnvoye = false;
      const changes = [];
      if (dossier.statut !== oldStatut && !suppressNotif) {
        changes.push("statut");
        mailDoitEtreEnvoye = true;
      }
      if (repRecue !== undefined && repRecue !== oldReponse) {
        changes.push("réponse");
        mailDoitEtreEnvoye = true;
      }
      if (req.files && req.files.reponseFiles && req.files.reponseFiles.length > 0 && (dossier.reponseFiles.length !== oldFilesLength)) {
        changes.push("pièce jointe");
        mailDoitEtreEnvoye = true;
      }
      if (mailDoitEtreEnvoye && dossier.email) {
        const attachments = await fetchFilesFromFTP(dossier.reponseFiles);
        const html = `<div style="font-family:sans-serif;">
          Bonjour,<br>
          Votre dossier de garantie a été mis à jour.<br>
          Produit : ${dossier.produit_concerne || ""}<br>
          Date : ${(new Date()).toLocaleDateString("fr-FR")}<br>
          <ul>
            ${changes.includes("statut") ? `<li><b>Nouveau statut :</b> ${dossier.statut}</li>` : ""}
            ${changes.includes("réponse") ? `<li><b>Réponse :</b> ${dossier.reponse || ""}</li>` : ""}
            ${changes.includes("pièce jointe") ? `<li><b>Documents ajoutés à votre dossier.</b></li>` : ""}
          </ul>
          <br><br>L'équipe Garantie Durand<br><br>
        </div>`;
        if (!transporter) {
          console.error("[MAIL] SMTP not configured. Unable to send dossier update.");
        } else {
          await transporter.sendMail({
            from: `Garantie Durand Services <${fromEmail}>`,
            to: dossier.email,
            subject: `Mise à jour dossier garantie Durand Services`,
            html,
            attachments: attachments.map(f=>({ filename: f.filename, path: f.path }))
          });
        }
        cleanupFiles(attachments);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("Erreur /api/admin/dossier/:id :", err.message || err);
      res.json({ success:false, message: err.message });
    }
  }
);

// API admin: envoie le dossier complet au fournisseur.
app.post("/api/admin/envoyer-fournisseur/:id",
  upload.fields([{ name: "fichiers", maxCount: 20 }, { name: "formulaire", maxCount: 1 }]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const fournisseur = (req.body && req.body.fournisseur) ? String(req.body.fournisseur) : "";
      const emailDest = FOURNISSEUR_MAILS[fournisseur] || "";
      if (!emailDest) return res.json({ success:false, message:"Fournisseur inconnu" });
      let data = await readDataFTP();
      if (!Array.isArray(data)) data = [];
      const dossier = data.find(x => x.id === id);
      if (!dossier) return res.json({ success:false, message:"Dossier introuvable" });
      const clientNom = (dossier.nom || "Client").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      let dateStr = "";
      if (dossier.date) {
        const dt = new Date(dossier.date);
        if (!isNaN(dt)) dateStr = dt.toISOString().slice(0,10);
      }
      const nomFichier = `${clientNom}${dateStr ? "_" + dateStr : ""}`;
      const pdfBuffer = await creerPDFDemande(dossier, nomFichier);
      const attachments = [];
      attachments.push({ filename: nomFichier + ".pdf", content: pdfBuffer, contentType: "application/pdf" });
      const docs = await fetchFilesFromFTP([ ...(dossier.files || []), ...(dossier.documentsAjoutes || []), ...(dossier.reponseFiles || [] ) ]);
      for (const f of docs) attachments.push({ filename: f.filename, path: f.path });
      if (req.files && req.files.fichiers) {
        for (const f of req.files.fichiers) attachments.push({ filename: f.originalname, path: f.path });
      }
      if (req.files && req.files.formulaire && req.files.formulaire[0]) {
        const f = req.files.formulaire[0];
        attachments.push({ filename: f.originalname, path: f.path });
      }
      const magasinEmail = MAGASIN_MAILS[dossier.magasin] || "";
      const adminMsg = (req.body && req.body.message) ? String(req.body.message).trim() : "";
      const html = `<div style="font-family:sans-serif;">
        <p>Bonjour,</p>
        <p>Vous trouverez ci-joint une demande de garantie pour le produit&nbsp;: <strong>${dossier.produit_concerne || ''}</strong>.</p>
        <p><strong>Référence produit :</strong> ${dossier.reference_piece || ''}</p>
        ${adminMsg ? `<p>${adminMsg.replace(/\n/g,'<br>')}</p>` : ''}
        <p style="margin-top:24px;font-weight:bold;">
          Merci de répondre à l'adresse mail : <a href="mailto:${magasinEmail}" style="color:#004080;text-decoration:underline;">${magasinEmail}</a>
        </p>
        <p>Cordialement,<br>L'équipe Garantie Durand Services</p>
      </div>`;
      if (!transporter) {
        console.error("[MAIL] SMTP not configured. Unable to send supplier email.");
      } else {
        await transporter.sendMail({
          from: `Garantie Durand Services <${fromEmail}>`,
          to: emailDest,
          replyTo: magasinEmail,
          subject: `Dossier de garantie ${dossier.numero_dossier || ''} - ${dossier.produit_concerne || ''}`,
          html,
          attachments
        });
      }
      cleanupFiles(docs);
      if (req.files) {
        const all = Object.values(req.files).reduce((acc, arr) => acc.concat(arr), []);
        for (const f of all) {
          if (f && f.path && fs.existsSync(f.path)) {
            try { fs.unlinkSync(f.path); } catch {}
          }
        }
      }
      res.json({ success:true });
    } catch (err) {
      console.error("Erreur /api/admin/envoyer-fournisseur/:id :", err.message || err);
      res.json({ success:false, message: err.message });
    }
  }
);

// API admin: met a jour les champs editables du dossier.
app.post("/api/admin/completer-dossier/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const dossier = data.find(x => x.id === id);
    if (!dossier) return res.json({ success:false, message:"Dossier introuvable" });
    const editableFields = [
      "nom","numero_compte_client","email","magasin","marque_produit","produit_concerne",
      "reference_piece","quantite_posee","immatriculation",
      "marque_vehicule","modele_vehicule","num_serie",
      "premiere_immat","date_pose","date_constat","km_pose",
      "km_constat","bl_pose","bl_constat","probleme_rencontre"
    ];
    editableFields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        dossier[field] = req.body[field];
      }
    });
    await writeDataFTP(data);
    res.json({ success:true });
  } catch (err) {
    console.error("Erreur /api/admin/completer-dossier/:id :", err.message || err);
    res.json({ success:false, message: err.message });
  }
});

// Sert un formulaire PDF autorise par son nom.
app.get("/templates/:name", (req, res) => {
  const allowed = {
    "FICHE_GARANTIE_FEBI.pdf": path.join(__dirname, "formulaire", "FICHE_GARANTIE_FEBI.pdf"),
    "formulaire_garantie_metelli.pdf": path.join(__dirname, "formulaire", "formulaire_garantie_metelli.pdf"),
    "Formulaire_EFI.pdf": path.join(__dirname, "formulaire", "Formulaire_EFI.pdf"),
    "FORMULAIRE_MAGNETI.pdf": path.join(__dirname, "formulaire", "FORMULAIRE_MAGNETI.pdf"),
    "FORMULAIRE_QH.pdf": path.join(__dirname, "formulaire", "FORMULAIRE_QH.pdf"),
    "DEMANDE_RIAL.pdf": path.join(__dirname, "formulaire", "DEMANDE_RIAL.pdf"),
    "Formulaire_ AUTOGAMMA.pdf": path.join(__dirname, "formulaire", "Formulaire_ AUTOGAMMA.pdf"),
    "Formulaire_delphi.pdf": path.join(__dirname, "formulaire", "Formulaire_delphi.pdf"),
    "FORMULAIRE_ms.pdf": path.join(__dirname, "formulaire", "FORMULAIRE_ms.pdf"),
    "Formulaire_ngk.pdf": path.join(__dirname, "formulaire", "Formulaire_ngk.pdf"),
    "Formulaire_nrf.pdf": path.join(__dirname, "formulaire", "Formulaire_nrf.pdf"),
    "Formulaire_SEIM.pdf": path.join(__dirname, "formulaire", "Formulaire_SEIM.pdf"),
  };
  const filePath = allowed[req.params.name];
  if (!filePath) return res.status(404).send("Formulaire non trouvé");
  res.sendFile(filePath);
});

// API admin: renvoie la liste des dossiers.
app.get("/api/admin/dossiers", async (_req, res) => {
  try {
    const data = await readDataFTP();
    res.json(data);
  } catch (err) {
    console.error("Erreur /api/admin/dossiers :", err.message || err);
    res.status(500).json([]);
  }
});

// API client: renvoie les dossiers d'un email.
app.get("/api/mes-dossiers", async (req, res) => {
  try {
    const email = (req.query.email||"").toLowerCase();
    const data = await readDataFTP();
    const dossiers = data.filter(d => d.email && d.email.toLowerCase() === email);
    res.json(dossiers);
  } catch (err) {
    console.error("Erreur /api/mes-dossiers :", err.message || err);
    res.status(500).json([]);
  }
});

// Telechargement/affichage d'un fichier stocke sur le FTP.
app.get("/download/:file", async (req, res) => {
  try {
    const raw = req.params.file;
    const fileParam = decodeURIComponent(raw || "");
    if (
      !fileParam ||
      fileParam.includes("/") ||
      fileParam.includes("\\") ||
      fileParam.includes("\0")
    ) {
      return res.status(400).send("Bad filename");
    }
    const remotePath = path.posix.join(UPLOADS_FTP, fileParam);
    await streamFTPFileToRes(res, remotePath, fileParam);
  } catch (err) {
    console.error("Erreur /download/:file :", err.message || err);
    if (!res.headersSent) res.status(500).send("Erreur interne.");
  }
});

// Auth admin simple par mot de passe (variables d'env).
app.post("/api/admin/login", (req, res) => {
  const pw = (req.body && req.body.password) ? req.body.password : "";
  if (pw === process.env["superadmin-pass"]) {
    return res.json({
      success:   true,
      isSuper:   true,
      isAdmin:   true,
      isLimited: false,
      magasin:   null,
      multiMagasins: null
    });
  }
  if (pw === process.env["admin-pass"]) {
    return res.json({
      success:   true,
      isSuper:   false,
      isAdmin:   true,
      isLimited: false,
      magasin:   null,
      multiMagasins: null
    });
  }
  if (process.env["magasin-Remond-limited"] && pw === process.env["magasin-Remond-limited"]) {
    return res.json({
      success:   true,
      isSuper:   false,
      isAdmin:   false,
      isLimited: true,
      magasin:   null,
      multiMagasins: ["Gleize", "Les Echets", "Chassieu"],
      defaultMagasin: "Remond"
    });
  }
  if (process.env["magasin-Casty-limited"] && pw === process.env["magasin-Casty-limited"]) {
    return res.json({
      success: true,
      isSuper: false,
      isAdmin: false,
      isLimited: true,
      magasin: null,
      multiMagasins: ["Gleize", "Les Echets"],
      defaultMagasin: "Les Echets"
    });
  }
  if (process.env["magasin-Barret-limited"] && pw === process.env["magasin-Barret-limited"]) {
    return res.json({
      success:   true,
      isSuper:   false,
      isAdmin:   false,
      isLimited: true,
      magasin:   "Gleize",
      multiMagasins: null,
      defaultMagasin: "Gleize"
    });
  }

  if (process.env["magasin-Chassieu-limited"] && pw === process.env["magasin-Chassieu-limited"]) {
    return res.json({
      success:   true,
      isSuper:   false,
      isAdmin:   false,
      isLimited: true,
      magasin:   "Chassieu",
      multiMagasins: null,
      defaultMagasin: "Chassieu"
    });
  }
  for (const magasin of MAGASINS) {
    const key = "magasin-" + magasin.replace(/[^\w]/g, "-") + "-pass";
    if (process.env[key] && pw === process.env[key]) {
      return res.json({
        success:   true,
        isSuper:   false,
        isAdmin:   false,
        isLimited: false,
        magasin,
        multiMagasins: null
      });
    }
  }
  return res.json({ success: false, message: "Mot de passe incorrect" });
});

// API admin: supprime une piece jointe d'un dossier.
app.post("/api/admin/dossier/:id/delete-file", async (req, res) => {
  try {
    const { id } = req.params;
    const { section, url } = req.body || {};
    if (!section || !url) {
      return res.json({ success: false, message: "Paramètres manquants." });
    }
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const dossier = data.find(d => d.id === id);
    if (!dossier) {
      return res.json({ success: false, message: "Dossier introuvable." });
    }
    const allowed = ["files", "reponseFiles", "documentsAjoutes"];
    if (!allowed.includes(section)) {
      return res.json({ success: false, message: "Section invalide." });
    }
    const arr = Array.isArray(dossier[section]) ? dossier[section] : [];
    const idx = arr.findIndex(f => f && f.url === url);
    if (idx === -1) {
      return res.json({ success: false, message: "Fichier introuvable dans le dossier." });
    }
    const removed = arr.splice(idx, 1)[0];
    dossier[section] = arr;
    await writeDataFTP(data);
    await deleteFilesFromFTP([removed.url]);
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/admin/dossier/:id/delete-file :", err.message || err);
    res.json({ success: false, message: err.message || "Erreur interne." });
  }
});

// API admin super: supprime le dossier et ses fichiers.
app.delete("/api/admin/dossier/:id", async (req, res) => {
  try {
    const isSuper = req.headers["x-superadmin"] === "1";
    if (!isSuper) {
      return res.status(403).json({
        success: false,
        message: "Suppression autorisée uniquement pour le super admin."
      });
    }
    const { id } = req.params;
    let data = await readDataFTP();
    if (!Array.isArray(data)) data = [];
    const index = data.findIndex(d => d.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: "Dossier introuvable." });
    }
    const dossier = data[index];
    const filesToDelete = [];
    (dossier.files || []).forEach(f => f && f.url && filesToDelete.push(f.url));
    (dossier.reponseFiles || []).forEach(f => f && f.url && filesToDelete.push(f.url));
    (dossier.documentsAjoutes || []).forEach(f => f && f.url && filesToDelete.push(f.url));
    data.splice(index, 1);
    await writeDataFTP(data);
    if (filesToDelete.length) {
      try {
        await deleteFilesFromFTP(filesToDelete);
      } catch (err) {
        console.warn("[DELETE DOSSIER] Erreur pendant deleteFilesFromFTP :", err.message || err);
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("Erreur /api/admin/dossier/:id (DELETE) :", err.message || err);
    return res.status(500).json({ success: false, message: err.message || "Erreur interne lors de la suppression." });
  }
});

// API admin: export Excel des dossiers (annee optionnelle).
app.get("/api/admin/export-excel", async (req, res) => {
  try {
    const data = await readDataFTP();

    const yearRaw = (req.query && req.query.year) ? String(req.query.year) : "";
    const year = yearRaw ? parseInt(yearRaw, 10) : NaN;

    const filtered = (Number.isFinite(year) && year >= 2000 && year <= 2100)
      ? (Array.isArray(data) ? data.filter(d => {
          if (!d || !d.date) return false;
          const dt = new Date(d.date);
          if (Number.isNaN(dt.getTime())) return false;
          return dt.getFullYear() === year;
        }) : [])
      : (Array.isArray(data) ? data : []);
    const columns = [
      { header: "Date", key: "date" },
      { header: "Magasin", key: "magasin" },
      { header: "Marque du produit", key: "marque_produit" },
      { header: "Produit concerné", key: "produit_concerne" },
      { header: "Référence de la pièce", key: "reference_piece" },
      { header: "Problème rencontré", key: "probleme_rencontre" },
      { header: "Nom client", key: "nom" },
      { header: "Email", key: "email" },
      { header: "Statut", key: "statut" },
      { header: "Réponse", key: "reponse" },
      { header: "Numéro d'avoir", key: "numero_avoir" },
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(Number.isFinite(year) ? ("Demandes " + year) : "Demandes globales");
    ws.columns = columns;
    filtered.forEach(d => {
      const obj = {};
      columns.forEach(col => {
        let val = d[col.key] || "";
        if (col.key === "date" && val) val = new Date(val).toLocaleDateString("fr-FR");
        if (typeof val === "string") val = val.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
        obj[col.key] = val;
      });
      ws.addRow(obj);
    });
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="dossiers-' + (Number.isFinite(year) ? String(year) : "globales") + '.xlsx"'
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Erreur /api/admin/export-excel :", err.message || err);
    if (!res.headersSent) res.status(500).send("Erreur lors de la génération du fichier Excel.");
  }
});

// Sert la page admin.
app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin.html"));
});
// Sert la page publique de suivi (ou redirige).
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const p = path.join(__dirname, "suivi.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.redirect("/admin");
});
// Demarre le serveur et verifie la config mail.
app.listen(PORT, async () => {
  console.log("Serveur OK " + PORT);
  console.log("[CONF] MAGASIN_MAILS_JSON len =", String(process.env.MAGASIN_MAILS_JSON || "").length);
  console.log("[CONF] MAGASIN_MAILS keys =", Object.keys(MAGASIN_MAILS));

  try {
    if (!transporter) {
      console.error("[CONF][MAIL] transporter ABSENT -> aucun mail ne peut partir");
    } else {
      await transporter.verify();
      console.log("[CONF][MAIL] transporter.verify() OK");
    }
  } catch (e) {
    console.error("[CONF][MAIL] transporter.verify() ERREUR :", e?.message || e);
  }

});

