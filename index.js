const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();



const multer = require("multer");
const path = require("path");
const fs = require("fs");


/* ==============================
   Middlewares
================================ */
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

/* ==============================
   Firebase Admin Setup
================================ */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : undefined,
  }),
});

/* ==============================
   MongoDB Setup
================================ */
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.wtnhlvb.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let usersCollection;
let postsCollection;
let publicLessonsCollection;

/* ==============================
   Verify Firebase Token Middleware
================================ */
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];
    req.decoded = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(401).json({ message: "Invalid Token" });
  }
};

/* ==============================
   Routes
================================ */
app.get("/", (req, res) => {
  res.send("Backend is working!");
});

/* ---------- PUBLIC LESSONS ---------- */
app.get("/lessons", async (req, res) => {
  try {
    const lessons = await publicLessonsCollection.find().toArray();
    res.json(lessons);
  } catch (error) {
    console.error("Failed to fetch lessons:", error);
    res.status(500).json({ message: "Failed to fetch lessons" });
  }
});






/* ==============================
   IMAGE UPLOAD CONFIG (UNCHANGED)
================================ */
const uploadDir = path.join(__dirname, "uploads/profile");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${req.decoded.uid}${ext}`);
  },
});

const upload = multer({ storage });

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ==============================
   PROFILE IMAGE UPLOAD (FIXED)
================================ */
app.post(
  "/users/upload-profile",
  verifyFirebaseToken,
  upload.single("profileImage"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const photoURL = `http://localhost:3000/uploads/profile/${req.file.filename}`;

      //  MongoDB sync (FIXED field name)
      await usersCollection.updateOne(
        { email: req.decoded.email },
        { $set: { photoURL } }
      );

      //  Firebase Auth sync
      await admin.auth().updateUser(req.decoded.uid, {
        photoURL,
      });

      res.json({ photoURL });
    } catch (error) {
      console.error("Profile upload error:", error);
      res.status(500).json({ message: "Image upload failed" });
    }
  }
);

/* ==============================
   GET USER PROFILE (FIXED)
================================ */
app.get("/users/profile/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;

    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const lessonsCreated = await publicLessonsCollection.countDocuments({
      "creator.email": email,
    });

    const favoritesAgg = await publicLessonsCollection.aggregate([
      { $match: { "favoritedBy.email": email } },
      { $count: "total" },
    ]).toArray();

    const lessonsSaved = favoritesAgg[0]?.total || 0;

    res.json({
      name: user.name,
      email: user.email,
      photoURL: user.photoURL || "", 
      isPremium: user.isPremium,
      lessonsCreated,
      lessonsSaved,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});

/* ==============================
   UPDATE PROFILE (SECURE + FIXED)
================================ */
app.put("/users/update-profile", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.decoded.email; // SECURITY FIX
    const { name, photoURL } = req.body;

    const result = await usersCollection.updateOne(
      { email },
      { $set: { name, photoURL } } // FIXED field name
    );

    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update profile" });
  }
});









/* ==============================
   DASHBOARD FIXED SECTION (ONLY)
================================ */

//  Create / Sync user on login (Firebase based) – dashboard needs this
app.post("/users", verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email, name } = req.decoded;

    const existingUser = await usersCollection.findOne({ uid });

    if (!existingUser) {
      await usersCollection.insertOne({
        uid,
        email,
        name: name || "Anonymous",
        role: "user",
        isPremium: false,
        createdAt: new Date(),
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("User sync error:", error);
    res.status(500).json({ message: "Failed to sync user" });
  }
});

// 🔎 Get role & premium status (used by dashboard)
app.get("/users/status/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;
    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      role: user.role,
      isPremium: user.isPremium,
    });
  } catch (error) {
    console.error("User status error:", error);
    res.status(500).json({ message: "Failed to fetch user status" });
  }
});







