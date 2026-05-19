const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../config/db'); // 🟢 Database Connection

// ─── 🟢 IN-MEMORY CODE STORE (for email verification) ─────────────────
// In production, use Redis or a DB table. This works fine for a single-server setup.
const verificationCodes = new Map(); // key: email, value: { code, name, expiresAt }

// ─── 🟢 EMAIL TRANSPORTER ─────────────────────────────────────────────
// Configure your email service here. Using Gmail as example.
// You MUST set EMAIL_USER and EMAIL_PASS in your .env file.
let transporter = null;
try {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER || '',
            pass: process.env.EMAIL_PASS || '', // Use App Password for Gmail
        },
    });
    console.log("📧 Email Transporter Ready");
} catch (e) {
    console.log("⚠️ Email Transporter not configured:", e.message);
}

// ─── HELPER: Generate 6-digit code ────────────────────────────────────
function generateCode() {
    return crypto.randomInt(100000, 999999).toString();
}

// ─── HELPER: Send Email ───────────────────────────────────────────────
async function sendVerificationEmail(toEmail, code) {
    if (!transporter) {
        console.log(`📧 [DEV MODE] Verification code for ${toEmail}: ${code}`);
        return true; // In dev mode, just log the code
    }

    try {
        await transporter.sendMail({
            from: `"Savaari" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject: 'Your Savaari Verification Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 30px; text-align: center;">
                    <h2 style="color: #333;">🚕 Savaari</h2>
                    <p style="color: #666; font-size: 16px;">Your verification code is:</p>
                    <div style="background: #FBC02D; color: #000; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 20px; border-radius: 12px; margin: 20px 0;">
                        ${code}
                    </div>
                    <p style="color: #999; font-size: 14px;">This code expires in 10 minutes. Do not share it with anyone.</p>
                </div>
            `,
        });
        return true;
    } catch (err) {
        console.error("❌ Email Send Error:", err.message);
        return false;
    }
}


