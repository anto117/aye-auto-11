const express = require('express');
const router = express.Router();
const db = require('../config/db');
// const bcrypt = require('bcrypt'); // Use bcrypt for real apps!

// REGISTER
router.post('/register', async (req, res) => {
    const { name, phone, email, gender, password } = req.body;
    try {
        // In production, hash password here: const hash = await bcrypt.hash(password, 10);
        const newUser = await db.query(
            "INSERT INTO riders (name, phone, email, gender, password) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [name, phone, email, gender, password] 
        );
        res.json({ success: true, user: newUser.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});

// LOGIN
router.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const user = await db.query("SELECT * FROM riders WHERE phone = $1", [phone]);
        if (user.rows.length === 0) return res.status(400).json({ success: false, msg: "User not found" });

        if (user.rows[0].password !== password) {
            return res.status(400).json({ success: false, msg: "Incorrect password" });
        }

        res.json({ success: true, user: user.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, msg: "Server error" });
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