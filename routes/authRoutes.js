const express = require('express');
const router = express.Router();
const db = require('../config/db'); 
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 🟢 Setup Image Storage (Saves to public/uploads)
const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-'));
    }
});

const upload = multer({ storage: storage });

// 🟢 1. DRIVER REGISTRATION (Now handles Images!)
router.post('/register', upload.fields([{ name: 'license', maxCount: 1 }, { name: 'rc', maxCount: 1 }]), async (req, res) => {
    const { name, phone, age, vehicle_details, password, vehicle_type } = req.body;

    if (!name || !phone || !vehicle_details || !password) {
        return res.status(400).json({ success: false, msg: "Please fill all required fields" });
    }

    try {
        const checkUser = await db.query("SELECT * FROM drivers WHERE phone = $1", [phone]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ success: false, msg: "Phone number already registered" });
        }

        // Get the paths to the saved images
        const licenseUrl = req.files && req.files['license'] ? `/uploads/${req.files['license'][0].filename}` : null;
        const rcUrl = req.files && req.files['rc'] ? `/uploads/${req.files['rc'][0].filename}` : null;

        // Save everything to the database
        const newDriver = await db.query(
            "INSERT INTO drivers (name, phone, age, vehicle_details, password, vehicle_type, license_url, rc_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
            [name, phone, age || null, vehicle_details, password, vehicle_type || 'Bike', licenseUrl, rcUrl]
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