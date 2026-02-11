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
        console.log("🔥 Firebase Admin Initialized (via Env Var)");
    } else {
        try {
            const serviceAccount = require("./serviceAccountKey.json"); 
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("🔥 Firebase Admin Initialized (via Local File)");
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
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; 

// --- HELPER: Google Route Data ---
async function getRouteData(startLat, startLng, destinationInput) {
    if (!GOOGLE_API_KEY) {
        console.error("❌ MISSING GOOGLE_API_KEY in .env");
        return null;
    }
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
        } else {
            console.error("⚠️ Google Maps API Error:", response.data.status);
        }
    } catch (err) {
        console.error("❌ Network Error (Google Maps):", err.message);
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
        console.log(`📲 Notification sent to driver.`);
    } catch (e) {
        console.error("Notification Error:", e.message);
    }
}

// 🟢 AUTO-FIX: STARTUP CLEANUP
async function clearStuckRides() {
    try {
        const res = await db.query(`UPDATE rides SET status = 'CANCELLED' WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') RETURNING id`);
        if (res.rowCount > 0) {
            console.log(`🧹 AUTO-CLEANUP: Cancelled ${res.rowCount} stuck rides.`);
        } else {
            console.log(`✅ System Clean: No stuck rides found.`);
        }
    } catch (e) {
        console.error("Cleanup Error", e);
    }
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

            // Cancel any stuck rides for this driver (since they are reporting location, they are free)
            const stuckRide = await db.query(
                `UPDATE rides SET status = 'CANCELLED' 
                 WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') 
                 RETURNING id`,
                [data.driverId]
            );

            if (stuckRide.rowCount > 0) {
                console.log(`🛠️ FIXED: Auto-cancelled stuck ride for Driver ${data.driverId}.`);
            }
        } catch (err) {
            console.error("Geo Update Error:", err.message);
        }
    });

    socket.on('disconnect', async () => {
        try {
             await db.query(`UPDATE drivers SET is_online = false WHERE socket_id = $1`, [socket.id]);
        } catch(e) {
             console.error("Disconnect Error", e.message);
        }
    });

    // 2. GET ESTIMATE
    socket.on('get_estimate', async (data) => {
        console.log("📩 Received 'get_estimate':", data);
        
        try {
            const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
            
            if (!tripRoute) {
                console.log("⚠️ No route found.");
                socket.emit('estimate_error', { msg: "Could not calculate route." });
                return;
            }

            // Find nearest online driver
            const driverRes = await db.query(
                `SELECT id, ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
                 FROM drivers
                 WHERE is_online = true
                 ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                 LIMIT 1`,
                [data.pickupLng, data.pickupLat]
            );

            let approachText = "5 mins"; 
            let hasDriver = false;

            if (driverRes.rows.length > 0) {
                hasDriver = true;
                const drv = driverRes.rows[0];
                const approachRoute = await getRouteData(drv.lat, drv.lng, `${data.pickupLat},${data.pickupLng}`);
                if (approachRoute) approachText = approachRoute.durationText;
            }

            // Fare Calculation
            let baseFare = tripRoute.distanceKm * 30; 
            if (baseFare < 30) baseFare = 30; 
            const finalFare = Math.round(baseFare); 

            console.log(`💰 Sending Estimate: ₹${finalFare}`);
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

        } catch (err) {
            console.error("❌ CRITICAL SERVER ERROR in get_estimate:", err.message);
            socket.emit('estimate_error', { msg: "Server Error: " + err.message });
        }
    });

    // 3. REQUEST RIDE
    socket.on('request_ride', async (data) => {
        console.log(`📲 REQUEST RECEIVED: ${data.destination}`);
        
        try {
            const riderRes = await db.query(`SELECT phone FROM riders WHERE id = $1`, [data.riderId]);
            const riderPhone = riderRes.rows.length > 0 ? riderRes.rows[0].phone : null;

            const result = await db.query(
                `INSERT INTO rides (rider_id, rider_socket_id, pickup_lat, pickup_lng, drop_lat, drop_lng, fare, status, destination) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8) RETURNING id`,
                [data.riderId || 0, socket.id, data.pickupLat, data.pickupLng, data.dropLat, data.dropLng, data.fare, data.destination]
            );
            const rideId = result.rows[0].id;
            console.log(`✅ Ride Created ID: ${rideId}`);

            // Find Drivers (EXCLUDING BUSY ONES)
            const nearbyDrivers = await db.query(
                `SELECT id, socket_id, fcm_token 
                 FROM drivers 
                 WHERE is_online = true 
                 AND id NOT IN (SELECT driver_id FROM rides WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') AND driver_id IS NOT NULL)
                 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 5000)`, 
                [data.pickupLng, data.pickupLat]
            );

            console.log(`📢 Notifying ${nearbyDrivers.rows.length} available drivers.`);
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
                    io.to(socket.id).emit('ride_timeout');
                }
            }, 120000); 

        } catch (err) {
            console.error("❌ Request Ride Error:", err.message);
        }
    });

    // 4. ACCEPT RIDE
    // 4. ACCEPT RIDE (Fixed for Race Condition)
    socket.on('accept_ride', async (data) => {
        console.log(`Attempting to accept ride: ${data.ride_id} by Driver ${data.driver_id}`);
        
        try {
            // 🟢 ATOMIC UPDATE: This query will fail (return 0 rows) if the status is not 'REQUESTED'
            const result = await db.query(
                `UPDATE rides 
                 SET driver_id = $1, status = 'ACCEPTED' 
                 WHERE id = $2 AND status = 'REQUESTED' 
                 RETURNING *`, 
                [data.driver_id, data.ride_id]
            );

            // 🔴 FAIL: If no rows were updated, someone else took it first
            if (result.rowCount === 0) {
                console.log(`❌ Ride ${data.ride_id} already taken.`);
                socket.emit('ride_booking_failed', { msg: "Ride already booked by another driver 😔" });
                return; 
            }

            // 🟢 SUCCESS: You are the winner
            console.log(`✅ Driver ${data.driver_id} WON the ride!`);
            
            // Fetch Driver Info to send to Rider
            const driverInfo = await db.query(`SELECT name, phone FROM drivers WHERE id = $1`, [data.driver_id]);
            const driver = driverInfo.rows[0];

            // 1. Notify the Rider
            io.to(data.rider_id).emit('ride_accepted', {
                ride_id: data.ride_id, 
                driverName: driver ? driver.name : "Driver",
                driverPhone: driver ? driver.phone : "0000000000", 
                vehicle: "Auto", eta: "5 mins",
                lat: data.driverLat, lng: data.driverLng, fare: data.fare 
            });

            // 2. Notify the Driver (Confirmation)
            socket.emit('ride_booking_success', { ride_id: data.ride_id });

            // 3. Send Pickup Route to Driver
            const pickupRoute = await getRouteData(data.driverLat, data.driverLng, `${data.pickupLat},${data.pickupLng}`);
            socket.emit('ride_started_info', { 
                pickupPolyline: pickupRoute ? pickupRoute.polyline : null, 
                totalFare: data.fare 
            });

        } catch (err) { 
            console.error("Accept Ride Error:", err.message); 
        }
    });

    // 5. CANCEL RIDE
    socket.on('cancel_ride', async (data) => {
        console.log(`❌ Ride ${data.ride_id} Cancelled`);
        if (!data.ride_id) return;

        try {
            await db.query(`UPDATE rides SET status = 'CANCELLED' WHERE id = $1`, [data.ride_id]);
            
            const rideData = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [data.ride_id]);
            if (rideData.rows.length > 0 && rideData.rows[0].driver_id) {
                const driverId = rideData.rows[0].driver_id;
                const driverRes = await db.query(`SELECT socket_id FROM drivers WHERE id = $1`, [driverId]);
                if (driverRes.rows.length > 0) {
                    io.to(driverRes.rows[0].socket_id).emit('ride_cancelled_by_user');
                }
            }
        } catch (err) { console.error("Cancel Logic Error:", err.message); }
    });

    // 6. DRIVER ARRIVED
    socket.on('driver_arrived', async (data) => {
        await db.query(`UPDATE rides SET status = 'ARRIVED' WHERE id = $1`, [data.ride_id]);
        const targetSocket = data.rider_id || data.rider_socket_id;
        io.to(targetSocket).emit('driver_arrived_notification', { msg: "Driver has arrived!" });
    });

    // 7. COMPLETE RIDE
    socket.on('complete_ride', async (data) => {
        try {
            await db.query(`UPDATE rides SET status = 'COMPLETED', payment_method = $1 WHERE id = $2`, [data.paymentMethod, data.ride_id]);
            socket.emit('ride_saved_success');

            // Notify Rider (Show Rating Screen)
            const rideData = await db.query(`SELECT rider_socket_id FROM rides WHERE id = $1`, [data.ride_id]);
            if (rideData.rows.length > 0) {
                io.to(rideData.rows[0].rider_socket_id).emit('ride_completed', { ride_id: data.ride_id });
            }
        } catch (err) { console.error("Error completing ride:", err); }
    });

    // 🟢 8. SUBMIT RATING
    socket.on('submit_rating', async (data) => {
        try {
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