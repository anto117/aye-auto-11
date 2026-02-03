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
const GOOGLE_API_KEY = "AIzaSyCb3i7_Y_jvTtwyni1SwucLoDayMqqrmJ8"; 

// --- HELPER: Google Route Data (Fixes Distance Accuracy) ---
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

// 🟢 AUTO-FIX: STARTUP CLEANUP
// This cancels any "Zombie Rides" so drivers become free when server restarts.
async function clearStuckRides() {
    try {
        const res = await db.query(`UPDATE rides SET status = 'CANCELLED' WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') RETURNING id`);
        if (res.rowCount > 0) {
            console.log(`🧹 AUTO-CLEANUP: Cancelled ${res.rowCount} stuck rides. Drivers are now free.`);
        } else {
            console.log(`✅ System Clean: No stuck rides found.`);
        }
    } catch (e) {
        console.error("Cleanup Error", e);
    }
}
clearStuckRides(); // Run immediately on startup

// 🟢 SOCKET.IO LOGIC
io.on('connection', (socket) => {
    console.log(`⚡ Client Connected: ${socket.id}`);

    // 1. DRIVER MOVES / COMES ONLINE
    // 🟢 1. DRIVER MOVES / COMES ONLINE
    socket.on('driver_location', async (data) => {
        try {
            // 1. Update Driver Location & Status
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

            // 🟢 2. AUTO-FIX: Check if this driver is stuck in a "Busy" ride and free them
            // If the App sends "driver_location", it means the Driver is on the Home Screen.
            // So if the DB thinks they are in a ride, the DB is wrong. We cancel that ride.
            const stuckRide = await db.query(
                `UPDATE rides SET status = 'CANCELLED' 
                 WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') 
                 RETURNING id`,
                [data.driverId]
            );

            if (stuckRide.rowCount > 0) {
                console.log(`🛠️ FIXED: Auto-cancelled stuck ride ${stuckRide.rows[0].id} for Driver ${data.driverId}. Driver is now FREE.`);
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

    // 2. GET ESTIMATE (Accurate Google Distance)
    socket.on('get_estimate', async (data) => {
        const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
        if (!tripRoute) {
            socket.emit('estimate_error', { msg: "Could not calculate route." });
            return;
        }

        try {
            // Find nearest online driver for ETA (Ignore busy status for estimate)
            const driverRes = await db.query(
                `SELECT id, 
                        ST_Y(location::geometry) as lat, 
                        ST_X(location::geometry) as lng
                 FROM drivers
                 WHERE is_online = true
                 ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                 LIMIT 1`,
                [data.pickupLng, data.pickupLat]
            );

            let approachText = "5 mins"; // Default fallback
            let hasDriver = false;

            if (driverRes.rows.length > 0) {
                hasDriver = true;
                const drv = driverRes.rows[0];
                const approachRoute = await getRouteData(drv.lat, drv.lng, `${data.pickupLat},${data.pickupLng}`);
                if (approachRoute) {
                    approachText = approachRoute.durationText;
                }
            }

            const totalKm = tripRoute.distanceKm;
            let baseFare = totalKm * 30; // ₹30 per km
            if (baseFare < 30) baseFare = 30; 
            const commission = baseFare * 0.10;
            const totalWithCommission = Math.round(baseFare + commission);

            socket.emit('estimate_response', {
                fareUPI: totalWithCommission,
                fareCash: Math.ceil(totalWithCommission / 10) * 10,
                tripDistance: tripRoute.distanceText, // 🟢 Exact Google Distance
                driverDistance: approachText,
                hasDriver: hasDriver,
                polyline: tripRoute.polyline,
                dropLat: tripRoute.endLat,
                dropLng: tripRoute.endLng
            });

        } catch (err) {
            console.error("Estimate Error:", err.message);
            socket.emit('estimate_error', { msg: "Server error calculating estimate." });
        }
    });

    // 3. REQUEST RIDE (With Busy Filter & Logs)
    socket.on('request_ride', async (data) => {
        console.log(`📲 REQUEST RECEIVED: Pickup (${data.pickupLat}, ${data.pickupLng})`);
        
        try {
            // Get Rider Phone
            const riderRes = await db.query(`SELECT phone FROM riders WHERE id = $1`, [data.riderId]);
            const riderPhone = riderRes.rows.length > 0 ? riderRes.rows[0].phone : null;

            // Insert Ride
            const result = await db.query(
                `INSERT INTO rides (rider_id, rider_socket_id, pickup_lat, pickup_lng, drop_lat, drop_lng, fare, status, destination) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8) RETURNING id`,
                [data.riderId || 0, socket.id, data.pickupLat, data.pickupLng, data.dropLat, data.dropLng, data.fare, data.destination]
            );
            const rideId = result.rows[0].id;

            // 🟢 Find Drivers (EXCLUDING BUSY ONES)
            // Debugging: Increased radius to 50km to ensure we find YOU if you are online
            const nearbyDrivers = await db.query(
                `SELECT id, socket_id, fcm_token 
                 FROM drivers 
                 WHERE is_online = true 
                 AND id NOT IN (
                     SELECT driver_id FROM rides 
                     WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP') 
                     AND driver_id IS NOT NULL
                 )
                 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50000)`, 
                [data.pickupLng, data.pickupLat]
            );

            console.log(`🔎 Found ${nearbyDrivers.rows.length} available (free) drivers.`);

            if (nearbyDrivers.rows.length === 0) {
                // Debug log to see if any drivers exist at all
                const allOnline = await db.query(`SELECT count(*) FROM drivers WHERE is_online = true`);
                console.log(`⚠️ DEBUG: Total Online Drivers in DB: ${allOnline.rows[0].count}`);
                console.log(`⚠️ If this number is > 0, they are likely marked as BUSY in the 'rides' table.`);
            }

            const payload = { 
                ...data, 
                ride_id: rideId, 
                rider_id: socket.id,
                riderPhone: riderPhone 
            };

            nearbyDrivers.rows.forEach(driver => {
                console.log(`👉 Sending request to Driver ID ${driver.id} (Socket: ${driver.socket_id})`);
                if (driver.socket_id) {
                    io.to(driver.socket_id).emit('driver_request', payload);
                }
                if (driver.fcm_token) {
                    sendPushNotification(driver.fcm_token, "New Ride Request! 🚖", `Drop: ${data.destination} - ₹${data.fare}`);
                }
            });

        } catch (err) {
            console.error("Request Ride Error:", err.message);
        }
    });

    // 4. ACCEPT RIDE
    socket.on('accept_ride', async (data) => {
        console.log(`✅ Driver ${data.driver_id} ACCEPTED Ride ${data.ride_id}`);
        try {
            await db.query(
                `UPDATE rides SET driver_id = $1, status = 'ACCEPTED' WHERE id = $2`,
                [data.driver_id, data.ride_id]
            );

            const driverInfo = await db.query(`SELECT name, phone FROM drivers WHERE id = $1`, [data.driver_id]);
            const driver = driverInfo.rows[0];

            io.to(data.rider_id).emit('ride_accepted', {
                ride_id: data.ride_id, 
                driverName: driver ? driver.name : "Driver",
                driverPhone: driver ? driver.phone : "0000000000", 
                vehicle: "Auto",
                eta: "5 mins",
                lat: data.driverLat,
                lng: data.driverLng,
                fare: data.fare 
            });

            const pickupRoute = await getRouteData(data.driverLat, data.driverLng, `${data.pickupLat},${data.pickupLng}`);
            const dropRoute = await getRouteData(data.pickupLat, data.pickupLng, `${data.dropLat},${data.dropLng}`);

            socket.emit('ride_started_info', {
                pickupPolyline: pickupRoute ? pickupRoute.polyline : null, 
                dropPolyline: dropRoute ? dropRoute.polyline : null,     
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
            
            if (rideData.rows.length > 0) {
                const driverId = rideData.rows[0].driver_id;
                if (driverId) {
                    const driverRes = await db.query(`SELECT socket_id FROM drivers WHERE id = $1`, [driverId]);
                    if (driverRes.rows.length > 0) {
                        const driverSocket = driverRes.rows[0].socket_id;
                        io.to(driverSocket).emit('ride_cancelled_by_user');
                    }
                }
            }
        } catch (err) {
            console.error("Cancel Logic Error:", err.message);
        }
    });

    // 6. DRIVER ARRIVED
    socket.on('driver_arrived', async (data) => {
        await db.query(`UPDATE rides SET status = 'ARRIVED' WHERE id = $1`, [data.ride_id]);
        
        const targetSocket = data.rider_id || data.rider_socket_id;
        io.to(targetSocket).emit('driver_arrived_notification', {
            msg: "Driver has arrived!",
            dropPolyline: data.dropPolyline 
        });
    });

    // 7. COMPLETE RIDE
    socket.on('complete_ride', async (data) => {
        try {
            await db.query(
                `UPDATE rides SET status = 'COMPLETED', payment_method = $1 WHERE id = $2`,
                [data.paymentMethod, data.ride_id]
            );
            socket.emit('ride_saved_success');
        } catch (err) {
            console.error("Error saving ride:", err);
        }
    });

    // 8. HANDLE VOICE NOTES
    socket.on('send_voice_note', (data) => {
        socket.broadcast.emit('receive_voice_note', {
            audio_data: data.audio_data,
            sender: "User"
        });
    });
});

const PORT = process.env.PORT || 3001; 
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));