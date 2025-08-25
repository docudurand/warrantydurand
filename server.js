import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import mime from "mime-types";
import PDFDocument from "pdfkit";
import ftp from "basic-ftp";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const TMP_DIR = path.join(__dirname, "tmp");
const UP_DIR = path.join(TMP_DIR, "uploads");
const OUT_DIR = path.join(TMP_DIR, "out");
for (const p of [TMP_DIR, UP_DIR, OUT_DIR]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UP_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

function slugify(str = "") {
  return String(str)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_\. ]+/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function formatDateJJMMAA(input, sep = " ") {
  if (!input) return "";
  const s = String(input).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let y, mo, d;
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else {
    const dt = new Date(s);
    if (isNaN(dt)) return s;
    y = dt.getFullYear();
    mo = dt.getMonth() + 1;
    d = dt.getDate();
  }
  const dd = String(d).padStart(2, "0");
  const mm = String(mo).padStart(2, "0");
  const yy = String(y).slice(-2);
  return [dd, mm, yy].join(sep);
}

function toYMD(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function renderTableDemande(doc, d, x0, y, tableW) {
  const rightMargin = 36;
  const pageBottom = doc.page.height - 48;
  if (!tableW) tableW = doc.page.width - x0 - rightMargin;

  const colLabelW = Math.min(200, Math.max(160, Math.round(tableW * 0.33)));
  const colValW = tableW - colLabelW;

  const rowHeight = 18;
  const sidePad = 16;
  const cornerRad = 12;

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
    ["1ère immatriculation", formatDateJJMMAA(d.premiere_immat) || "", "rowline"],

    ["Date de pose", formatDateJJMMAA(d.date_pose) || ""],
    ["Date du constat", formatDateJJMMAA(d.date_constat) || ""],
    ["Kilométrage à la pose", d.km_pose || ""],
    ["Kilométrage au constat", d.km_constat || ""],
    ["N° BL 1ère Vente", d.bl_pose || ""],
    ["N° BL 2ème Vente", d.bl_constat || "", "rowline"],

    [
      "Problème rencontré",
      (d.probleme_rencontre || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      "multiline",
    ],
  ];

  function cellHeightFor(row) {
    const [_, value, type] = row;
    if (type === "multiline") {
      const h = doc
        .font(valueFont)
        .fontSize(11)
        .heightOfString(value || "", {
          width: colValW - sidePad * 2,
          align: "left",
        });
      const lines = Math.max(1, Math.ceil(h / rowHeight));
      return lines * rowHeight;
    }
    return rowHeight;
  }

  const heights = rows.map(cellHeightFor);
  const tableH = heights.reduce((a, b) => a + b, 0);

  if (y + tableH > pageBottom) {
    doc.addPage();
    y = 36;
  }

  doc
    .roundedRect(x0, y, tableW, tableH, cornerRad)
    .fillAndStroke("#ffffff", "#3f628c");
  doc
    .lineWidth(1.6)
    .roundedRect(x0, y, tableW, tableH, cornerRad)
    .stroke("#3f628c");

  let yCursor = y;
  for (let i = 0; i < rows.length; i++) {
    const [label, value, type] = rows[i];
    const cellH = heights[i];

    doc
      .font(labelFont)
      .fontSize(11)
      .fillColor("#000000")
      .text(label, x0 + sidePad, yCursor + 4, {
        width: colLabelW - sidePad,
        align: "left",
      });

    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#000000")
      .text(value || "", x0 + colLabelW + sidePad, yCursor + 4, {
        width: colValW - sidePad * 2,
        align: "left",
      });

    let drawLine = false;
    if (type === "rowline") drawLine = true;
    else if (
      i < rows.length - 1 &&
      rows[i + 1][2] !== "multiline" &&
      type !== "multiline"
    )
      drawLine = true;

    if (drawLine && i !== rows.length - 1) {
      doc
        .moveTo(x0 + 8, yCursor + cellH)
        .lineTo(x0 + tableW - 8, yCursor + cellH)
        .strokeColor("#b3c5df")
        .lineWidth(1)
        .stroke();
    }

    yCursor += cellH;
  }

  return yCursor + 12;
}

async function creerPDFDemande(demande) {
  const dateJour = new Date();
  const ymd = toYMD(dateJour);
  const baseName = `${slugify(demande.nom || "CLIENT")}_${ymd}`;
  const outPath = path.join(OUT_DIR, `${baseName}.pdf`);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 36, left: 36, right: 36, bottom: 36 },
  });
  const writeStream = fs.createWriteStream(outPath);
  doc.pipe(writeStream);

  doc
    .image(
      "https://raw.githubusercontent.com/docudurand/warrantydurand/main/DSG.png",
      36,
      24,
      { fit: [80, 80], align: "left" }
    )
    .fillColor("#073763")
    .font("Helvetica-Bold")
    .fontSize(18)
    .text("Demande de Garantie", 130, 40);

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#444")
    .text(`Date: ${formatDateJJMMAA(ymd, "/")}`, 130, 64);

  let x = 36;
  let y = 120;
  let tableW = doc.page.width - 36 - 36;
  y = renderTableDemande(doc, demande, x, y, tableW);

  doc
    .moveTo(36, doc.page.height - 42)
    .lineTo(doc.page.width - 36, doc.page.height - 42)
    .strokeColor("#b3c5df")
    .lineWidth(1)
    .stroke();

  doc
    .fontSize(9)
    .fillColor("#666")
    .text("Durand Services Garantie — Document généré automatiquement", 36, doc.page.height - 36, {
      width: doc.page.width - 72,
      align: "center",
    });

  doc.end();

  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  return { outPath, baseName };
}

