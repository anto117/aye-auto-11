const db = require('../config/db');

// Update Driver Status (Online/Offline)
exports.updateStatus = async (req, res) => {
    const { driver_id, is_online } = req.body;

    try {
        const query = 'UPDATE drivers SET is_online = $1 WHERE id = $2 RETURNING *';
        const result = await db.query(query, [is_online, driver_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Driver not found" });
        }

        console.log(`Driver ${driver_id} is now ${is_online ? 'ONLINE 🟢' : 'OFFLINE 🔴'}`);
        res.json({ message: "Status updated", driver: result.rows[0] });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
};