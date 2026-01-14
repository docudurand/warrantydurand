import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  GMAIL_USER,
  GMAIL_PASS,
  FROM_EMAIL,
} = process.env;

function isTruthy(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function cleanEnv(v) {
  if (v === undefined || v === null) return "";
  let s = String(v).trim();

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith("`") && s.endsWith("`"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

let transporter;
let fromEmail;

const smtpHost = cleanEnv(SMTP_HOST);
const smtpUser = cleanEnv(SMTP_USER);
const smtpPass = cleanEnv(SMTP_PASS);

if (smtpHost && smtpUser && smtpPass) {
  const port = SMTP_PORT ? Number(cleanEnv(SMTP_PORT)) : 587;
  const secure = isTruthy(SMTP_SECURE) || port === 465;

  transporter = nodemailer.createTransport({
    host: smtpHost,
    port,
    secure,
    auth: { user: smtpUser, pass: smtpPass },

    tls: { rejectUnauthorized: false },
  });

  fromEmail = cleanEnv(FROM_EMAIL) || smtpUser;
} else {

  const user = cleanEnv(GMAIL_USER);
  const pass = cleanEnv(GMAIL_PASS).replace(/["\s]/g, "");

  if (user && pass) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
    fromEmail = cleanEnv(FROM_EMAIL) || user;
  } else {
    transporter = undefined;
    fromEmail = cleanEnv(FROM_EMAIL) || "";
  }
}

export { transporter, fromEmail };
