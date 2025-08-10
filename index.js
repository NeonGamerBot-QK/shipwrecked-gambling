require("dotenv/config");
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: "*", // adjust to your frontend origin
  },
});
const passport = require("passport");
const CustomStrategy = require("passport-custom").Strategy;
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const session = require("express-session");
var FileStore = require("session-file-store")(session);
const Keyv = require("keyv");
const SQLite = require("@keyv/sqlite");
const sqliteAdapter = new SQLite.default({
  uri: "sqlite://./my-keyv-database.db", // database file path
});

// Initialize Keyv with SQLite adapter
const keyv = new Keyv.Keyv({ store: sqliteAdapter });

const { calculateProgressMetricsByEmail } = require("./get_shells");
const players = new Map(); // socketId => player object
const gameState = {
  // Shared table state
  currentCard: null,
  nextCard: null,
  roundState: "waiting", // 'awaitingBet', 'awaitingGuess', 'resolved'
  message: "",
  // For simplicity, bankrolls per player stored individually
};

// Utility for deck
const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
const ranks = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

function drawRandomCard() {
  const rank = ranks[Math.floor(Math.random() * ranks.length)];
  const suit = suits[Math.floor(Math.random() * suits.length)];
  return { rank, suit };
}

// Simple card rank order for comparison
function rankValue(card) {
  return ranks.indexOf(card.rank);
}

app.use(express.static("public"));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";
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
app.use(
  session({
    secret: "some_session_secret",
    store: new FileStore({}),
    resave: false,
    saveUninitialized: false,
  }),
);

passport.serializeUser((user, done) => {
  // create user db entry here
  // keyv.set(user.email, user);
  done(null, user.email);
});

passport.deserializeUser(async (email, done) => {
  // Here you would fetch user from DB by email
  // For demo just return the email as user object
  // "For demo" womp womp
  done(null, { email });
});
passport.use(
  "magic-link",
  new CustomStrategy((req, done) => {
    const token = req.query.token;
    if (!token) {
      return done(null, false, { message: "No token provided" });
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      // Here you could look up the user in your DB or create user if not exists
      const user = { email: payload.email };
      return done(null, user);
    } catch (err) {
      return done(null, false, { message: "Invalid or expired token" });
    }
  }),
);

// Step 1: Send magic link email
app.post("/send-link", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send("Email required");

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "15m" });
  const magicLink = `http://shipwrecked-gamble.saahild.com/magic-login?token=${token}`;

  try {
    await transport.sendMail({
      from: `no-reply@saahild.com`,
      to: email,
      subject: "Your Magic Login Link",
      html: `<p>Click to log in: <a href="${magicLink}">${magicLink}</a></p>`,
    });
    res.send("Magic link sent! Check your email.");
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).send("Failed to send email");
  }
});

// Step 2: Authenticate with magic link
app.get(
  "/magic-login",
  passport.authenticate("magic-link", {
    failureRedirect: "/login",
    successRedirect: "/gamble",
  }),
);
app.set("view engine", "ejs");
app.get("/gamble", (req, res) => {
  console.log(req.session);
  if (!req.session.passport) {
    return res.redirect("/login");
  }
  res.render("index", {
    title: "Shipwrecked",
    email: req.session.passport.user,
  });
});
app.get("/my-shells-shipwrecked", async (req, res) => {
  if (!req.session.passport) {
    return res.redirect("/login");
  }
  // get user db entry
  const user = await keyv.get(req.session.passport.user);
  if (user && req.query.onlyCreate) {
    return res.status(403).end();
  }

  const shellD = !process.env.SHIPWRECKED_PSQL_URL
    ? { availableShells: 500 }
    : await calculateProgressMetricsByEmail(req.session.passport.user);
  if (!user) {
    await keyv.set(req.session.passport.user, {
      shell_count: shellD.availableShells,
      already_checked_shipwrecked_site: true,
      email: req.session.passport.user,
      payouts: [],
    });
  }

  res.json({
    shells: shellD.availableShells,
  });
});
app.get("/login", (req, res) => {
  res.render("login");
});

