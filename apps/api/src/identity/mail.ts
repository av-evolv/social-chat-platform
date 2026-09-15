import { translate, type Locale } from '@larynx/i18n';
import nodemailer from 'nodemailer';
import type { IdentityConfig } from './config.js';
export type VerificationMailer = (email: string, token: string, purpose: 'register' | 'recover', locale?: Locale) => Promise<void>;
export function verificationMessage(locale: Locale, token: string, purpose: 'register' | 'recover') {
  const t = (key: string) => translate(locale,`server.mail.${key}`);
  return {subject:t(purpose === 'recover' ? 'recoverSubject' : 'registerSubject'),
    text:`${t(purpose === 'recover' ? 'recoverIntro' : 'registerIntro')}\n\n${token}\n\n${t('verificationInstructions')}\n\n${t(purpose === 'recover' ? 'recoveryWarning' : 'ignore')}`};
}
export function createMailer(config: IdentityConfig): VerificationMailer {
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    requireTLS: config.mode === 'production',
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  return async (email, token, purpose, locale = 'en') => {
    await transport.sendMail({ from: config.smtp.from, to: { address: email, name: '' }, ...verificationMessage(locale,token,purpose) });
  };
}
