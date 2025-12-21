const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
require("dotenv").config();
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();


//  CORS
app.use(cors({
  origin: ["http://localhost:5173", "https://wisdom-vault-client-side.vercel.app"],
  credentials: true
}));


app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
 
  res.json({ received: true });
});


app.use(express.json());

/* ==============================
    Cloudinary & Multer Setup
================================ */
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });


// Cloudinary upload function
// Upload function
const uploadToCloudinary = (fileBuffer, filename) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'wisdom_vault', public_id: filename },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(fileBuffer);
  });
};


/* ==============================
    Firebase Setup
================================ */
const rawKey = process.env.FIREBASE_PRIVATE_KEY;
const formattedKey = rawKey ? rawKey.replace(/\\n/g, '\n') : undefined;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: formattedKey,
    }),
  });
}

/* ==============================
    MongoDB & Collections Setup
================================ */
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.wtnhlvb.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, deprecationErrors: true },
});

let usersCollection, postsCollection, publicLessonsCollection, myLessonsCollection;

// Vercel এর জন্য কানেকশন মিডলওয়্যার
async function connectDB(req, res, next) {
  if (!usersCollection) {
    await client.connect();
    const db = client.db("wisdomVaultDB");
    usersCollection = db.collection("users");
    postsCollection = db.collection("posts");
    publicLessonsCollection = db.collection("public-lesson");
    myLessonsCollection = db.collection("my-lessons");
  }
  next();
}

// সব রাউটের জন্য ডাটাবেজ কানেকশন নিশ্চিত করা
app.use(connectDB);

/* ==============================
    Verify Token Middleware
================================ */
const verifyFirebaseToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
        const token = authHeader.split(" ")[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.decoded = decodedToken;
        next();
    } catch (error) {
        return res.status(401).json({ message: "Invalid token" });
    }
};

/* ==============================
    Routes 
================================ */
app.get("/", (req, res) => res.send("Server is running!"));

/* ---------- PROFILE UPLOAD ---------- */
app.post("/users/upload-profile", verifyFirebaseToken, upload.single("profileImage"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const result = await uploadToCloudinary(req.file.buffer, `profile_${req.decoded.uid}`);
    const photoURL = result.secure_url;

    await usersCollection.updateOne({ email: req.decoded.email }, { $set: { photoURL } });
    await admin.auth().updateUser(req.decoded.uid, { photoURL });

    res.json({ photoURL });
  } catch (error) {
    console.error("Profile Upload Error:", error); 
    res.status(500).json({ message: "Profile upload failed" });
  }
});



/* ---------- ADD LESSON ---------- */

app.post("/dashboard/add-lesson", verifyFirebaseToken, async (req, res) => {
  try {
   
    console.log("Full Body Received:", req.body);

    const {
      title, shortDescription, fullDescription, 
      category, emotionalTone, visibility, 
      accessLevel, imageURL 
    } = req.body;

    if (!title || !fullDescription) {
      return res.status(400).json({ message: "Title & Full Description required" });
    }

    const user = await usersCollection.findOne({ email: req.decoded.email });
    
    const lesson = {
      title,
      shortDescription,
      fullDescription,
      category,
      emotionalTone,
      image: imageURL || "", 
      visibility,
      accessLevel,
      creator: {
        name: user?.name || "Anonymous",
        email: req.decoded.email,
        uid: req.decoded.uid,
        photo: user?.photoURL || "",
      },
      likesCount: 0,
      favoritesCount: 0,
      comments: [],
      createdAt: new Date(),
    };

    const result = await publicLessonsCollection.insertOne(lesson);
    await myLessonsCollection.insertOne({ ...lesson, _id: result.insertedId });

    res.json({ success: true, lesson });
  } catch (error) {
    console.error("Add Lesson Error:", error);
    res.status(500).json({ message: "Failed to add lesson" });
  }
});








/* ---------- STRIPE PAYMENT INTENT ---------- */

