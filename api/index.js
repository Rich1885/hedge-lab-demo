// Vercel serverless belépési pont. A handler maga a server.js-ben él — ez a
// fájl csak re-exportálja, hogy a Vercel Node runtime-ja megtalálja. A
// vercel.json rewrite-jai minden útvonalat (/, /app, /api/*) ide irányítanak.
module.exports = require('../server.js')
