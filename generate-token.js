require('dotenv').config();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

const payload = { user: 'netsuite-client' };
const token = jwt.sign(payload, JWT_SECRET);

console.log(token);