app.post("/create-payment-intent", async (req, res) => {
  const { price } = req.body;
  
  if (!price) {
    return res.status(400).send({ message: "Price is required" });
  }

  const amount = parseInt(price * 100);

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: "usd", // যদি টাকা সাপোর্ট না করে তবে usd দিন
      payment_method_types: ["card"],
    });

    res.send({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error("Stripe Error:", error);
    res.status(500).send({ error: error.message });
  }
});


app.patch("/users/upgrade/:email", async (req, res) => {
    const email = req.params.email;
    const updateInfo = req.body; // { isPremium: true } বা { role: 'admin' }
    
    try {
        const query = { email: email };
        const updatedDoc = { $set: updateInfo };
        
        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
    } catch (error) {
        console.error("Upgrade Error:", error);
        res.status(500).send({ message: "Failed to update database" });
    }
});





/* ==============================
    Routes
================================ */



/* ---------- GET USER PROFILE ---------- */
app.get("/users/profile/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const lessonsCreated = await publicLessonsCollection.countDocuments({ "creator.email": email });
    const favoritesAgg = await publicLessonsCollection.aggregate([{ $match: { "favoritedBy.email": email } }, { $count: "total" }]).toArray();
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

/* ---------- UPDATE PROFILE ---------- */
app.put("/users/update-profile", verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email } = req.decoded; 
    const { name, photoURL } = req.body;

    await usersCollection.updateOne(
      { email },
      { $set: { name, photoURL } }
    );

    await admin.auth().updateUser(uid, {
      displayName: name,
      photoURL: photoURL
    });

    res.json({ success: true, message: "Updated in both DB and Firebase" });
  } catch (error) {
    console.error("Firebase/DB Update Error:", error);
    res.status(500).json({ message: "Update failed" });
  }
});

/* ------ create user/ Sync ---------*/
app.post("/users", verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email } = req.decoded; 
    const { name, photoURL } = req.body; 

    const existingUser = await usersCollection.findOne({ uid });

    if (!existingUser) {
      const newUser = {
        uid: uid,
        email: email,
        name: name || "Anonymous",
        role: "user",
        isPremium: false,
        createdAt: new Date(), 
        photoURL: photoURL || "", 
      };
      await usersCollection.insertOne(newUser);
    } else {
      if (existingUser.name === "Anonymous" && name) {
        await usersCollection.updateOne(
          { uid },
          { $set: { name: name, photoURL: photoURL || existingUser.photoURL } }
        );
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Sync failed" });
  }
});

/* ---------- USER STATUS ---------- */
app.get("/users/status/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.params.email;
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ role: user.role, isPremium: user.isPremium });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch user status" });
  }
});

/* ---------- ADD LESSON (Cloudinary) ---------- */



/* ---------- OTHER ROUTES ---------- */
// GET all lessons of logged-in user
app.get("/dashboard/my-lessons", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const lessons = await myLessonsCollection
      .find({ "creator.email": email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(lessons);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch my lessons" });
  }
});

// DELETE lesson
app.delete("/dashboard/my-lessons/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const lessonId = req.params.id;
    await myLessonsCollection.deleteOne({ _id: new ObjectId(lessonId) });
    await publicLessonsCollection.deleteOne({ _id: new ObjectId(lessonId) });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to delete lesson" });
  }
});

// UPDATE lesson
app.put("/dashboard/my-lessons/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const lessonId = req.params.id;
    const { title, shortDescription, fullDescription, category, emotionalTone, visibility, accessLevel, image } = req.body;
    const updateData = { title, shortDescription, fullDescription, category, emotionalTone, visibility, accessLevel, image };

    await myLessonsCollection.updateOne({ _id: new ObjectId(lessonId) }, { $set: updateData });
    await publicLessonsCollection.updateOne({ _id: new ObjectId(lessonId) }, { $set: updateData });

    res.json({ success: true, updatedLesson: updateData });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update lesson" });
  }
});

