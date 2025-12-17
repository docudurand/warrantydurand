import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

// Load environment variables from .env file.  If dotenv has already been called
// elsewhere, this call will have no effect.
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

/**
 * Helper to coerce stringy env values into booleans.  Accepts "true", "1",
 * or "yes" (case-insensitive) as truthy values.  Anything else (including
 * undefined) is false.
 *
 * @param {string|undefined} v The environment value
 * @returns {boolean}
 */
function isTruthy(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

// Exported transporter and fromEmail.  These are lazily initialised based on
// the presence of SMTP_* variables.  If no SMTP variables are present, the
// module falls back to using Gmail credentials, but only if both GMAIL_USER
// and GMAIL_PASS are defined.  Otherwise the transporter remains undefined
// and callers must handle the error.
let transporter;
let fromEmail;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  // Configure a custom SMTP transporter (e.g. Mailjet).
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
  // Fallback to Gmail if SMTP is not configured.  Quotes and spaces in the
  // app password are stripped to avoid auth errors.
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