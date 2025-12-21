const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  // 🔴 FIXED: Removed "psql" and the single quotes. strictly the URL only.
  connectionString: "postgresql://neondb_owner:npg_RYpbM0WwOg6k@ep-shy-dawn-a45eg2ne-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
  
  // This SSL setting is REQUIRED for cloud databases
  ssl: {
    rejectUnauthorized: false, 
  },
});

pool.on('connect', () => {
    console.log('✅ Connected to Cloud Database (Neon)');
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};