// ═══════════════════════════════════════════════════════════════════════
// 🟢 EMAIL FLOW: SEND VERIFICATION CODE
// ═══════════════════════════════════════════════════════════════════════
router.post('/send-code', async (req, res) => {
    try {
        const { email, name, isLogin } = req.body;

        if (!email || !email.includes('@')) {
            return res.json({ success: false, msg: "Invalid email address" });
        }

        // Check if user exists
        const existingUser = await db.query("SELECT * FROM riders WHERE email = $1", [email.toLowerCase()]);

        if (isLogin && existingUser.rows.length === 0) {
            return res.json({ success: false, msg: "No account found with this email. Please sign up." });
        }

        if (!isLogin && existingUser.rows.length > 0) {
            return res.json({ success: false, msg: "An account with this email already exists. Please login." });
        }

        // Generate and store code
        const code = generateCode();
        verificationCodes.set(email.toLowerCase(), {
            code,
            name: name || "",
            expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        });

        // Send email
        const sent = await sendVerificationEmail(email, code);

        if (sent) {
            console.log(`📧 Code sent to ${email}: ${code}`);
            res.json({ success: true, msg: "Verification code sent" });
        } else {
            res.json({ success: false, msg: "Failed to send email. Please try again." });
        }

    } catch (err) {
        console.error("Send Code Error:", err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});


// ═══════════════════════════════════════════════════════════════════════
// 🟢 EMAIL FLOW: VERIFY CODE & LOGIN/SIGNUP
// ═══════════════════════════════════════════════════════════════════════
router.post('/verify-code', async (req, res) => {
    try {
        const { email, code, name, isLogin } = req.body;
        const lowerEmail = email.toLowerCase();

        // Check code
        const stored = verificationCodes.get(lowerEmail);

        if (!stored) {
            return res.json({ success: false, msg: "No code was sent to this email. Please request a new one." });
        }

        if (Date.now() > stored.expiresAt) {
            verificationCodes.delete(lowerEmail);
            return res.json({ success: false, msg: "Code has expired. Please request a new one." });
        }

        if (stored.code !== code) {
            return res.json({ success: false, msg: "Incorrect code. Please try again." });
        }

        // Code is valid! Delete it.
        verificationCodes.delete(lowerEmail);

        if (isLogin) {
            // LOGIN: Find user by email
            const result = await db.query("SELECT * FROM riders WHERE email = $1", [lowerEmail]);
            if (result.rows.length === 0) {
                return res.json({ success: false, msg: "User not found" });
            }
            return res.json({ success: true, user: result.rows[0], msg: "Login successful" });

        } else {
            // SIGNUP: Create new user
            const actualName = (name && name.trim() !== "") ? name.trim() : (stored.name || "New Rider");

            const newUser = await db.query(
                "INSERT INTO riders (name, email) VALUES ($1, $2) RETURNING *",
                [actualName, lowerEmail]
            );
            return res.json({ success: true, user: newUser.rows[0], msg: "Account Created" });
        }

    } catch (err) {
        // Handle duplicate email
        if (err.code === '23505') {
            const existingUser = await db.query("SELECT * FROM riders WHERE email = $1", [req.body.email.toLowerCase()]);
            if (existingUser.rows.length > 0) {
                return res.json({ success: true, user: existingUser.rows[0], msg: "Login successful (existing account)" });
            }
        }
        console.error("Verify Code Error:", err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});


// ═══════════════════════════════════════════════════════════════════════
// 🟢 PHONE FLOW: LOGIN WITH PHONE + PASSWORD
// ═══════════════════════════════════════════════════════════════════════
router.post('/phone-login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.json({ success: false, msg: "Please enter phone and password" });
        }

        const result = await db.query("SELECT * FROM riders WHERE phone = $1", [phone]);

        if (result.rows.length === 0) {
            return res.json({ success: false, msg: "User not found. Please sign up first." });
        }

        const user = result.rows[0];

        // Check password (supports both hashed and plain text for backward compatibility)
        if (user.password) {
            const isHashed = user.password.startsWith('$2');
            if (isHashed) {
                const validPass = await bcrypt.compare(password, user.password);
                if (!validPass) return res.json({ success: false, msg: "Invalid password" });
            } else {
                if (user.password !== password) return res.json({ success: false, msg: "Invalid password" });
            }
        } else {
            return res.json({ success: false, msg: "This account was created without a password. Try email login." });
        }

        res.json({ success: true, user: user, msg: "Login successful" });

    } catch (err) {
        console.error("Phone Login Error:", err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});


// ═══════════════════════════════════════════════════════════════════════
// 🟢 PHONE FLOW: SIGNUP WITH PHONE + PASSWORD
// ═══════════════════════════════════════════════════════════════════════
router.post('/phone-signup', async (req, res) => {
    try {
        const { phone, password, name } = req.body;

        if (!phone || !password) {
            return res.json({ success: false, msg: "Phone and password are required" });
        }

        // Check if user already exists
        const existingUser = await db.query("SELECT * FROM riders WHERE phone = $1", [phone]);
        if (existingUser.rows.length > 0) {
            return res.json({ success: false, msg: "This phone number is already registered. Please login." });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const actualName = (name && name.trim() !== "") ? name.trim() : "New Rider";

        const newUser = await db.query(
            "INSERT INTO riders (name, phone, password) VALUES ($1, $2, $3) RETURNING *",
            [actualName, phone, hashedPassword]
        );

        res.json({ success: true, user: newUser.rows[0], msg: "Account Created" });

    } catch (err) {
        if (err.code === '23505') {
            return res.json({ success: false, msg: "This phone number is already registered. Please login." });
        }
        console.error("Phone Signup Error:", err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});


// ═══════════════════════════════════════════════════════════════════════
// 🟢 LEGACY ROUTES (Kept for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════

// 🟢 REGISTER (Standard Email/Pass)
router.post('/register', async (req, res) => {
    try {
        const { name, phone, email, gender, password } = req.body;
        
        // Hash Password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insert User
        const result = await db.query(
            `INSERT INTO riders (name, phone, email, gender, password) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, phone, email, gender, hashedPassword]
        );

        res.json({ success: true, user: result.rows[0] });

    } catch (err) {
        // Handle Duplicate Phone Number
        if (err.code === '23505') { 
            return res.json({ success: false, msg: "This phone number is already registered. Please login." });
        }
        console.error(err);
        res.status(500).json({ success: false, error: "Server error" });
    }
});

// 🟢 LOGIN (Standard Email/Pass)
router.post('/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const result = await db.query("SELECT * FROM riders WHERE phone = $1", [phone]);

        if (result.rows.length === 0) return res.json({ success: false, msg: "User not found" });

        const validPass = await bcrypt.compare(password, result.rows[0].password);
        if (!validPass) return res.json({ success: false, msg: "Invalid Password" });

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 🟢 RESET PASSWORD
router.post('/reset-password', async (req, res) => {
    try {
        const { phone, newPassword } = req.body;

        // 1. Check if user exists
        const userCheck = await db.query("SELECT * FROM riders WHERE phone = $1", [phone]);
        if (userCheck.rows.length === 0) {
            return res.json({ success: false, msg: "Phone number not registered" });
        }

        // 2. Hash New Password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // 3. Update Database
        await db.query("UPDATE riders SET password = $1 WHERE phone = $2", [hashedPassword, phone]);

        res.json({ success: true, msg: "Password updated successfully!" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: "Server error" });
    }
});

// 🟢 GET RIDE HISTORY
router.get('/history/:riderId', async (req, res) => {
    try {
        const { riderId } = req.params;
        const result = await db.query(
            `SELECT id, destination, fare, status, created_at 
             FROM rides 
             WHERE rider_id = $1 
             ORDER BY id DESC`, 
            [riderId]
        );
        res.json({ success: true, history: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;