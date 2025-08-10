require('dotenv/config')
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const io = require("socket.io")(server);
const passport = require('passport');
const CustomStrategy = require('passport-custom').Strategy;
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const session = require('express-session');
var FileStore = require('session-file-store')(session);
const { calculateProgressMetricsByEmail } = require('./get_shells');

function calculateWinnings(guessType, guessNumber, actualNumber, bet) {
  let multiplier = 0;

  if (guessType === 'lower') {
    if (actualNumber < guessNumber) multiplier = 2;
  } else if (guessType === 'higher') {
    if (actualNumber > guessNumber) multiplier = 2;
  } else if (guessType === 'exact') {
    if (actualNumber === guessNumber) multiplier = 5;
  } else {
    throw new Error('Invalid guess type');
  }

  return bet * multiplier;
}
app.use(express.static("public"));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const transport = nodemailer.createTransport({
  host: "185.250.37.86", // 185.250.37.86
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: "no-reply@saahild.com", // generated ethereal user
    pass: process.env.MAIL_PASSWORD, // generated ethereal password
  },
  tls: { rejectUnauthorized: false },
});
app.use(session({
  secret: 'some_session_secret',
  store: new FileStore({}),
  resave: false,
  saveUninitialized: false,
}));

passport.serializeUser((user, done) => {
  // create user db entry here

  done(null, user.email);
});

passport.deserializeUser(async (email, done) => {
  // Here you would fetch user from DB by email
  // For demo just return the email as user object
  // "For demo" womp womp
  done(null, { email, shells: await calculateProgressMetricsByEmail(email) });
});
passport.use('magic-link', new CustomStrategy((req, done) => {
  const token = req.query.token;
  if (!token) {
    return done(null, false, { message: 'No token provided' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Here you could look up the user in your DB or create user if not exists
    const user = { email: payload.email };
    return done(null, user);
  } catch (err) {
    return done(null, false, { message: 'Invalid or expired token' });
  }
}));

// Step 1: Send magic link email
app.post('/send-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send('Email required');

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '15m' });
  const magicLink = `http://localhost:3001/magic-login?token=${token}`;

  try {
    await transport.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your Magic Login Link',
      html: `<p>Click to log in: <a href="${magicLink}">${magicLink}</a></p>`,
    });
    res.send('Magic link sent! Check your email.');
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).send('Failed to send email');
  }
});

// Step 2: Authenticate with magic link
app.get('/magic-login',
  passport.authenticate('magic-link', {
    failureRedirect: '/login',
    successRedirect: '/gamble',
  })
);
app.set("view engine", "ejs");
app.get("/gamble", (req, res) => {
  console.log(req.session)
  if (!req.session.passport) {
    return res.redirect('/login');
  }
  res.render("index", { title: "Shipwrecked" });
});
app.get('/login', (req, res) => {
  res.render('login')
})

io.on("connection", (socket) => {
  // socket.emit
  // socket.on

});
server.listen(3001, () => {
  console.log(`Server is running on http://localhost:3001`);
});