function assertSMTP() {
  const required = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "MAIL_FROM",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `SMTP non configuré. Variables manquantes: ${missing.join(", ")}`
    );
  }
}

async function sendConfirmationEmail(to, subject, text, attachments = []) {
  assertSMTP();
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Boolean(process.env.SMTP_SECURE === "true"),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const mailOptions = {
    from: process.env.MAIL_FROM,
    to,
    subject,
    text,
    attachments,
  };

  return transporter.sendMail(mailOptions);
}

async function uploadToFTP(localPath, remoteDir = "/") {
  const { FTP_HOST, FTP_PORT, FTP_USER, FTP_PASS } = process.env;
  if (!FTP_HOST || !FTP_USER || !FTP_PASS) return false;

  const client = new ftp.Client(20000);
  try {
    await client.access({
      host: FTP_HOST,
      port: Number(FTP_PORT || 21),
      user: FTP_USER,
      password: FTP_PASS,
      secure: false,
    });
    await client.ensureDir(remoteDir);
    await client.uploadFrom(localPath, path.join(remoteDir, path.basename(localPath)));
    return true;
  } catch (e) {
    console.error("[FTP] Échec upload:", e.message);
    return false;
  } finally {
    client.close();
  }
}

const JSON_PATH = path.join(TMP_DIR, "demandes.json");

function readAllDemandes() {
  try {
    const raw = fs.readFileSync(JSON_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeAllDemandes(list) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(list, null, 2), "utf-8");
  console.log(
    `[SAVE] Fichier demandes.json mis à jour (${list.length} dossiers)`
  );
}
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/api/demandes", upload.array("document"), async (req, res) => {
  try {
    const d = {
      nom: req.body.nom || "",
      email: req.body.email || "",
      magasin: req.body.magasin || "",

      marque_produit: req.body.marque_produit || "",
      produit_concerne: req.body.produit_concerne || "",
      reference_piece: req.body.reference_piece || "",
      quantite_posee: req.body.quantite_posee || "",

      immatriculation: req.body.immatriculation || "",
      marque_vehicule: req.body.marque_vehicule || "",
      modele_vehicule: req.body.modele_vehicule || "",
      num_serie: req.body.num_serie || "",
      premiere_immat: req.body.premiere_immat || "",

      date_pose: req.body.date_pose || "",
      date_constat: req.body.date_constat || "",
      km_pose: req.body.km_pose || "",
      km_constat: req.body.km_constat || "",
      bl_pose: req.body.bl_pose || "",
      bl_constat: req.body.bl_constat || "",

      probleme_rencontre: req.body.probleme_rencontre || "",
      pieces: (req.files || []).map((f) => ({
        name: f.originalname,
        savedAs: f.filename,
        path: f.path,
        size: f.size,
        mime: f.mimetype,
      })),
      createdAt: new Date().toISOString(),
    };

    const { outPath, baseName } = await creerPDFDemande(d);

    const all = readAllDemandes();
    const dossier = {
      id: `${Date.now()}`,
      nom: d.nom,
      email: d.email,
      magasin: d.magasin,
      createdAt: d.createdAt,
      pdf: path.basename(outPath),
      champs: d,
    };
    all.push(dossier);
    writeAllDemandes(all);

    if (process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASS) {
      await uploadToFTP(outPath, process.env.FTP_DIR || "/");
      await uploadToFTP(JSON_PATH, process.env.FTP_DIR || "/");
    }

    let mailOk = false;
    let mailError = null;
    if (d.email) {
      try {
        const txt =
          "Votre demande de Garantie a été envoyée avec succès.\n\nCordialement\nL'équipe Durand Services Garantie.";
        await sendConfirmationEmail(
          d.email,
          "Confirmation – Demande de Garantie",
          txt,
          [
            {
              filename: `${baseName}.pdf`,
              path: outPath,
              contentType: mime.lookup("pdf") || "application/pdf",
            },
          ]
        );
        mailOk = true;
      } catch (e) {
        mailError = e.message;
        console.error("[MAIL] Échec:", e);
      }
    }

    return res.json({
      success: true,
      message: "Demande enregistrée.",
      pdf: path.basename(outPath),
      email_sent: mailOk,
      email_error: mailError,
    });
  } catch (err) {
    console.error("Erreur /api/demandes:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Erreur interne",
    });
  }
});

app.get("/api/demandes", (req, res) => {
  const all = readAllDemandes();
  res.json({ success: true, data: all });
});

app.get("/api/pdf/:name", (req, res) => {
  const file = path.join(OUT_DIR, req.params.name);
  if (!fs.existsSync(file)) {
    return res.status(404).send("Fichier introuvable");
  }
  res.type("pdf");
  fs.createReadStream(file).pipe(res);
});

app.listen(PORT, () => {
  console.log(`✅ Serveur prêt sur : http://localhost:${PORT}`);
});