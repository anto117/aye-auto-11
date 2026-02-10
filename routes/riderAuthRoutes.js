const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db'); // Adjust path to your db config

// 🟢 1. REGISTER (Updated with Error Handling)
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
        // 🟢 FIX: Handle Duplicate Phone Number
        if (err.code === '23505') { 
            return res.json({ success: false, msg: "This phone number is already registered. Please login." });
        }
        console.error(err);
        res.status(500).json({ success: false, error: "Server error" });
    }
});

// 🟢 2. LOGIN (Existing)
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

// 🟢 3. RESET PASSWORD (New Feature)
// Allows resetting password using JUST the phone number
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
// 🟢 NEW: LOGIN WITH FIREBASE (No OTP logic needed here)
router.post('/firebase-login', async (req, res) => {
    // 🟢 NOW ACCEPTING 'name' FROM THE APP
    const { phone, firebase_uid, name } = req.body; 

    try {
        const userCheck = await pool.query("SELECT * FROM riders WHERE phone = $1", [phone]);

        if (userCheck.rows.length > 0) {
            // LOGIN: User exists, return their data
            // (We ignore the name sent from app during login to preserve database data)
            res.json({ success: true, user: userCheck.rows[0] });
        } else {
            // SIGN UP: Create new user with the Name they entered
            const actualName = name && name.trim() !== "" ? name : "New Rider";
            
            const newUser = await pool.query(
                "INSERT INTO riders (name, phone, firebase_uid) VALUES ($1, $2, $3) RETURNING *",
                [actualName, phone, firebase_uid]
            );
            res.json({ success: true, user: newUser.rows[0] });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
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
// 🟢 API: Login or Register via Firebase Phone
router.post('/firebase-login', async (req, res) => {
    const { phone, firebase_uid } = req.body;

    try {
        // 1. Check if user exists
        const userCheck = await pool.query("SELECT * FROM riders WHERE phone = $1", [phone]);

        if (userCheck.rows.length > 0) {
            // USER EXISTS -> Login
            const user = userCheck.rows[0];
            
            // Optional: Update Firebase UID if missing
            if (!user.firebase_uid && firebase_uid) {
                await pool.query("UPDATE riders SET firebase_uid = $1 WHERE phone = $2", [firebase_uid, phone]);
            }

            return res.json({ success: true, user: user, msg: "Login successful" });
        } else {
            // USER NEW -> Register (Create new account automatically)
            // Note: Password is NULL because they used OTP
            const newUser = await pool.query(
                "INSERT INTO riders (name, phone, firebase_uid) VALUES ($1, $2, $3) RETURNING *",
                ["New Rider", phone, firebase_uid]
            );

            return res.json({ success: true, user: newUser.rows[0], msg: "Account created" });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});
module.exports = router;