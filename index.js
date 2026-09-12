// ==================== BloodOra Backend - Entry Point ====================
// Local dev:   node index.js            (listens on PORT, default 4000)
// Vercel:      exports the Express app as a serverless handler
import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./src/app.js";

const appPromise = createApp();

// -------- Vercel serverless handler --------
export default async function handler(req, res) {
  const app = await appPromise;
  return app(req, res);
}

// -------- Local development server (+ Socket.IO live chat) --------
if (!process.env.VERCEL && process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { createServer } = await import("http");
  const { Server: SocketIO } = await import("socket.io");

  const httpServer = createServer((req, res) => handler(req, res));
  const allowedOrigins = (process.env.FRONTEND_URL || "").split(",").map((s) => s.trim()).filter(Boolean);
  const io = new SocketIO(httpServer, {
    cors: { origin: allowedOrigins.length ? allowedOrigins : "*", methods: ["GET", "POST"] },
  });
  io.on("connection", (socket) => {
    socket.on("join", (room) => socket.join(room));
    socket.on("chat:message", (data) => io.emit("chat:message", data));
  });

  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🩸 BloodOra Backend API v3.0`);
    console.log(`   URL: http://0.0.0.0:${PORT}`);
    console.log(`   Health: http://0.0.0.0:${PORT}/api/health`);
    console.log(`   CORS FRONTEND_URL: ${process.env.FRONTEND_URL || "(not set — allowing all origins for dev)"}\n`);
  });
}
