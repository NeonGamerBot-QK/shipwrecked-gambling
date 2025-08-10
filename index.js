const express = require('express')
const app = express()

app.use(express.static('public'))
app.use(express.json())

app.set('view engine', 'ejs')
app.get('/', (req, res) => {
    res.render('index', { title: 'Shipwrecked' })
})


app.listen(3001, () => {
    console.log(`Server is running on http://localhost:3001`)
})