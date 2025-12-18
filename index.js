const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();

/* ==============================
   Middlewares
================================ */
app.use(
  cors({
    origin: ["http://localhost:5173"], // frontend
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
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
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
// MongoDB → public-lesson collection
app.get("/lessons", async (req, res) => {
  try {
    const lessons = await publicLessonsCollection.find().toArray();
    res.json(lessons);
  } catch (error) {
    console.error("Failed to fetch lessons:", error);
    res.status(500).json({ message: "Failed to fetch lessons" });
  }
});


/* ---------- TOP CONTRIBUTORS ---------- */
app.get("/top-contributors", async (req, res) => {
  try {
    const pipeline = [
      // 1️⃣ only public lessons
      {
        $match: {
          visibility: "public",
        },
      },

      // 2️⃣ group by creator
      {
        $group: {
          _id: "$creator.name",
          photo: { $first: "$creator.photo" },
          totalLessons: { $sum: 1 },
          totalLikes: { $sum: "$likesCount" },
          totalFavorites: { $sum: "$favoritesCount" },
        },
      },

      // 3️⃣ score calculation
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

      // 4️⃣ sort & limit (TOP 7)
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






/* ---------- POSTS ---------- */
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

/* ---------- USERS ---------- */
app.post("/users", verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email, name } = req.decoded;

    const existUser = await usersCollection.findOne({ uid });

    if (!existUser) {
      await usersCollection.insertOne({
        uid,
        email,
        name: name || "Anonymous",
        role: "user",
        createdAt: new Date(),
      });
    }

    res.json({ success: true, uid, email, name: name || "Anonymous" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to create/update user" });
  }
});

app.get("/users/:uid", verifyFirebaseToken, async (req, res) => {
  try {
    if (req.params.uid !== req.decoded.uid) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const user = await usersCollection.findOne({ uid: req.decoded.uid });
    res.json(user || {});
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch user" });
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

    console.log("✅ MongoDB Connected");

    app.listen(port, () => console.log(`🚀 Server running on ${port}`));
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

start();
