const express = require('express');
const router = express.Router();
const db = require('../config/db'); // 🟢 Required for Wallet queries
const driverController = require('../controllers/driverController'); // 🟢 Your existing controller

// 🟢 1. UPDATE DRIVER STATUS (Existing)
// Route: POST /api/driver/status
router.post('/status', driverController.updateStatus);

// 🟢 2. GET WALLET EARNINGS (New)
// Route: GET /api/driver/wallet/:driverId
router.get('/wallet/:driverId', async (req, res) => {
    try {
        const { driverId } = req.params;
        
        // Calculate Total Cash Earnings
        const cashRes = await db.query(
            "SELECT SUM(fare) as total FROM ride_history WHERE driver_id = $1 AND payment_method = 'Cash'", 
            [driverId]
        );

        // Calculate Total UPI Earnings
        const upiRes = await db.query(
            "SELECT SUM(fare) as total FROM ride_history WHERE driver_id = $1 AND payment_method = 'UPI'", 
            [driverId]
        );

        // Handle null values (if no rides yet)
        const totalCash = cashRes.rows[0].total || 0;
        const totalUPI = upiRes.rows[0].total || 0;

        res.json({
            success: true,
            cash: parseFloat(totalCash),
            upi: parseFloat(totalUPI),
            total: parseFloat(totalCash) + parseFloat(totalUPI)
        });
    } catch (err) {
        console.error("Error fetching wallet data:", err);
        res.status(500).json({ success: false, msg: "Server Error" });
    }
});

module.exports = router;