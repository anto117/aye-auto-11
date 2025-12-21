const db = require('../config/db');

exports.loginOrRegisterDriver = async (req, res) => {
    const { phone_number, name, vehicle_details } = req.body;

    try {
        // 1. Check if driver exists
        const checkRes = await db.query("SELECT * FROM drivers WHERE phone_number = $1", [phone_number]);

        if (checkRes.rows.length > 0) {
            // DRIVER EXISTS -> LOGIN
            res.status(200).json({ 
                msg: "Login Successful", 
                driver: checkRes.rows[0],
                isNewUser: false 
            });
        } else {
            // DRIVER DOES NOT EXIST -> CHECK IF NAME IS PROVIDED
            if (!name) {
                // Tell App to show the "Enter Name" fields
                return res.status(200).json({ msg: "New User", isNewUser: true });
            }

            // CREATE NEW DRIVER
            const insertRes = await db.query(
                "INSERT INTO drivers (phone_number, name, vehicle_details, is_available) VALUES ($1, $2, $3, TRUE) RETURNING *",
                [phone_number, name, vehicle_details || 'Auto Rickshaw']
            );
            
            res.status(201).json({ 
                msg: "Registration Successful", 
                driver: insertRes.rows[0],
                isNewUser: false
            });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
};