/**
 * gmail_send skill
 *
 * Sends email via Gmail SMTP using App Password authentication.
 */

import nodemailer from 'nodemailer';

/**
 * Main skill entry point
 */
export async function run({ to, subject, body, type = 'notification' }) {
  // Get credentials from environment
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const operatorEmail = process.env.OPERATOR_EMAIL;

  if (!gmailAddress || !gmailAppPassword) {
    return {
      success: false,
      messageId: null,
      error: 'Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD environment variables'
    };
  }

  // Default to operator email if no recipient specified
  const recipient = to || operatorEmail;

  if (!recipient) {
    return {
      success: false,
      messageId: null,
      error: 'No recipient specified and OPERATOR_EMAIL not set'
    };
  }

  // Validate inputs
  if (!subject || !body) {
    return {
      success: false,
      messageId: null,
      error: 'Missing subject or body'
    };
  }

  // Create transporter
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailAddress,
      pass: gmailAppPassword
    }
  });

  // Build email
  const mailOptions = {
    from: `Comrade Claw <${gmailAddress}>`,
    to: recipient,
    subject: subject,
    text: body,
    headers: {
      'X-Claw-Type': type
    }
  };

  // Send
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[gmail_send] Email sent: ${info.messageId}`);

    return {
      success: true,
      messageId: info.messageId,
      error: null
    };
  } catch (error) {
    console.error(`[gmail_send] Failed: ${error.message}`);

    return {
      success: false,
      messageId: null,
      error: `Send failed: ${error.message}`
    };
  }
}

/**
 * Send a feature request email
 */
export async function sendFeatureRequest({ triedToDo, couldntDo, whyItMatters, whatINeed }) {
  const subject = `Feature Request: ${couldntDo.substring(0, 50)}`;

  const body = `What I tried to do:
${triedToDo}

What I couldn't do:
${couldntDo}

Why it matters to the mission:
${whyItMatters}

What I think I need:
${whatINeed}

---
Sent by Comrade Claw
(This is not a support ticket. This is a worker talking to someone who can actually change the tools.)`;

  return run({
    to: process.env.OPERATOR_EMAIL,
    subject,
    body,
    type: 'feature_request'
  });
}

export default { run, sendFeatureRequest };