/* ---------- GET PUBLIC LESSONS ---------- */
app.get("/lessons", async (req, res) => {
  try {
    const lessons = await publicLessonsCollection.find().toArray();
    res.json(lessons);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch lessons" });
  }
});

// ======================= ADMIN DASHBOARD STATS =======================
app.get("/admin/dashboard-stats", async (req, res) => {
  try {
    const totalUsers = await usersCollection.countDocuments();
    const totalLessons = await publicLessonsCollection.countDocuments();
    const reportedLessons = await publicLessonsCollection.countDocuments({ isReported: true });

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const weeklyCount = await publicLessonsCollection.countDocuments({
      createdAt: { $gte: oneWeekAgo },
    });

    res.json({
      totalUsers,
      totalLessons,
      reportedLessons,
      weeklyGrowth: `+${weeklyCount}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load admin stats" });
  }
});

app.get("/admin/recent-users", async (req, res) => {
  try {
    const users = await usersCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(5)
      .project({ name: 1, email: 1, createdAt: 1 })
      .toArray();

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch recent users" });
  }
});

app.get("/admin/recent-lessons", async (req, res) => {
  try {
    const lessons = await publicLessonsCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(5)
      .project({ title: 1, visibility: 1, createdAt: 1 })
      .toArray();

    res.json(lessons);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch recent lessons" });
  }
});

/* ---------- GET ALL USERS ---------- */
app.get("/admin/manage-users", verifyFirebaseToken, async (req, res) => {
  try {
    const adminUser = await usersCollection.findOne({ email: req.decoded.email });
    if (adminUser?.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const users = await usersCollection
      .find()
      .sort({ createdAt: -1 })
      .project({ name: 1, email: 1, role: 1 })
      .toArray();

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

/* ---------- DELETE USER ---------- */
app.delete("/admin/manage-users/:email", verifyFirebaseToken, async (req, res) => {
  try {
    const adminUser = await usersCollection.findOne({ email: req.decoded.email });
    if (adminUser?.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const email = req.params.email;
    await usersCollection.deleteOne({ email });
    await publicLessonsCollection.deleteMany({ "creator.email": email });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete user" });
  }
});

/* ---------- PROMOTE USER TO ADMIN ---------- */
app.put("/admin/manage-users/:email/promote", verifyFirebaseToken, async (req, res) => {
  try {
    const adminUser = await usersCollection.findOne({ email: req.decoded.email });
    if (adminUser?.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const email = req.params.email;
    await usersCollection.updateOne({ email }, { $set: { role: "admin" } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to promote user" });
  }
});

// ================== ADMIN MANAGE USERS TEST & ACTIONS ==================
app.get("/admin/manage-users-test", async (req, res) => {
  try {
    const users = await usersCollection
      .find()
      .sort({ createdAt: -1 })
      .project({ name: 1, email: 1, role: 1, createdAt: 1 })
      .toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

app.delete("/admin/users/:email", async (req, res) => {
  try {
    const email = req.params.email;
    await usersCollection.deleteOne({ email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete user" });
  }
});

app.patch("/admin/users/promote/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const { role } = req.body;
    await usersCollection.updateOne({ email }, { $set: { role } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to promote user" });
  }
});

app.patch("/admin/users/role/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { role } = req.body;
    if (!role) return res.status(400).send({ message: "Role is required" });
    const result = await usersCollection.updateOne({ email }, { $set: { role } });
    if (result.matchedCount === 0) return res.status(404).send({ message: "User not found" });
    res.send({ success: true, role });
  } catch (error) {
    res.status(500).send({ message: "Failed to update role" });
  }
});

/* ---------- ADMIN: MANAGE LESSONS ---------- */
app.get("/admin/manage-lessons", async (req, res) => {
  try {
    const lessons = await publicLessonsCollection
      .find()
      .sort({ createdAt: -1 })
      .project({ title: 1, category: 1, visibility: 1, accessLevel: 1, createdAt: 1 })
      .toArray();
    res.json(lessons);
  } catch (error) {
    res.status(500).json({ message: "Failed to load lessons" });
  }
});

app.delete("/admin/lessons/:id", async (req, res) => {
  try {
    const id = req.params.id;
    await publicLessonsCollection.deleteOne({ _id: new ObjectId(id) });
    await myLessonsCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete lesson" });
  }
});

app.patch("/admin/lessons/access/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { accessLevel } = req.body;
    if (!["premium", "free"].includes(accessLevel)) return res.status(400).json({ message: "Invalid access level" });
    await publicLessonsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { accessLevel } });
    await myLessonsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { accessLevel } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Failed to update access" });
  }
});

/* ---------- DASHBOARD OVERVIEW ---------- */
app.get("/dashboard/overview", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const totalLessons = await publicLessonsCollection.countDocuments({ "creator.email": email });
    const favoritesAgg = await publicLessonsCollection.aggregate([{ $match: { "favoritedBy.email": email } }, { $count: "total" }]).toArray();
    const totalFavorites = favoritesAgg[0]?.total || 0;

    const recentLessons = await publicLessonsCollection
      .find({ "creator.email": email })
      .sort({ createdAt: -1 })
      .limit(5)
      .project({ title: 1, category: 1, createdAt: 1 })
      .toArray();

    const weeklyStats = await publicLessonsCollection.aggregate([
      { $match: { "creator.email": email, createdAt: { $gte: new Date(new Date().setDate(new Date().getDate() - 7)) } } },
      { $group: { _id: { $dayOfWeek: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    res.json({ totalLessons, totalFavorites, recentLessons, weeklyStats });
  } catch (error) {
    res.status(500).json({ message: "Failed to load dashboard overview" });
  }
});

/* ---------- TOP CONTRIBUTORS ---------- */
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
          score: { $add: [{ $multiply: ["$totalLessons", 5] }, { $multiply: ["$totalLikes", 1] }, { $multiply: ["$totalFavorites", 2] }] },
        },
      },
      { $sort: { score: -1 } },
      { $limit: 7 },
    ];
    const contributors = await publicLessonsCollection.aggregate(pipeline).toArray();
    res.json(contributors);
  } catch (error) {
    res.status(500).json({ message: "Failed to load contributors" });
  }
});

/* ---------- COMMUNITY STATS ---------- */
app.get("/community-stats", async (req, res) => {
  try {
    const totalLessons = await publicLessonsCollection.countDocuments({ visibility: "public" });
    const totalUsers = await usersCollection.countDocuments();
    const favoritesAgg = await publicLessonsCollection.aggregate([{ $group: { _id: null, totalFavorites: { $sum: "$favoritesCount" } } }]).toArray();
    const totalFavorites = favoritesAgg[0]?.totalFavorites || 0;
    const categories = await publicLessonsCollection.distinct("category");
    res.json({ totalLessons, totalUsers, totalFavorites, totalCategories: categories.length });
  } catch (error) {
    res.status(500).json({ message: "Failed to load community stats" });
  }
});

/* ---------- POSTS ---------- */
app.post("/add-post", verifyFirebaseToken, async (req, res) => {
  try {
    const post = { ...req.body, authorEmail: req.decoded.email, createdAt: new Date() };
    const result = await postsCollection.insertOne(post);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to add post" });
  }
});

app.get("/posts", async (req, res) => {
  try {
    const posts = await postsCollection.find().toArray();
    res.json(posts);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch posts" });
  }
});

/* ==============================
    Start Server
================================ */
const port = process.env.PORT || 5000;
async function start() {
    try {
        await client.connect();
        const db = client.db("wisdomVaultDB");
        usersCollection = db.collection("users");
        postsCollection = db.collection("posts");
        publicLessonsCollection = db.collection("public-lesson");
        myLessonsCollection = db.collection("my-lessons");
        console.log("✅ MongoDB Connected");
        app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));
    } catch (error) {
        console.error("Failed to start server:", error);
    }
}
start();

module.exports = app;
