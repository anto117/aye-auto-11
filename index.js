const express = require('express');
const cors = require('cors');
const http = require('http'); 
const axios = require('axios'); 
const { Server } = require("socket.io");
const db = require('./config/db'); 
const admin = require("firebase-admin"); 
const path = require('path'); // Required for Admin Panel
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
app.get('/api/admin/drivers', async (req, res) => {
    try {
        const result = await db.query("SELECT id, name, phone, vehicle_details, is_verified, is_online FROM drivers ORDER BY id DESC");
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
            io.emit('admin_driver_update', { 
                id: data.driverId, 
                lat: data.lat, 
                lng: data.lng, 
                heading: data.heading 
            });
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

    // 2. GET ESTIMATE (Unchanged)
    socket.on('get_estimate', async (data) => {
        try {
            const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
            
            if (!tripRoute) {
                socket.emit('estimate_error', { msg: "Could not calculate route." });
                return;
            }

            // Fare Calculation (Fixed ₹30/km)
            let baseFare = tripRoute.distanceKm * 30; 
            if (baseFare < 30) baseFare = 30; 
            const finalFare = Math.round(baseFare); 

            socket.emit('estimate_response', {
                fareUPI: finalFare,
                tripDistance: tripRoute.distanceText,
                dropLat: tripRoute.endLat,
                dropLng: tripRoute.endLng,
                polyline: tripRoute.polyline
            });

        } catch (err) {
            console.error("Estimate Error:", err.message);
        }
    });

    // 🟢 3. REQUEST RIDE (Starts with 2km)
    socket.on('request_ride', async (data) => {
        console.log(`🚀 New Ride Request from Rider ${data.riderId}`);

        try {
            const riderRes = await db.query(`SELECT phone FROM riders WHERE id = $1`, [data.riderId]);
            const riderPhone = riderRes.rows.length > 0 ? riderRes.rows[0].phone : null;

            // 1. Save Request to DB
            const result = await db.query(
                `INSERT INTO rides (rider_id, rider_socket_id, pickup_lat, pickup_lng, drop_lat, drop_lng, destination, fare, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED') RETURNING id`,
                [data.riderId, socket.id, data.pickupLat, data.pickupLng, data.dropLat, data.dropLng, data.destination, data.fare]
            );
            
            const rideId = result.rows[0].id;
            const riderSocketId = socket.id;
            const ridePayload = { ...data, ride_id: rideId, rider_id: riderSocketId, riderPhone: riderPhone };

            // 2. Start Phase 1 Search (2km Radius)
            startDriverSearch(rideId, ridePayload, 2000, [], riderSocketId);

        } catch (err) { console.error("Request Error:", err); }
    });

    // 🟢 HELPER: Recursive Driver Search
    async function startDriverSearch(rideId, rideData, radius, notifiedDriverIds, riderSocketId) {
        console.log(`🔎 Searching drivers for Ride ${rideId} within ${radius}m...`);

        try {
            // Check if ride is still valid (not cancelled/accepted)
            const statusCheck = await db.query("SELECT status FROM rides WHERE id = $1", [rideId]);
            if (statusCheck.rows.length === 0 || statusCheck.rows[0].status !== 'REQUESTED') {
                return; // Stop logic
            }

            // Find nearest 10 drivers in radius, excluding already notified ones
            // Also calculates real-time distance from driver to pickup
            const nearbyDrivers = await db.query(
                `SELECT id, socket_id, fcm_token, 
                        ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as dist_meters
                 FROM drivers 
                 WHERE is_online = true 
                 AND id != ALL($3::int[]) 
                 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $4)
                 ORDER BY dist_meters ASC
                 LIMIT 10`,
                [rideData.pickupLng, rideData.pickupLat, notifiedDriverIds, radius]
            );

            if (nearbyDrivers.rows.length > 0) {
                console.log(`Found ${nearbyDrivers.rows.length} new drivers. Sending requests...`);
                
                nearbyDrivers.rows.forEach(driver => {
                    notifiedDriverIds.push(driver.id); // Add to exclusion list
                    
                    // Send request with dynamic distance label
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

            // 🟢 CASCADING LOGIC (TIMERS)
            
            // Phase 1 (2000m) -> Wait 15s -> Go to Phase 2 (5000m)
            if (radius === 2000) {
                const timer = setTimeout(() => {
                    console.log("⏰ Phase 1 ended. Expanding to 5km...");
                    // 2000m + 3000m = 5000m
                    startDriverSearch(rideId, rideData, 5000, notifiedDriverIds, riderSocketId);
                }, 15000); 
                rideTimers.set(rideId, timer);
            } 
            // Phase 2 (5000m) -> Wait 15s -> Timeout
            else if (radius === 5000) {
                const timer = setTimeout(async () => {
                    console.log("⏰ Phase 2 ended. No drivers found.");
                    
                    // Mark ride as timeout
                    await db.query("UPDATE rides SET status = 'TIMEOUT' WHERE id = $1 AND status = 'REQUESTED'", [rideId]);
                    
                    // Tell Rider
                    io.to(riderSocketId).emit('ride_timeout');
                    rideTimers.delete(rideId);
                }, 15000); 
                rideTimers.set(rideId, timer);
            }

        } catch (err) {
            console.error("Search Logic Error:", err);
        }
    }

    // 🟢 4. ACCEPT RIDE (Stops the Timer)
    socket.on('accept_ride', async (data) => {
        console.log(`Attempting to accept ride: ${data.ride_id}`);
        
        try {
            // ATOMIC UPDATE
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

            // ✅ STOP THE SEARCH TIMER
            if (rideTimers.has(data.ride_id)) {
                clearTimeout(rideTimers.get(data.ride_id));
                rideTimers.delete(data.ride_id);
                console.log(`🛑 Timer cancelled for Ride ${data.ride_id}`);
            }

            // Fetch Driver Info
            const driverInfo = await db.query(`SELECT name, phone FROM drivers WHERE id = $1`, [data.driver_id]);
            const driver = driverInfo.rows[0];

            // Notify Rider
            io.to(data.rider_id).emit('ride_accepted', {
                ride_id: data.ride_id, 
                driverName: driver ? driver.name : "Driver",
                driverPhone: driver ? driver.phone : "0000000000", 
                vehicle: "Auto", eta: "5 mins",
                lat: data.driverLat, lng: data.driverLng, fare: data.fare 
            });

            // Notify Driver
            socket.emit('ride_booking_success', { ride_id: data.ride_id });

            // Send Route
            const pickupRoute = await getRouteData(data.driverLat, data.driverLng, `${data.pickupLat},${data.pickupLng}`);
            socket.emit('ride_started_info', { 
                pickupPolyline: pickupRoute ? pickupRoute.polyline : null, 
                totalFare: data.fare 
            });

        } catch (err) { 
            console.error("Accept Ride Error:", err.message); 
        }
    });

    // 🟢 5. CANCEL RIDE (Stops the Timer)
    socket.on('cancel_ride', async (data) => {
        console.log(`Ride ${data.ride_id} cancelled by user`);
        await db.query("UPDATE rides SET status = 'CANCELLED' WHERE id = $1", [data.ride_id]);
        
        // Stop the search timer
        if (rideTimers.has(data.ride_id)) {
            clearTimeout(rideTimers.get(data.ride_id));
            rideTimers.delete(data.ride_id);
        }

        // Notify Driver if one was assigned
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

const PORT = process.env.PORT || 3001; 
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));