io.on("connection", (socket) => {
  // socket.emit
  // socket.on
  console.log(`Client connected: ${socket.id}`);

  // Initialize player state
  players.set(socket.id, {
    displayName: null,
    bankroll: 1000, // starting bankroll
    currentBet: 0,
    roundState: "awaitingBet",
    currentCard: null,
    lastNextCard: null,
    lastOutcome: null,
  });

  // Emit initial state
  socket.emit("state", {
    bankroll: 1000,
    roundState: "awaitingBet",
    message: "Welcome! Please join the central table.",
  });

  socket.on("joinTable", async ({ displayName, email }) => {
    if (!displayName || typeof displayName !== "string") {
      socket.emit("error", { message: "Invalid display name" });
      return;
    }
    const dbEntry = await keyv.get(email);
    const player = players.get(socket.id);
    player.displayName = displayName;
    player.email = email;
    player.roundState = "awaitingBet";
    player.bankroll = dbEntry.shell_count;
    player.currentBet = 0;
    player.currentCard = null;
    player.lastNextCard = null;
    player.lastOutcome = null;

    // Draw initial current card for player
    player.currentCard = drawRandomCard();
    socket.emit("state", {
      bankroll: player.bankroll,
      roundState: player.roundState,
      currentCard: player.currentCard,
      message: "Joined the central table! Place your bet.",
    });
  });

  socket.on("placeBet", ({ amount }) => {
    const player = players.get(socket.id);
    if (!player || player.roundState !== "awaitingBet") {
      socket.emit("error", { message: "Not expecting a bet now." });
      return;
    }
    if (typeof amount !== "number" || amount < 1 || amount > player.bankroll) {
      socket.emit("error", { message: "Invalid bet amount." });
      return;
    }

    player.currentBet = amount;
    player.roundState = "awaitingGuess";

    // Server picks the next card (hidden for now)
    player.nextCard = drawRandomCard();

    socket.emit("roundStart", {
      bankroll: player.bankroll,
      currentCard: player.currentCard,
      message: "Guess higher or lower.",
    });
  });

  socket.on("guess", async ({ choice }) => {
    const player = players.get(socket.id);
    if (!player || player.roundState !== "awaitingGuess") {
      socket.emit("error", { message: "Not expecting a guess now." });
      return;
    }
    if (choice !== "higher" && choice !== "lower") {
      socket.emit("error", { message: "Invalid guess choice." });
      return;
    }

    // Determine outcome
    const currentVal = rankValue(player.currentCard);
    const nextVal = rankValue(player.nextCard);
    let outcome = "lose";
    const dbEntry = await keyv.get(player.email);

    if (nextVal === currentVal) {
      // Tie counts as loss or push? Here treat as loss
      outcome = "lose";
    } else if (
      (choice === "higher" && nextVal > currentVal) ||
      (choice === "lower" && nextVal < currentVal)
    ) {
      outcome = "win";
      player.bankroll += player.currentBet;
      dbEntry.payouts.push({
        amount: player.currentBet,
        outcome,
      });
    } else {
      player.bankroll -= player.currentBet;
      dbEntry.payouts.push({
        amount: -player.currentBet,
        outcome,
      });
    }

    dbEntry.shell_count = player.bankroll;
    await keyv.set(player.email, dbEntry);
    player.roundState = "resolved";
    player.lastNextCard = player.nextCard;
    player.lastOutcome = outcome;
    player.currentCard = player.nextCard;
    player.nextCard = null;
    player.currentBet = 0;

    socket.emit("roundResult", {
      bankroll: player.bankroll,
      currentCard: player.currentCard,
      nextCard: player.lastNextCard,
      outcome,
      message: outcome === "win" ? "You won!" : "You lost.",
    });
  });

  socket.on("nextRound", () => {
    const player = players.get(socket.id);
    if (!player || player.roundState !== "resolved") {
      socket.emit("error", { message: "Cannot start next round now." });
      return;
    }
    player.roundState = "awaitingBet";
    player.currentBet = 0;
    player.lastNextCard = null;
    player.lastOutcome = null;

    socket.emit("state", {
      bankroll: player.bankroll,
      roundState: player.roundState,
      currentCard: player.currentCard,
      message: "Place your bet to start the next round.",
    });
  });

  socket.on("chatMessage", (message) => {
    const displayName = players.get(socket.id).displayName || "Anonymous";
    console.log(`Chat from ${displayName}: ${message}`);

    // Broadcast to all except sender
    socket.broadcast.emit("chatMessage", {
      displayName,
      message,
    });
  });
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    players.delete(socket.id);
  });
});
server.listen(3001, () => {
  console.log(
    `Server is running on http://localhost:3001 (or http://shipwrecked-gamble.saahild.com)`,
  );
});
