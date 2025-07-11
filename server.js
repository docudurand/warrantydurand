import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import mime from "mime-types";

const __dirname = path.resolve();
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./demandes.json";
const UPLOADS_DIR = "./uploads";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "superadmin2024"; // Change-le sur Render !

// Config
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public")); // Pour servir les formulaires statiques
app.use('/uploads', express.static(UPLOADS_DIR));

// Init stockage JSON
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer pour fichiers joints
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random()*1E9);
    cb(null, unique + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});
const upload = multer({ storage });

// Magasins (adapter ici si tu veux rajouter/supprimer)
const MAGASINS = [
  "Annemasse", "Bourgoin-Jallieu", "Chasse-sur-Rhone", "Chassieu",
  "Gleize", "La Motte-Servolex", "Les Echets", "Rives",
  "Saint-Egreve", "Saint-Jean-Bonnefonds", "Saint-martin-d'heres", "Seynod"
];

// Helper
function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// API : Enregistrement d'une nouvelle demande
app.post("/api/demandes", upload.array("document"), (req, res) => {
  try {
    const fields = req.body;
    const files = (req.files || []).map(f => ({
      url: f.filename,
      original: f.originalname,
      type: f.mimetype,
      size: f.size
    }));
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
    const date = new Date().toISOString();
    const dossier = {
      id,
      date,
      statut: "enregistré",
      ...fields,
      quantite_posee: fields.quantite_posee || "",
      km_pose: fields.km_pose || "",
      km_constat: fields.km_constat || "",
      files,
      reponse: "",
      reponseFiles: [],
    };

    const data = readData();
    data.push(dossier);
    writeData(data);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API : Suivi client (filtre par email)
app.get("/api/mes-dossiers", (req, res) => {
  const email = (req.query.email||"").toLowerCase();
  if (!email) return res.json([]);
  const data = readData();
  const result = data.filter(d => (d.email||"").toLowerCase() === email);
  res.json(result.reverse());
});

// Téléchargement des pièces jointes
app.get("/download/:filename", (req, res) => {
  const file = req.params.filename;
  const filepath = path.join(UPLOADS_DIR, file);
  if (fs.existsSync(filepath)) {
    res.type(mime.lookup(filepath) || "application/octet-stream");
    res.download(filepath);
  } else {
    res.status(404).send("Fichier non trouvé");
  }
});

// Auth admin simple (cookie, à améliorer si besoin)
app.post("/api/admin/login", express.json(), (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie("admin", "1", { httpOnly: true, sameSite: "Lax" });
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "Mot de passe incorrect" });
  }
});
function adminAuth(req, res, next) {
  if (req.cookies.admin === "1") return next();
  res.status(401).json({ error: "Non autorisé" });
}

// API : Données admin (tous les dossiers)
app.get("/api/admin/dossiers", adminAuth, (req, res) => {
  const data = readData();
  res.json(data.reverse());
});

// Changer le statut ou la réponse d'un dossier (admin)
app.post("/api/admin/dossier/:id", adminAuth, upload.array("reponseFiles"), (req, res) => {
  try {
    const id = req.params.id;
    const { statut, reponse } = req.body;
    const data = readData();
    const idx = data.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: "Dossier introuvable" });
    if (statut) data[idx].statut = statut;
    if (reponse !== undefined) data[idx].reponse = reponse;
    // Fichiers de réponse (upload)
    if (req.files && req.files.length) {
      data[idx].reponseFiles = (data[idx].reponseFiles || []);
      req.files.forEach(f => {
        data[idx].reponseFiles.push({
          url: f.filename,
          original: f.originalname,
          type: f.mimetype,
          size: f.size
        });
      });
    }
    writeData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Pour l'admin : page HTML
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log("Serveur en ligne sur port", PORT);
});
