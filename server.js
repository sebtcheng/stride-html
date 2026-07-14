const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'STRIDE_INSIGHTED_SECRET_2026_KEY_PROD';

// Database Pool Configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('azure.com')
    ? { rejectUnauthorized: false }
    : false
});

app.use(cors());
app.use(express.json());

// Initialize Database Tables and Columns
async function initDatabase() {
  try {
    // 0. No-op (legacy cleanup — safe to ignore)
    await pool.query(`
      SELECT 1 -- removed brute-force columns (not in STRIDE users table)
    `);

    // 1. Create OTPs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp_code VARCHAR(10) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Create Guests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        organization VARCHAR(255) NOT NULL,
        purpose TEXT NOT NULL,
        region VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Migration: add region column if the table was already created without it
    await pool.query('ALTER TABLE guests ADD COLUMN IF NOT EXISTS region VARCHAR(255)');
    // Migration: ensure unique index exists on email (required for ON CONFLICT)
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS guests_email_unique_idx ON guests(email)');
    console.log('Database initialized successfully.');
  } catch (error) {
    console.error('Failed to initialize database tables/columns:', error.message);
  }
}

// Gmail transporter (uses credentials from .env)
// NOTE: EMAIL_PASS must be a Gmail App Password (not your regular Gmail password).
// Generate one at: https://myaccount.google.com/apppasswords
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // SSL
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Verify Gmail transporter on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Gmail transporter FAILED:', error.message);
    console.error('   EMAIL_USER set?', !!process.env.EMAIL_USER);
    console.error('   EMAIL_PASS set?', !!process.env.EMAIL_PASS);
  } else {
    console.log('✅ Gmail transporter ready. Emails will send from:', process.env.EMAIL_USER);
  }
});

// Route: Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const lowerEmail = email.toLowerCase();
    if (!lowerEmail.endsWith('@deped.gov.ph')) {
      return res.status(403).json({ error: 'Unauthorized: Only @deped.gov.ph emails are allowed.' });
    }

    // Rate Limit Check: Check if an OTP was sent in the last 60 seconds
    const lastOtp = await pool.query(
      'SELECT created_at FROM otps WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
      [lowerEmail]
    );
    if (lastOtp.rows.length > 0) {
      const secondsSince = (Date.now() - new Date(lastOtp.rows[0].created_at)) / 1000;
      if (secondsSince < 60) {
        return res.status(429).json({ error: 'Please wait before requesting another OTP.' });
      }
    }

    // Clear previous OTPs for this email
    await pool.query('DELETE FROM otps WHERE email = $1', [lowerEmail]);

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60000); // 10 minutes

    // Insert into database
    await pool.query(
      'INSERT INTO otps (email, otp_code, expires_at) VALUES ($1, $2, $3)',
      [lowerEmail, otpCode, expiresAt]
    );

    // Send the email
    const mailOptions = {
      from: `"STRIDE Access Gate" <${process.env.EMAIL_USER}>`,
      to: lowerEmail,
      subject: 'Your STRIDE Registration OTP',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;
                    padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #003366; text-align: center; margin-bottom: 20px;">STRIDE Registration Gateway</h2>
          <p style="color: #333; font-size: 16px;">Hello,</p>
          <p style="color: #333; font-size: 16px;">
            Here is your One-Time Password (OTP) to verify your email address
            for your STRIDE account registration:
          </p>
          <div style="background-color: #f4f6f9; border: 1px dashed #003366;
                      padding: 15px; text-align: center; margin: 20px 0; border-radius: 4px;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #B91C1C;">${otpCode}</span>
          </div>
          <p style="color: #666; font-size: 14px;">
            This code will expire in <strong>10 minutes</strong>.
            Do not share this code with anyone.
          </p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="color: #999; font-size: 12px; text-align: center;">
            This is an automated message from the STRIDE system. Please do not reply.
          </p>
        </div>
      `
    };

    // DEV MODE: skip email and return OTP directly in response
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] OTP for ${lowerEmail}: ${otpCode}`);
      return res.status(200).json({ success: true, message: 'OTP sent (dev mode — check server terminal or response).', dev_otp: otpCode });
    }

    await transporter.sendMail(mailOptions);
    res.status(200).json({ success: true, message: 'OTP sent successfully.' });

  } catch (error) {
    console.error('Send OTP error:', error.message);
    res.status(500).json({ error: `Failed to send OTP: ${error.message}` });
  }
});

