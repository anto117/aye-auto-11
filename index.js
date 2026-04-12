const express = require('express');
const cors = require('cors');
const http = require('http'); 
const axios = require('axios'); 
const { Server } = require("socket.io");
const db = require('./config/db'); 
const admin = require("firebase-admin"); 
const path = require('path'); 
const cron = require('node-cron');
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

// 🟢 SERVE ADMIN PANEL
app.use(express.static(path.join(__dirname, 'public')));

// --- ADMIN API ROUTES ---
// --- ADMIN API ROUTES ---
app.get('/api/admin/drivers', async (req, res) => {
    try {
        // 🟢 Updated to pull the new Image URLs and Age
        const result = await db.query("SELECT id, name, phone, age, vehicle_type, vehicle_details, license_url, rc_url, is_verified, is_online FROM drivers ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) { 
        console.error("Admin Driver Fetch Error:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/admin/pending-rides', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT r.id, r.rider_id, r.pickup_lat, r.pickup_lng, r.destination, r.fare, r.status, riders.name as rider_name, riders.phone as rider_phone
            FROM rides r
            LEFT JOIN riders ON r.rider_id = riders.id
            WHERE r.status = 'REQUESTED'
            ORDER BY r.id DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/verify-driver', async (req, res) => {
    const { driverId, status } = req.body; 
    try {
        await db.query("UPDATE drivers SET is_verified = $1 WHERE id = $2", [status, driverId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/rides', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT r.id, r.fare, r.status, d.name as driver_name 
            FROM rides r 
            LEFT JOIN drivers d ON r.driver_id = d.id 
            ORDER BY r.id DESC LIMIT 50
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- APP ROUTES ---
const authRoutes = require('./routes/authRoutes'); 
const driverRoutes = require('./routes/driverRoutes'); 
const riderAuthRoutes = require('./routes/riderAuthRoutes'); 

app.use('/api/driver', driverRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/rider-auth', riderAuthRoutes); 

const io = new Server(server, { cors: { origin: "*" } });
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; 

// 🧹 AUTO-CLEANUP: Set all drivers offline when the server boots up
db.query("UPDATE drivers SET is_online = false").then(() => {
    console.log("🧹 Wiped all Ghost Drivers! Database is clean.");
}).catch(err => console.error("Cleanup error:", err));

// 🟢 GLOBAL MAP TO MANAGE DISPATCH TIMERS
const rideTimers = new Map();

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
    } catch (e) {
        console.error("Notification Error:", e.message);
    }
}

// 🟢 SOCKET.IO LOGIC
io.on('connection', (socket) => {
    console.log(`⚡ Client Connected: ${socket.id}`);

    // 1. DRIVER LOCATION
    socket.on('driver_location', async (data) => {
        try {
            // 🟢 NEW FIX: Remove this socket ID from any previous accounts first
            await db.query(`UPDATE drivers SET is_online = false, socket_id = NULL WHERE socket_id = $1`, [socket.id]);

            // Now update the correct, current driver
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

            const activeRide = await db.query(
                `SELECT id, status, destination FROM rides 
                 WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP')`,
                [data.driverId]
            );

            let driverStatus = "Free";
            let currentRideDest = null;

            if (activeRide.rows.length > 0) {
                driverStatus = activeRide.rows[0].status;
                currentRideDest = activeRide.rows[0].destination;
            }

            io.emit('admin_driver_update', { 
                id: data.driverId, 
                lat: data.lat, 
                lng: data.lng, 
                heading: data.heading,
                status: driverStatus,
                destination: currentRideDest
            });

        } catch (err) {
            console.error("Geo Update Error:", err.message);
        }
    });
    // 10. SAVE RIDER FCM TOKEN FOR MARKETING
    socket.on('update_fcm_token', async (data) => {
        try {
            await db.query("UPDATE riders SET fcm_token = $1 WHERE id = $2", [data.token, data.riderId]);
            console.log(`📱 Saved FCM Token for Rider ${data.riderId}`);
        } catch(e) { 
            console.error("Token Save Error:", e.message); 
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
        try {
            const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
            
            if (!tripRoute) {
                socket.emit('estimate_error', { msg: "Could not calculate route." });
                return;
            }

            // 🟢 Auto Fare Calculation (₹30/km)
            let baseFareAuto = tripRoute.distanceKm * 30; 
            if (baseFareAuto < 30) baseFareAuto = 30; 
            const finalFareAuto = Math.round(baseFareAuto); 

            // 🟢 Bike Fare Calculation (₹8/km)
            let baseFareBike = tripRoute.distanceKm * 8; 
            if (baseFareBike < 20) baseFareBike = 20; // Minimum ₹20 fare
            const finalFareBike = Math.round(baseFareBike); 

            socket.emit('estimate_response', {
                fareUPI: finalFareAuto,   // Sends Auto fare
                fareBike: finalFareBike,  // explicitly sends new Bike fare
                tripDistance: tripRoute.distanceText,
                dropLat: tripRoute.endLat,
                dropLng: tripRoute.endLng,
                polyline: tripRoute.polyline
            });

        } catch (err) {
            console.error("Estimate Error:", err.message);
        }
    });

    // 3. REQUEST RIDE
    socket.on('request_ride', async (data) => {
        console.log(`🚀 New Ride Request from Rider ${data.riderId} for a ${data.vehicleType || 'Auto'}`);

        try {
            const riderRes = await db.query(`SELECT phone FROM riders WHERE id = $1`, [data.riderId]);
            const riderPhone = riderRes.rows.length > 0 ? riderRes.rows[0].phone : null;

            // 🟢 NEW: Insert the requested vehicle_type into the rides table
            const result = await db.query(
                `INSERT INTO rides (rider_id, rider_socket_id, pickup_lat, pickup_lng, drop_lat, drop_lng, destination, fare, status, vehicle_type) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED', $9) RETURNING id`,
                [data.riderId, socket.id, data.pickupLat, data.pickupLng, data.dropLat, data.dropLng, data.destination, data.fare, data.vehicleType || 'Auto']
            );
            
            const rideId = result.rows[0].id;
            const riderSocketId = socket.id;
            const ridePayload = { ...data, ride_id: rideId, rider_id: riderSocketId, riderPhone: riderPhone };

            startDriverSearch(rideId, ridePayload, 5000, [], riderSocketId);

        } catch (err) { console.error("Request Error:", err); }
    });

    // 🟢 HELPER: Driver Search with FIXED TIMEOUT LOGIC
   // 🟢 UPGRADED HELPER: Driver Search with SPINNING RADAR LOGIC
async function startDriverSearch(rideId, rideData, radius, notifiedDriverIds, riderSocketId) {
    console.log(`📡 Starting Radar for ${rideData.vehicleType || 'Auto'} drivers for Ride ${rideId}...`);

    let attempts = 0;
    const maxAttempts = 12; // 12 pings * 5 seconds = 60 seconds timeout

    // Create a looping interval that runs every 5 seconds
    const radarInterval = setInterval(async () => {
        attempts++;

        try {
            // 1. Is the ride still pending?
            const statusCheck = await db.query("SELECT status FROM rides WHERE id = $1", [rideId]);
            if (statusCheck.rows.length === 0 || statusCheck.rows[0].status !== 'REQUESTED') {
                clearInterval(radarInterval); // Stop the radar
                rideTimers.delete(rideId);
                return; 
            }

            // 2. Have we searched for 60 seconds? (Timeout)
            if (attempts > maxAttempts) {
                clearInterval(radarInterval);
                rideTimers.delete(rideId);
                await db.query("UPDATE rides SET status = 'TIMEOUT' WHERE id = $1", [rideId]);
                io.to(riderSocketId).emit('no_drivers_found'); 
                console.log(`Ride ${rideId} timed out (No drivers found after 60s).`);
                return;
            }

            // 3. Ping the database for drivers
            const nearbyDrivers = await db.query(
                `SELECT id, socket_id, fcm_token, 
                        ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as dist_meters
                 FROM drivers 
                 WHERE is_online = true 
                 AND vehicle_type = $5 
                 AND id != ALL($3::int[]) 
                 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $4)
                 ORDER BY dist_meters ASC
                 LIMIT 5`,
                [rideData.pickupLng, rideData.pickupLat, notifiedDriverIds, radius, rideData.vehicleType || 'Auto']
            );

            // 4. Send requests to any newly found drivers
            if (nearbyDrivers.rows.length > 0) {
                console.log(`Radar Sweep ${attempts}: Found ${nearbyDrivers.rows.length} new driver(s)! Pinging them now...`);
                
                nearbyDrivers.rows.forEach(driver => {
                    notifiedDriverIds.push(driver.id); 
                    const distKm = (driver.dist_meters / 1000).toFixed(1);
                    
                    io.to(driver.socket_id).emit('driver_request', {
                        ...rideData,
                        distance: `${distKm} km to pickup` 
                    });

                    if (driver.fcm_token) {
                        sendPushNotification(driver.fcm_token, "New Ride Request! 🚖", `Pickup is ${distKm} km away`);
                    }
                });
            }

        } catch (err) {
            console.error("Radar Logic Error:", err);
        }
    }, 5000); // 5000ms = sweeps every 5 seconds

    // Save this interval ID so we can cancel it if a driver accepts!
    rideTimers.set(rideId, radarInterval);
}

    // 4. ACCEPT RIDE
    socket.on('accept_ride', async (data) => {
        console.log(`Attempting to accept ride: ${data.ride_id}`);
        
        try {
            // ATOMIC UPDATE (Prevents double booking)
            const result = await db.query(
                `UPDATE rides 
                 SET driver_id = $1, status = 'ACCEPTED' 
                 WHERE id = $2 AND status = 'REQUESTED' 
                 RETURNING *`, 
                [data.driver_id, data.ride_id]
            );

            if (result.rowCount === 0) {
                socket.emit('ride_booking_failed', { msg: "Ride already booked or cancelled" });
                return; 
            }

            // ✅ STOP THE SEARCH TIMER (Now this works because we saved it!)
            if (rideTimers.has(data.ride_id)) {
                clearInterval(rideTimers.get(data.ride_id));
                rideTimers.delete(data.ride_id);
                console.log(`🛑 Timer cancelled for Ride ${data.ride_id}`);
            }

            const driverInfo = await db.query(`SELECT name, phone FROM drivers WHERE id = $1`, [data.driver_id]);
            const driver = driverInfo.rows[0];
            const acceptedRide = result.rows[0];
          io.to(acceptedRide.rider_socket_id).emit('ride_accepted', {
                ride_id: data.ride_id, 
                driverName: driver ? driver.name : "Driver",
                driverPhone: driver ? driver.phone : "0000000000", 
                vehicle: acceptedRide.vehicle_type, // 🟢 Fixes the "Auto" hardcoding bug!
                eta: "5 mins",
                lat: data.driverLat, 
                lng: data.driverLng, 
                fare: acceptedRide.fare 
            });

            socket.emit('ride_booking_success', { ride_id: data.ride_id });

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
        console.log(`Ride ${data.ride_id} cancelled by user`);
        await db.query("UPDATE rides SET status = 'CANCELLED' WHERE id = $1", [data.ride_id]);
        
        // Stop the search timer
        if (rideTimers.has(data.ride_id)) {
            clearInterval(rideTimers.get(data.ride_id));
            rideTimers.delete(data.ride_id);
        }

        const rideData = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [data.ride_id]);
        if (rideData.rows.length > 0 && rideData.rows[0].driver_id) {
             const driverRes = await db.query(`SELECT socket_id FROM drivers WHERE id = $1`, [rideData.rows[0].driver_id]);
             if (driverRes.rows.length > 0) io.to(driverRes.rows[0].socket_id).emit('ride_cancelled_by_user');
        }
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

            const rideData = await db.query(`SELECT rider_socket_id FROM rides WHERE id = $1`, [data.ride_id]);
            if (rideData.rows.length > 0) {
                io.to(rideData.rows[0].rider_socket_id).emit('ride_completed', { ride_id: data.ride_id });
            }
        } catch (err) { console.error("Error completing ride:", err); }
    });

    // 8. SUBMIT RATING
    socket.on('submit_rating', async (data) => {
        try {
            await db.query(`UPDATE rides SET rating = $1, feedback = $2 WHERE id = $3`, [data.rating, data.comment, data.ride_id]);
        } catch(e) { console.error("Rating Error", e.message); }
    });
});
// 📢 AUTOMATED MARKETING ENGINE
// The syntax '0 17 * * 5' means: Minute 0, Hour 17 (5 PM), Any day of month, Any month, Day 5 (Friday)
cron.schedule('* * * * *', async () => {
    console.log("⏰ Running Friday Evening Promo Campaign...");
    
    try {
        // 1. Get all users who have notifications enabled
        const result = await db.query("SELECT fcm_token FROM riders WHERE fcm_token IS NOT NULL");
        
        if (result.rows.length > 0) {
            console.log(`Sending promos to ${result.rows.length} users...`);
            
            // 2. Loop through and blast the notification!
            result.rows.forEach(user => {
                sendPushNotification(
                    user.fcm_token, 
                    "TGIF! 🎉", 
                    "Kick off your weekend! Book an Aye Bike to beat the Friday evening traffic."
                );
            });
        }
    } catch (err) {
        console.error("Marketing Cron Error:", err.message);
    }
});

const PORT = process.env.PORT || 3001; 
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));