/* ---------- USER DASHBOARD OVERVIEW ---------- */
app.get("/dashboard/overview", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.decoded.email;

    // 1️⃣ Total lessons by user
    const totalLessons = await publicLessonsCollection.countDocuments({
      "creator.email": email,
    });

    // 2️⃣ Total favorites by user (assuming favorites stored per lesson)
    const favoritesAgg = await publicLessonsCollection.aggregate([
      { $match: { "favoritedBy.email": email } },
      { $count: "total" },
    ]).toArray();

    const totalFavorites = favoritesAgg[0]?.total || 0;

    // 3️⃣ Recently added lessons
    const recentLessons = await publicLessonsCollection
      .find({ "creator.email": email })
      .sort({ createdAt: -1 })
      .limit(5)
      .project({
        title: 1,
        category: 1,
        createdAt: 1,
      })
      .toArray();

    // 4️⃣ Weekly analytics (last 7 days)
    const weeklyStats = await publicLessonsCollection.aggregate([
      {
        $match: {
          "creator.email": email,
          createdAt: {
            $gte: new Date(new Date().setDate(new Date().getDate() - 7)),
          },
        },
      },
      {
        $group: {
          _id: { $dayOfWeek: "$createdAt" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray();

    res.json({
      totalLessons,
      totalFavorites,
      recentLessons,
      weeklyStats,
    });
  } catch (error) {
    console.error("Dashboard overview error:", error);
    res.status(500).json({ message: "Failed to load dashboard overview" });
  }
});






// Get full profile info for dashboard profile
app.get("/users/profile/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;

    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // count lessons created
    const lessonsCreated = await publicLessonsCollection.countDocuments({
      "creator.email": email,
    });

    // count lessons saved (assuming each lesson has favoritedBy array)
    const favoritesAgg = await publicLessonsCollection.aggregate([
      { $match: { "favoritedBy.email": email } },
      { $count: "total" },
    ]).toArray();
    const lessonsSaved = favoritesAgg[0]?.total || 0;

    res.json({
      name: user.name,
      email: user.email,
      photoURL: user.photo || "",
      isPremium: user.isPremium,
      lessonsCreated,
      lessonsSaved,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});

// Update user profile (name & photoURL)
app.put("/users/update-profile/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;
    const { name, photoURL } = req.body;

    const result = await usersCollection.updateOne(
      { email },
      { $set: { name, photo: photoURL } }
    );

    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// Get all public lessons created by a user
app.get("/public-lessons/user/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;

    const lessons = await publicLessonsCollection
      .find({ "creator.email": email, visibility: "public" })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(lessons);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch user lessons" });
  }
});







/* ---------- TOP CONTRIBUTORS (Dashboard) ---------- */
app.get("/top-contributors", async (req, res) => {
  try {
    const pipeline = [
      { $match: { visibility: "public" } },
      {
        $group: {
          _id: "$creator.name",
          photo: { $first: "$creator.photo" },
          totalLessons: { $sum: 1 },
          totalLikes: { $sum: "$likesCount" },
          totalFavorites: { $sum: "$favoritesCount" },
        },
      },
      {
        $addFields: {
          score: {
            $add: [
              { $multiply: ["$totalLessons", 5] },
              { $multiply: ["$totalLikes", 1] },
              { $multiply: ["$totalFavorites", 2] },
            ],
          },
        },
      },
      { $sort: { score: -1 } },
      { $limit: 7 },
    ];

    const contributors = await publicLessonsCollection
      .aggregate(pipeline)
      .toArray();

    res.json(contributors);
  } catch (error) {
    console.error("Top contributors error:", error);
    res.status(500).json({ message: "Failed to load contributors" });
  }
});

/* ---------- COMMUNITY STATS (Dashboard) ---------- */
app.get("/community-stats", async (req, res) => {
  try {
    const totalLessons = await publicLessonsCollection.countDocuments({
      visibility: "public",
    });

    const totalUsers = await usersCollection.countDocuments();

    const favoritesAgg = await publicLessonsCollection
      .aggregate([
        { $group: { _id: null, totalFavorites: { $sum: "$favoritesCount" } } },
      ])
      .toArray();

    const totalFavorites = favoritesAgg[0]?.totalFavorites || 0;

    const categories = await publicLessonsCollection.distinct("category");

    res.json({
      totalLessons,
      totalUsers,
      totalFavorites,
      totalCategories: categories.length,
    });
  } catch (error) {
    console.error("Community stats error:", error);
    res.status(500).json({ message: "Failed to load community stats" });
  }
});

/* ---------- POSTS (UNCHANGED) ---------- */
app.post("/add-post", verifyFirebaseToken, async (req, res) => {
  try {
    const post = {
      ...req.body,
      authorEmail: req.decoded.email,
      createdAt: new Date(),
    };

    const result = await postsCollection.insertOne(post);
    res.json({ success: true, result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to add post" });
  }
});

app.get("/posts", async (req, res) => {
  try {
    const posts = await postsCollection.find().toArray();
    res.json(posts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch posts" });
  }
});

/* ==============================
   Start Server
================================ */
const port = process.env.PORT || 3000;

async function start() {
  try {
    await client.connect();
    db = client.db("wisdomVaultDB");

    usersCollection = db.collection("users");
    postsCollection = db.collection("posts");
    publicLessonsCollection = db.collection("public-lesson");

    // 🔥 performance indexes (dashboard only)
    await usersCollection.createIndex({ email: 1 });
    await publicLessonsCollection.createIndex({ visibility: 1 });
    await publicLessonsCollection.createIndex({ "creator.name": 1 });

    console.log("✅ MongoDB Connected");
    app.listen(port, () => console.log(`🚀 Server running on ${port}`));
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

start();