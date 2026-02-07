const express = require('express');
const cors = require('cors');
const http = require('http'); 
const axios = require('axios'); 
const { Server } = require("socket.io");
const db = require('./config/db'); 
const admin = require("firebase-admin"); 
require('dotenv').config();

// 🟢 INITIALIZE FIREBASE
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("🔥 Firebase Admin Initialized");
    } else {
        try {
            const serviceAccount = require("./serviceAccountKey.json"); 
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("🔥 Firebase Admin Initialized (Local)");
        } catch(err) {
             console.log("⚠️ No local firebase key found.");
        }
    }
} catch (e) {
    console.log("⚠️ Firebase Not Initialized: " + e.message);
}

const app = express();
const server = http.createServer(app); 

app.use(cors()); 
app.use(express.json()); 

// --- ROUTES ---
const authRoutes = require('./routes/authRoutes'); 
const driverRoutes = require('./routes/driverRoutes'); 
const riderAuthRoutes = require('./routes/riderAuthRoutes'); 

app.use('/api/driver', driverRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/rider-auth', riderAuthRoutes); 

const io = new Server(server, { cors: { origin: "*" } });
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_FALLBACK_KEY"; // Use .env!

// --- HELPER: Google Route Data ---
async function getRouteData(startLat, startLng, destinationInput) {
    try {
        const destParam = encodeURIComponent(destinationInput);
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${startLat},${startLng}&destination=${destParam}&key=${GOOGLE_API_KEY}`;
        const response = await axios.get(url);
        
        if (response.data.status === "OK" && response.data.routes.length > 0) {
            const leg = response.data.routes[0].legs[0];
            return {
                distanceKm: leg.distance.value / 1000,
                distanceText: leg.distance.text,
                durationText: leg.duration.text,
                polyline: response.data.routes[0].overview_polyline.points,
                endLat: leg.end_location.lat,
                endLng: leg.end_location.lng
            };
        }
    } catch (err) {
        console.error("Network Error:", err.message);
    }
    return null;
}

// --- HELPER: Send Push Notification ---
async function sendPushNotification(token, title, body) {
    if(!token) return;
    try {
        await admin.messaging().send({
            token: token,
            notification: { title: title, body: body },
            data: { click_action: "FLUTTER_NOTIFICATION_CLICK", sound: "default" }
        });
    } catch (e) {
        console.error("Notification Error:", e.message);
    }
}

// 🟢 STARTUP CLEANUP
async function clearStuckRides() {
    try {
        const res = await db.query(`UPDATE rides SET status = 'CANCELLED' WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') RETURNING id`);
        if (res.rowCount > 0) {
            console.log(`🧹 AUTO-CLEANUP: Cancelled ${res.rowCount} stuck rides.`);
        }
    } catch (e) { console.error("Cleanup Error", e); }
}
clearStuckRides(); 

// 🟢 SOCKET.IO LOGIC
io.on('connection', (socket) => {
    console.log(`⚡ Client Connected: ${socket.id}`);

    // 1. DRIVER LOCATION & AUTO-FIX
    socket.on('driver_location', async (data) => {
        try {
            await db.query(
                `UPDATE drivers 
                 SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326), 
                     heading = $3, 
                     socket_id = $4,
                     is_online = true,
                     fcm_token = COALESCE($5, fcm_token)
                 WHERE id = $6`,
                [data.lng, data.lat, data.heading, socket.id, data.fcmToken, data.driverId]
            );

            // Auto-cancel stuck rides for this driver
            const stuckRide = await db.query(
                `UPDATE rides SET status = 'CANCELLED' 
                 WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') 
                 RETURNING id`,
                [data.driverId]
            );
            if (stuckRide.rowCount > 0) console.log(`🛠️ Freed Driver ${data.driverId} from stuck ride.`);

        } catch (err) { console.error("Geo Error:", err.message); }
    });

    socket.on('disconnect', async () => {
        try { await db.query(`UPDATE drivers SET is_online = false WHERE socket_id = $1`, [socket.id]); } 
        catch(e) {}
    });

    // 2. GET ESTIMATE
    socket.on('get_estimate', async (data) => {
        const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
        if (!tripRoute) {
            socket.emit('estimate_error', { msg: "Could not calculate route." });
            return;
        }
        try {
            const driverRes = await db.query(
                `SELECT id, ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
                 FROM drivers WHERE is_online = true
                 ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography LIMIT 1`,
                [data.pickupLng, data.pickupLat]
            );

            let approachText = "5 mins"; 
            let hasDriver = false;
            if (driverRes.rows.length > 0) {
                hasDriver = true;
                const drv = driverRes.rows[0];
                const approach = await getRouteData(drv.lat, drv.lng, `${data.pickupLat},${data.pickupLng}`);
                if (approach) approachText = approach.durationText;
            }

            let baseFare = tripRoute.distanceKm * 30; 
            if (baseFare < 30) baseFare = 30; 
            const finalFare = Math.round(baseFare); 

            socket.emit('estimate_response', {
                fareUPI: finalFare,
                fareCash: finalFare,
                tripDistance: tripRoute.distanceText,
                driverDistance: approachText,
                hasDriver: hasDriver,
                polyline: tripRoute.polyline,
                dropLat: tripRoute.endLat,
                dropLng: tripRoute.endLng
            });
        } catch (err) { console.error("Estimate Error:", err.message); }
    });

    // 3. REQUEST RIDE (With Timeout Logic)
    socket.on('request_ride', async (data) => {
        console.log(`📲 REQUEST: ${data.destination}`);
        try {
            const riderRes = await db.query(`SELECT phone FROM riders WHERE id = $1`, [data.riderId]);
            const riderPhone = riderRes.rows.length > 0 ? riderRes.rows[0].phone : null;

            const result = await db.query(
                `INSERT INTO rides (rider_id, rider_socket_id, pickup_lat, pickup_lng, drop_lat, drop_lng, fare, status, destination) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8) RETURNING id`,
                [data.riderId || 0, socket.id, data.pickupLat, data.pickupLng, data.dropLat, data.dropLng, data.fare, data.destination]
            );
            const rideId = result.rows[0].id;

            const nearbyDrivers = await db.query(
                `SELECT id, socket_id, fcm_token FROM drivers 
                 WHERE is_online = true 
                 AND id NOT IN (SELECT driver_id FROM rides WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') AND driver_id IS NOT NULL)
                 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50000)`, 
                [data.pickupLng, data.pickupLat]
            );

            console.log(`🔎 Found ${nearbyDrivers.rows.length} drivers.`);
            const payload = { ...data, ride_id: rideId, rider_id: socket.id, riderPhone: riderPhone };

            nearbyDrivers.rows.forEach(driver => {
                if (driver.socket_id) io.to(driver.socket_id).emit('driver_request', payload);
                if (driver.fcm_token) sendPushNotification(driver.fcm_token, "New Ride Request! 🚖", `Drop: ${data.destination} - ₹${data.fare}`);
            });

            // 🟢 TIMEOUT LOGIC (2 Minutes)
            setTimeout(async () => {
                const check = await db.query("SELECT status FROM rides WHERE id = $1", [rideId]);
                if (check.rows.length > 0 && check.rows[0].status === 'REQUESTED') {
                    console.log(`⏰ Ride ${rideId} timed out.`);
                    await db.query("UPDATE rides SET status = 'TIMEOUT' WHERE id = $1", [rideId]);
                    // Notify Rider
                    io.to(socket.id).emit('ride_timeout');
                }
            }, 120000); // 120000 ms = 2 minutes

        } catch (err) { console.error("Request Error:", err.message); }
    });

    // 4. ACCEPT RIDE
    socket.on('accept_ride', async (data) => {
        try {
            await db.query(`UPDATE rides SET driver_id = $1, status = 'ACCEPTED' WHERE id = $2`, [data.driver_id, data.ride_id]);
            const driverInfo = await db.query(`SELECT name, phone FROM drivers WHERE id = $1`, [data.driver_id]);
            const driver = driverInfo.rows[0];

            io.to(data.rider_id).emit('ride_accepted', {
                ride_id: data.ride_id, 
                driverName: driver ? driver.name : "Driver",
                driverPhone: driver ? driver.phone : "0000000000", 
                vehicle: "Auto", eta: "5 mins",
                lat: data.driverLat, lng: data.driverLng, fare: data.fare 
            });

            const pickupRoute = await getRouteData(data.driverLat, data.driverLng, `${data.pickupLat},${data.pickupLng}`);
            socket.emit('ride_started_info', { pickupPolyline: pickupRoute ? pickupRoute.polyline : null, totalFare: data.fare });
        } catch (err) { console.error("Accept Error:", err.message); }
    });

    // 5. CANCEL RIDE
    socket.on('cancel_ride', async (data) => {
        try {
            await db.query(`UPDATE rides SET status = 'CANCELLED' WHERE id = $1`, [data.ride_id]);
            const rideData = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [data.ride_id]);
            if (rideData.rows.length > 0 && rideData.rows[0].driver_id) {
                const driverRes = await db.query(`SELECT socket_id FROM drivers WHERE id = $1`, [rideData.rows[0].driver_id]);
                if (driverRes.rows.length > 0) io.to(driverRes.rows[0].socket_id).emit('ride_cancelled_by_user');
            }
        } catch (err) { console.error("Cancel Error:", err.message); }
    });

    // 6. DRIVER ARRIVED
    socket.on('driver_arrived', async (data) => {
        await db.query(`UPDATE rides SET status = 'ARRIVED' WHERE id = $1`, [data.ride_id]);
        io.to(data.rider_id).emit('driver_arrived_notification', { msg: "Driver has arrived!" });
    });

    // 7. COMPLETE RIDE (Updated to Notify Rider)
    socket.on('complete_ride', async (data) => {
        try {
            // Update DB
            await db.query(`UPDATE rides SET status = 'COMPLETED', payment_method = $1 WHERE id = $2`, [data.paymentMethod, data.ride_id]);
            
            // Notify Driver (Success)
            socket.emit('ride_saved_success');

            // 🟢 Notify Rider (Show Rating Screen)
            const rideData = await db.query(`SELECT rider_socket_id FROM rides WHERE id = $1`, [data.ride_id]);
            if (rideData.rows.length > 0) {
                io.to(rideData.rows[0].rider_socket_id).emit('ride_completed', { ride_id: data.ride_id });
            }
        } catch (err) { console.error("Complete Error:", err); }
    });

    // 🟢 8. SUBMIT RATING
    socket.on('submit_rating', async (data) => {
        try {
            // Update the ride with the rating
            await db.query(`UPDATE rides SET rating = $1, feedback = $2 WHERE id = $3`, [data.rating, data.comment, data.ride_id]);
            console.log(`⭐ Ride ${data.ride_id} Rated: ${data.rating} stars`);
        } catch(e) { console.error("Rating Error", e.message); }
    });

    // 9. VOICE NOTES
    socket.on('send_voice_note', (data) => {
        socket.broadcast.emit('receive_voice_note', { audio_data: data.audio_data, sender: "User" });
    });
});

const PORT = process.env.PORT || 3001; 
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));