import nodemailer from 'nodemailer';
import type { IdentityConfig } from './config.js';
export type VerificationMailer = (email: string, token: string, purpose: 'register' | 'recover') => Promise<void>;
export function createMailer(config: IdentityConfig): VerificationMailer {
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    requireTLS: config.mode === 'production',
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  return async (email, token, purpose) => {
    await transport.sendMail({ from: config.smtp.from, to: { address: email, name: '' },
      subject: purpose === 'recover' ? 'Recover your Larynx account' : 'Verify your Larynx email',
      text: `Your Larynx ${purpose === 'recover' ? 'account recovery' : 'registration'} code:\n\n${token}\n\nPaste this code into the browser where you requested it within 10 minutes. It can be used once. Never share it.\n\n${purpose === 'recover' ? 'Recovery replaces your passkeys and signs out all devices. It does not restore encrypted history or encryption keys.' : 'If you did not request this, ignore this message.'}`,
    });
  };
}
