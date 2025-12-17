import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

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
  FROM_NAME,
} = process.env;

function isTruthy(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

let transporter;
let fromEmail;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  const port = SMTP_PORT ? Number(SMTP_PORT) : 587;
  const secure = isTruthy(SMTP_SECURE) || port === 465;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  fromEmail = FROM_EMAIL || SMTP_USER;
} else {
  const user = GMAIL_USER;
  const pass = String(GMAIL_PASS || '').replace(/["\s]/g, '');
  if (user && pass) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
    fromEmail = FROM_EMAIL || user;
  } else {
    transporter = undefined;
    fromEmail = FROM_EMAIL || '';
  }
}

export { transporter, fromEmail };