// Route: Verify OTP (Internal validation route)
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp_code } = req.body;
    if (!email || !otp_code) {
      return res.status(400).json({ error: 'Email and OTP code are required.' });
    }

    const check = await pool.query(
      'SELECT id FROM otps WHERE email = $1 AND otp_code = $2 AND expires_at > NOW()',
      [email.toLowerCase(), otp_code]
    );

    if (check.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    res.status(200).json({ success: true, message: 'OTP verified.' });
  } catch (error) {
    console.error('Verify OTP error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route: Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const payload = req.body;
    const { email, password, confirmPassword, otpCode, ...userData } = payload;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    const lowerEmail = email.toLowerCase();
    if (!lowerEmail.endsWith('@deped.gov.ph')) {
      return res.status(403).json({ error: 'Unauthorized: Only @deped.gov.ph emails are allowed.' });
    }

    // Check if user already exists
    const checkUser = await pool.query('SELECT id FROM users WHERE email = $1', [lowerEmail]);
    if (checkUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists.' });
    }

    // Verify OTP code
    if (!otpCode) {
      return res.status(400).json({ error: 'OTP code is strictly required to register.' });
    }
    const otpCheck = await pool.query(
      'SELECT id FROM otps WHERE email = $1 AND otp_code = $2 AND expires_at > NOW()',
      [lowerEmail, otpCode]
    );
    if (otpCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    // Delete used OTP
    await pool.query('DELETE FROM otps WHERE email = $1', [lowerEmail]);

    // Hash Password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert user into database
    const insertQuery = `
      INSERT INTO users (
        email, password_hash, role, station_level, position, office_name,
        first_name, middle_name, last_name, birthday, address,
        region, division, district, school
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id, email, role, first_name, last_name, region, division, district, station_level, position
    `;

    const values = [
      lowerEmail, passwordHash, userData.role || 'structural',
      userData.station_level || null, userData.position || null, userData.office_name || null,
      userData.first_name || null, userData.middle_name || null, userData.last_name || null,
      userData.birthday || null, userData.address || null,
      userData.region || null, userData.division || null, userData.district || null, userData.school || null
    ];

    const result = await pool.query(insertQuery, values);
    const user = result.rows[0];

    // Sign JWT
    const token = jwt.sign(
      {
        uid: user.id,
        email: user.email,
        role: user.role,
        name: `${user.first_name} ${user.last_name}`,
        region: user.region,
        division: user.division,
        district: user.district,
        station: user.station_level,
        position: user.position
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        region: user.region,
        division: user.division,
        district: user.district,
        station: user.station_level,
        position: user.position
      }
    });

  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route: Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const lowerEmail = email.toLowerCase();
    const result = await pool.query(
      `SELECT id, email, password_hash, role,
              first_name, last_name, region, division, district,
              station_level, position
       FROM users WHERE email = $1`,
      [lowerEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    // Compare Password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Sign JWT
    const token = jwt.sign(
      {
        uid: user.id,
        email: user.email,
        role: user.role,
        name: `${user.first_name} ${user.last_name}`,
        region: user.region,
        division: user.division,
        district: user.district,
        station: user.station_level,
        position: user.position
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        region: user.region,
        division: user.division,
        district: user.district,
        station: user.station_level,
        position: user.position
      }
    });

  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: `Login failed: ${error.message}` });
  }
});

// Route: Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp_code, newPassword } = req.body;
    if (!email || !otp_code || !newPassword) {
      return res.status(400).json({ error: 'Email, OTP, and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const lowerEmail = email.toLowerCase();
    // Check user exists
    const userCheck = await pool.query('SELECT id FROM users WHERE email = $1', [lowerEmail]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'No account found with that email.' });
    }
    // Verify OTP
    const otpCheck = await pool.query(
      'SELECT id FROM otps WHERE email = $1 AND otp_code = $2 AND expires_at > NOW()',
      [lowerEmail, otp_code]
    );
    if (otpCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }
    // Delete used OTP
    await pool.query('DELETE FROM otps WHERE email = $1', [lowerEmail]);
    // Hash and update password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, lowerEmail]);
    res.status(200).json({ success: true, message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Reset password error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route: Guest Access
app.post('/api/auth/guest', async (req, res) => {
  try {
    const { name, email, organization, purpose, region } = req.body;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email && !emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    if (!name || !email || !organization || !purpose) {
      return res.status(400).json({ error: 'Name, Email, Affiliation, and Purpose are required.' });
    }

    // Upsert guest row — also stores region
    const result = await pool.query(`
      INSERT INTO guests (name, email, organization, purpose, region)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET 
        name = EXCLUDED.name,
        organization = EXCLUDED.organization,
        purpose = EXCLUDED.purpose,
        region = EXCLUDED.region,
        created_at = NOW()
      RETURNING id, created_at;
    `, [name, email.toLowerCase(), organization, purpose, region || null]);

    res.status(201).json({
      success: true,
      message: 'Guest access saved successfully.',
      guestId: result.rows[0].id,
      timestamp: result.rows[0].created_at
    });

  } catch (error) {
    console.error('Guest access registration error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start Server and Database initialization
app.listen(PORT, async () => {
  console.log(`Backend server running on http://localhost:${PORT}`);

  // Test DB connection on startup
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT NOW() AS now, current_database() AS db, current_user AS usr');
    console.log('✅ DB connected:', res.rows[0]);
    client.release();
  } catch (err) {
    console.error('❌ DB connection FAILED:', err.message);
    console.error('   DATABASE_URL set?', !!process.env.DATABASE_URL);
  }

  await initDatabase();
});
