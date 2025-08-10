const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const io = require("socket.io")(server);
app.use(express.static("public"));
app.use(express.json());

app.set("view engine", "ejs");
app.get("/", (req, res) => {
  res.render("index", { title: "Shipwrecked" });
});
io.on("connection", (socket) => {
  // socket.emit
  // socket.on
});
server.listen(3001, () => {
  console.log(`Server is running on http://localhost:3001`);
});
