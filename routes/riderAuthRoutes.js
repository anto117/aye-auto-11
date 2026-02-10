const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db'); // 🟢 Database Connection

// 🟢 1. REGISTER (Standard Email/Pass)
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

// 🟢 2. LOGIN (Standard Email/Pass)
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

// 🟢 3. RESET PASSWORD
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

// 🟢 4. FIREBASE LOGIN / SIGNUP (The One We Need!)
// 🟢 FIXED: Handle Duplicate Key Error Gracefully
router.post('/firebase-login', async (req, res) => {
    const { phone, firebase_uid, name } = req.body; 

    try {
        // 1. Try to find the user by PHONE first
        let userCheck = await db.query("SELECT * FROM riders WHERE phone = $1", [phone]);

        // 2. If not found by phone, try to find by FIREBASE_UID
        if (userCheck.rows.length === 0) {
            userCheck = await db.query("SELECT * FROM riders WHERE firebase_uid = $1", [firebase_uid]);
        }

        if (userCheck.rows.length > 0) {
            // ✅ USER EXISTS -> LOGIN
            const user = userCheck.rows[0];

            // If the user exists but doesn't have the UID saved yet, update it
            if (!user.firebase_uid || user.firebase_uid !== firebase_uid) {
                await db.query("UPDATE riders SET firebase_uid = $1 WHERE id = $2", [firebase_uid, user.id]);
            }

            res.json({ success: true, user: user, msg: "Login successful" });
        } else {
            // 🆕 USER DOES NOT EXIST -> REGISTER
            const actualName = (name && name.trim() !== "") ? name : "New Rider";
            
            const newUser = await db.query(
                "INSERT INTO riders (name, phone, firebase_uid) VALUES ($1, $2, $3) RETURNING *",
                [actualName, phone, firebase_uid]
            );
            res.json({ success: true, user: newUser.rows[0], msg: "Account Created" });
        }
    } catch (err) {
        // 🟢 SPECIAL HANDLER: If we hit a race condition or duplicate error, just login the user
        if (err.code === '23505') { // Postgres code for Unique Violation
            console.log("⚠️ Duplicate ID detected, logging in existing user...");
            const existingUser = await db.query("SELECT * FROM riders WHERE firebase_uid = $1 OR phone = $2", [firebase_uid, phone]);
            if (existingUser.rows.length > 0) {
                 return res.json({ success: true, user: existingUser.rows[0], msg: "Login successful (Recovered)" });
            }
        }

        console.error("Firebase Login Error:", err.message);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});

// 🟢 5. GET RIDE HISTORY
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