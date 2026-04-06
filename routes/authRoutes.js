const express = require('express');
const router = express.Router();
const db = require('../config/db'); 

// 🟢 1. DRIVER REGISTRATION
router.post('/register', async (req, res) => {
    // 🟢 NEW: Added vehicle_type
    const { name, phone, vehicle_details, password, vehicle_type } = req.body;

    if (!name || !phone || !vehicle_details || !password) {
        return res.status(400).json({ success: false, msg: "Please fill all fields" });
    }

    try {
        const checkUser = await db.query("SELECT * FROM drivers WHERE phone = $1", [phone]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ success: false, msg: "Phone number already registered" });
        }

        // 🟢 NEW: Save vehicle_type to the database
        const newDriver = await db.query(
            "INSERT INTO drivers (name, phone, vehicle_details, password, vehicle_type) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [name, phone, vehicle_details, password, vehicle_type || 'Auto']
        );

        res.json({
            success: true,
            msg: "Registration successful",
            driver: newDriver.rows[0]
        });

    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});

// 🟢 2. DRIVER LOGIN
router.post('/login', async (req, res) => {
    const { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({ success: false, msg: "Please enter phone and password" });
    }

    try {
        const result = await db.query("SELECT * FROM drivers WHERE phone = $1", [phone]);

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, msg: "Driver not found" });
        }

        const driver = result.rows[0];

        if (driver.password !== password) {
            return res.status(400).json({ success: false, msg: "Incorrect password" });
        }

        res.json({
            success: true,
            msg: "Login successful",
            driver: driver
        });

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});

module.exports = router;