"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/lib/db.ts
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});
exports.default = pool;
