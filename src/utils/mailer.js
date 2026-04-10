const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

/**
 * sendInvitationEmail
 * Sends a registration link to the invited user's email.
 */
async function sendInvitationEmail({ email, token }) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const inviteLink = `${frontendUrl}/auth/accept-invite?token=${token}`;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#0a7b6c;">You've been invited!</h2>
      <p>You have been invited to access the application. Click the button below to set up your account.</p>
      <p>
        <a href="${inviteLink}"
           style="display:inline-block;padding:12px 24px;background:#0a7b6c;color:#fff;
                  text-decoration:none;border-radius:6px;font-weight:bold;">
          Accept Invitation
        </a>
      </p>
      <p style="color:#6b7280;font-size:13px;">
        This link expires in 72 hours.<br/>
        If you did not expect this email, you can safely ignore it.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
      <p style="color:#9ca3af;font-size:12px;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${inviteLink}" style="color:#0a7b6c;">${inviteLink}</a>
      </p>
    </div>
  `;

  await getTransporter().sendMail({
    from,
    to: email,
    subject: 'You have been invited to the application',
    html,
  });
}

/**
 * sendPasswordResetEmail
 * Sends a password reset link to the user's email.
 */
async function sendPasswordResetEmail({ email, token }) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const resetLink = `${frontendUrl}/auth/reset-password?token=${token}`;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#0a7b6c;">Reset Your Password</h2>
      <p>We received a request to reset your password. Click the button below to create a new password.</p>
      <p>
        <a href="${resetLink}"
           style="display:inline-block;padding:12px 24px;background:#0a7b6c;color:#fff;
                  text-decoration:none;border-radius:6px;font-weight:bold;">
          Reset Password
        </a>
      </p>
      <p style="color:#6b7280;font-size:13px;">
        This link expires in 1 hour.<br/>
        If you did not request a password reset, you can safely ignore this email.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
      <p style="color:#9ca3af;font-size:12px;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${resetLink}" style="color:#0a7b6c;">${resetLink}</a>
      </p>
    </div>
  `;

  await getTransporter().sendMail({
    from,
    to: email,
    subject: 'Reset Your Password',
    html,
  });
}

module.exports = { sendInvitationEmail, sendPasswordResetEmail };
