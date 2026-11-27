import nodemailer from "nodemailer";
import type { EmailProvider } from "../notifications/email-port.js";

/** How the connection is protected. `starttls` never falls back to plain text. */
export type SmtpSecurity = "starttls" | "tls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  from: string;
  auth?: { user: string; pass: string };
}

/**
 * Reads the mail server from the environment; null when none is set.
 *
 * LEGALLABS_SMTP_HOST      the server; setting it turns mail on
 * LEGALLABS_MAIL_FROM      sender address, required with a host
 * LEGALLABS_SMTP_SECURITY  starttls (default), tls, or none (never in production)
 * LEGALLABS_SMTP_PORT      587, or 465 for tls
 * LEGALLABS_SMTP_USER, LEGALLABS_SMTP_PASSWORD  when the server asks for a login
 *
 * A half-set or unsafe configuration throws, so a typo cannot quietly leave mail off.
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const host = env.LEGALLABS_SMTP_HOST;
  const from = env.LEGALLABS_MAIL_FROM;
  const user = env.LEGALLABS_SMTP_USER;
  const pass = env.LEGALLABS_SMTP_PASSWORD;
  const security = env.LEGALLABS_SMTP_SECURITY || "starttls";
  if (!host) {
    if (from || user || pass || env.LEGALLABS_SMTP_PORT || env.LEGALLABS_SMTP_SECURITY) {
      throw new Error("mail settings are set without LEGALLABS_SMTP_HOST");
    }
    return null;
  }
  if (!from) throw new Error("LEGALLABS_MAIL_FROM is required with LEGALLABS_SMTP_HOST");
  if (security !== "starttls" && security !== "tls" && security !== "none") {
    throw new Error("LEGALLABS_SMTP_SECURITY must be starttls, tls or none");
  }
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error("set LEGALLABS_SMTP_USER and LEGALLABS_SMTP_PASSWORD together");
  }
  if (security === "none" && (user || env.NODE_ENV === "production")) {
    throw new Error(
      "LEGALLABS_SMTP_SECURITY=none sends sign-in codes in the clear: " +
        "it is refused in production and with a password",
    );
  }
  const port = Number(env.LEGALLABS_SMTP_PORT || (security === "tls" ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LEGALLABS_SMTP_PORT must be a port number");
  }
  return { host, port, security, from, ...(user && pass ? { auth: { user, pass } } : {}) };
}

export interface SmtpProvider extends EmailProvider {
  /** Connects and logs in without sending, to find a bad setting at start-up. */
  verify(): Promise<void>;
}

/**
 * A mail server's error text can quote the address and the message, so only its short code
 * leaves this file.
 */
function plainError(err: unknown): Error {
  const code = (err as { code?: unknown }).code;
  const error = new Error("the mail server did not accept the message");
  error.name = typeof code === "string" && /^[A-Z]{1,32}$/.test(code) ? code : "SmtpError";
  return error;
}

export function createSmtpEmailProvider(config: SmtpConfig): SmtpProvider {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    ...(config.auth ? { auth: config.auth } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: config.from,
          // As an object, so a name can never add a recipient.
          to: { name: message.to.name, address: message.to.email },
          subject: message.subject,
          text: message.text,
          ...(message.replyTo ? { replyTo: { name: "", address: message.replyTo } } : {}),
          ...(message.messageId ? { messageId: message.messageId } : {}),
          ...(message.auto ? { headers: { "Auto-Submitted": "auto-replied" } } : {}),
        });
      } catch (err) {
        throw plainError(err);
      }
    },
    async verify() {
      try {
        await transport.verify();
      } catch (err) {
        throw plainError(err);
      }
    },
  };
}
