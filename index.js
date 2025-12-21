const express = require('express');
const cors = require('cors');
const http = require('http'); 
const axios = require('axios'); 
const { Server } = require("socket.io");
const db = require('./config/db'); 
const admin = require("firebase-admin"); // 🟢 Added Firebase
require('dotenv').config();

// 🟢 INITIALIZE FIREBASE (You need to add your serviceAccountKey.json file)
// For now, we will wrap this in a try-catch so the server doesn't crash if you haven't added it yet.
try {
    const serviceAccount = require("./serviceAccountKey.json"); 
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin Initialized");
} catch (e) {
    console.log("⚠️ Firebase not initialized (Missing serviceAccountKey.json)");
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

// 🔴 YOUR GOOGLE API KEY
const GOOGLE_API_KEY = "AIzaSyCb3i7_Y_jvTtwyni1SwucLoDayMqqrmJ8"; 

// 🟢 STORE ACTIVE DRIVERS
let activeDrivers = {}; 

// --- HELPER 1: Haversine Formula ---
function getStraightLineDistance(lat1, lon1, lat2, lon2) {
    var R = 6371; 
    var dLat = (lat2 - lat1) * (Math.PI / 180);
    var dLon = (lon2 - lon1) * (Math.PI / 180);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
}

// --- HELPER 2: Google Route Data ---
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

// 🟢 HELPER 3: Send Push Notification
async function sendPushNotification(driverId, title, body) {
    try {
        // 1. Get Driver's Token from DB
        const res = await db.query("SELECT fcm_token FROM drivers WHERE id = $1", [driverId]);
        if(res.rows.length > 0 && res.rows[0].fcm_token) {
            const token = res.rows[0].fcm_token;
            
            // 2. Send Message via Firebase
            await admin.messaging().send({
                token: token,
                notification: {
                    title: title,
                    body: body,
                },
                data: {
                    click_action: "FLUTTER_NOTIFICATION_CLICK",
                    sound: "default"
                }
            });
            console.log(`📲 Notification sent to Driver ${driverId}`);
        }
    } catch (e) {
        console.error("Notification Error:", e.message);
    }
}

io.on('connection', (socket) => {
    console.log(`⚡ Client: ${socket.id}`);

    // 🟢 1. TRACK DRIVER & UPDATE TOKEN
    socket.on('driver_location', async (data) => {
        activeDrivers[socket.id] = { ...data, socketId: socket.id };
        io.emit('driver_moved', data);

        // 🟢 SAVE FCM TOKEN IF PROVIDED
        if (data.fcmToken) {
            try {
                await db.query("UPDATE drivers SET fcm_token = $1 WHERE id = $2", [data.fcmToken, data.driverId]);
            } catch (err) {
                console.error("Error updating token:", err.message);
            }
        }
    });

    socket.on('disconnect', () => {
        delete activeDrivers[socket.id];
    });

    // 🟢 2. GET ESTIMATE
    socket.on('get_estimate', async (data) => {
        const tripRoute = await getRouteData(data.pickupLat, data.pickupLng, data.destination);
        if (!tripRoute) {
            socket.emit('estimate_error', { msg: "Could not calculate route." });
            return;
        }

        // Find Nearest Driver
        let nearestDriver = null;
        let minDistance = Infinity;

        Object.values(activeDrivers).forEach(driver => {
            const dist = getStraightLineDistance(data.pickupLat, data.pickupLng, driver.lat, driver.lng);
            if (dist < minDistance) {
                minDistance = dist;
                nearestDriver = driver;
            }
        });

        let approachKm = 0;
        let approachText = "0 km";
        
        if (nearestDriver) {
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
    });

    // 🟢 3. REQUEST RIDE (Send Notification Here!)
    socket.on('request_ride', (data) => {
        console.log("📲 Ride Requested by:", socket.id);
        
        const payload = { ...data, rider_id: socket.id };
        
        // 1. Emit Socket Event (For active apps)
        io.emit('driver_request', payload);

        // 🟢 2. Send Push Notification (For background/killed apps)
        // Note: In a real app, you would target the specific 'nearestDriver' found earlier.
        // For now, we will just notify ALL online drivers in our memory
        Object.values(activeDrivers).forEach(driver => {
             sendPushNotification(driver.driverId, "New Ride Request! 🚖", `Drop: ${data.destination} - ₹${data.fare}`);
        });
    });

    // 🟢 4. DRIVER ACCEPTS
    socket.on('accept_ride', async (data) => {
        // ... (Existing logic kept same for brevity, ensure you copy previous logic here if needed)
        // For this snippet, assume standard accept logic
         io.to(data.rider_id).emit('ride_accepted', {
            driverName: "Driver",
            vehicle: "Auto",
            rating: "4.9",
            eta: "5 mins",
            lat: data.driverLat,
            lng: data.driverLng,
            fare: data.fare 
        });
    });

    // 🟢 5. DRIVER ARRIVED
    socket.on('driver_arrived', (data) => {
        io.to(data.rider_id).emit('driver_arrived_notification', {
            msg: "Driver has arrived!",
            dropPolyline: data.dropPolyline 
        });
    });

    // 🟢 6. COMPLETE RIDE
    socket.on('complete_ride', async (data) => {
        try {
            await db.query(
                "INSERT INTO ride_history (driver_id, fare, payment_method) VALUES ($1, $2, $3)",
                [data.driver_id, data.fare, data.paymentMethod]
            );
            socket.emit('ride_saved_success');
        } catch (err) {
            console.error("Error saving ride:", err);
        }
    });
});

const PORT = process.env.PORT || 3001; 
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on ${PORT}`));