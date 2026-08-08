const nodemailer = require('nodemailer');

// Configure SMTP transport (e.g., using Brevo or Resend)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp-relay.brevo.com',
  port: process.env.EMAIL_PORT || 587,
  auth: {
    user: process.env.EMAIL_USER, // Your SMTP login/username
    pass: process.env.EMAIL_PASS  // Your SMTP password/API key
  }
});

// Helper function to send carbon threshold warning email
const sendCarbonAlert = async (toEmail, username, currentCO2, budgetCap) => {
  const mailOptions = {
    from: '"EcoCredit Hub" <no-reply@ecocredit-hub.com>',
    to: toEmail,
    subject: '⚠️ High Carbon Emission Alert — EcoCredit Hub',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #0f172a; color: #f8fafc;">
        <h2 style="color: #ef4444;">Carbon Budget Alert for ${username}</h2>
        <p>Your logged carbon emissions have reached <strong>${currentCO2} kg CO₂</strong>.</p>
        <p>This exceeds 80% of your monthly threshold limit of <strong>${budgetCap} kg CO₂</strong>.</p>
        <p>Please log in to your EcoCredit Hub dashboard to review your reduction targets.</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✉️ Carbon alert email sent successfully to ${toEmail}`);
  } catch (error) {
    console.error('❌ Failed to send email alert:', error.message);
  }
};

module.exports = { sendCarbonAlert };