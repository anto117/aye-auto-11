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
const GOOGLE_API_KEY = "AIzaSyCb3i7_Y_jvTtwyni1SwucLoDayMqqrmJ8"; 

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
        console.log(`📲 Notification sent.`);
    } catch (e) {
        console.error("Notification Error:", e.message);
    }
}

// 🟢 SOCKET.IO LOGIC
io.on('connection', (socket) => {
    console.log(`⚡ Client: ${socket.id}`);

    // 🟢 1. DRIVER MOVES / COMES ONLINE
    // (UPDATED: Removed the pending ride popup logic)
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
            // 🟢 Removed pending ride check here to stop auto-popups
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

    // 🟢 2. GET ESTIMATE
    socket.on('get_estimate', async (data) => {
        const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
        if (!tripRoute) {
            socket.emit('estimate_error', { msg: "Could not calculate route." });
            return;
        }

        try {
            const driverRes = await db.query(
                `SELECT id, 
                        ST_Y(location::geometry) as lat, 
                        ST_X(location::geometry) as lng, 
                        ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance_m
                 FROM drivers
                 WHERE is_online = true
                 ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                 LIMIT 1`,
                [data.pickupLng, data.pickupLat]
            );

            let nearestDriver = null;
            let approachKm = 0;
            let approachText = "0 km";

            if (driverRes.rows.length > 0) {
                nearestDriver = driverRes.rows[0];
                const approachRoute = await getRouteData(nearestDriver.lat, nearestDriver.lng, `${data.pickupLat},${data.pickupLng}`);
                if (approachRoute) {
                    approachKm = approachRoute.distanceKm;
                    approachText = approachRoute.distanceText;
                }
            }

            const totalKm = approachKm + tripRoute.distanceKm;
            let baseFare = totalKm * 30;
            if (baseFare < 30) baseFare = 30; 
            const commission = baseFare * 0.10;
            const totalWithCommission = baseFare + commission;

            socket.emit('estimate_response', {
                fareUPI: Math.round(totalWithCommission),
                fareCash: Math.ceil(totalWithCommission / 10) * 10,
                baseFare: Math.round(baseFare),
                tripDistance: tripRoute.distanceText,
                driverDistance: approachText,
                hasDriver: nearestDriver != null,
                polyline: tripRoute.polyline,
                dropLat: tripRoute.endLat,
                dropLng: tripRoute.endLng
            });

        } catch (err) {
            console.error("Estimate Error:", err.message);
            socket.emit('estimate_error', { msg: "Server error calculating estimate." });
        }
    });

    // 🟢 3. REQUEST RIDE
    socket.on('request_ride', async (data) => {
        console.log("📲 Ride Requested by:", socket.id);
        
        try {
            const result = await db.query(
                `INSERT INTO rides (rider_id, rider_socket_id, pickup_lat, pickup_lng, drop_lat, drop_lng, fare, status, destination) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', $8) RETURNING id`,
                [
                    data.riderId || 0, 
                    socket.id, // Save Socket ID for replies
                    data.pickupLat, 
                    data.pickupLng, 
                    data.dropLat, 
                    data.dropLng, 
                    data.fare,
                    data.destination || "Pinned Location"
                ]
            );
            const rideId = result.rows[0].id;

            const nearbyDrivers = await db.query(
                `SELECT socket_id, fcm_token 
                 FROM drivers 
                 WHERE is_online = true 
                 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 5000)`, 
                [data.pickupLng, data.pickupLat]
            );

            const payload = { ...data, ride_id: rideId, rider_id: socket.id };

            nearbyDrivers.rows.forEach(driver => {
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

    // 🟢 4. ACCEPT RIDE (Sends Driver Info)
    socket.on('accept_ride', async (data) => {
        try {
            await db.query(
                `UPDATE rides SET driver_id = $1, status = 'ACCEPTED' WHERE id = $2`,
                [data.driver_id, data.ride_id]
            );

            // Get Driver Details
            const driverInfo = await db.query(`SELECT name, phone FROM drivers WHERE id = $1`, [data.driver_id]);
            const driver = driverInfo.rows[0];

            io.to(data.rider_id).emit('ride_accepted', {
                driverName: driver ? driver.name : "Driver",
                driverPhone: driver ? driver.phone : "9876543210", 
                vehicle: "Auto",
                rating: "4.9",
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

    // 🟢 5. CANCEL RIDE
    // 🟢 5. CANCEL RIDE (Updated with Debug Logs)
    // 🟢 5. CANCEL RIDE (Debugging Version)
    socket.on('cancel_ride', async (data) => {
        console.log(`⚠️ Cancel Request Received for Ride ID:`, data.ride_id);

        if (!data.ride_id) {
            console.error("❌ Cancel Error: No ride_id provided in request.");
            return;
        }

        try {
            // 1. Update DB Status
            await db.query(`UPDATE rides SET status = 'CANCELLED' WHERE id = $1`, [data.ride_id]);
            console.log(`✅ Database updated to CANCELLED for Ride ${data.ride_id}`);

            // 2. Find the Driver for this ride
            const rideData = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [data.ride_id]);
            
            if (rideData.rows.length > 0) {
                const driverId = rideData.rows[0].driver_id;
                
                if (driverId) {
                    console.log(`👉 Ride was assigned to Driver ID: ${driverId}`);

                    // 3. Find Driver's CURRENT Socket ID
                    const driverRes = await db.query(`SELECT socket_id FROM drivers WHERE id = $1`, [driverId]);
                    
                    if (driverRes.rows.length > 0) {
                        const driverSocket = driverRes.rows[0].socket_id;
                        console.log(`📲 Sending 'ride_cancelled_by_user' to Socket: ${driverSocket}`);
                        
                        // 4. Send Notification
                        io.to(driverSocket).emit('ride_cancelled_by_user');
                    } else {
                        console.log("⚠️ Driver found in DB but has no active socket ID recorded.");
                    }
                } else {
                    console.log("ℹ️ No driver had accepted this ride yet (driver_id is null).");
                }
            } else {
                console.log("❌ Ride ID not found in database.");
            }
        } catch (err) {
            console.error("Cancel Logic Error:", err.message);
        }
    });
    // 🟢 6. DRIVER ARRIVED
    socket.on('driver_arrived', async (data) => {
        await db.query(`UPDATE rides SET status = 'ARRIVED' WHERE id = $1`, [data.ride_id]);
        
        const targetSocket = data.rider_id || data.rider_socket_id;
        io.to(targetSocket).emit('driver_arrived_notification', {
            msg: "Driver has arrived!",
            dropPolyline: data.dropPolyline 
        });
    });

    // 🟢 7. COMPLETE RIDE
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
});

const PORT = process.env.PORT || 3001; 
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));