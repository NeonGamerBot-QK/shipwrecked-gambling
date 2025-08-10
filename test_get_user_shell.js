require('dotenv/config')
const { Pool } = require('pg')
const shippg = new Pool({
    connectionString: process.env.SHIPWRECKED_PSQL_URL,
});
shippg.query(`select * from "User" where email = 'neon@saahild.com'`).then(d => {
    console.log(d.rows)
    const dd = d.rows[0]
    console.log(`Correct total shells: ${Math.max(0, 0 - dd.totalShellsSpent + dd.adminShellAdjustment)}`)
})