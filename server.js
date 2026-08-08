const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const PDFDocument = require('pdfkit');
const dns = require('dns');

// 1. Force Node.js to use Google Public DNS to resolve MongoDB SRV records
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  console.log('🌐 Node DNS set to Google Public DNS (8.8.8.8)');
} catch (e) {
  console.log('⚠️ Could not set custom DNS servers.');
}

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'super_secret_carbon_key_2026';

// MongoDB Atlas URI
const MONGO_URI = 'mongodb+srv://ashikpoojary2005_db_user:5qoIcQsBV8caZkcp@cluster0.dxrrxua.mongodb.net/carbondb?retryWrites=true&w=majority';

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Disable query buffering so operations fail fast if DB drops
mongoose.set('bufferCommands', false);

// Database Connection
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 10000
})
  .then(() => console.log('✅ Connected to MongoDB database successfully.'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

// Middleware to check database connection
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1 && req.path.startsWith('/api/')) {
    return res.status(503).json({ 
      error: 'Database connection is offline. Please check MongoDB Atlas IP Whitelist (0.0.0.0/0).' 
    });
  }
  next();
});

// --- MONGOOSE SCHEMAS ---
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  accountType: { type: String, enum: ['person', 'factory'], default: 'person' },
  createdAt: { type: Date, default: Date.now }
});

const CarbonLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  accountType: { type: String, enum: ['person', 'factory'], required: true },
  transportMode: { type: String, default: 'none' },
  transportDistance: { type: Number, default: 0 },
  gridPowerKwh: { type: Number, default: 0 },
  solarPowerKwh: { type: Number, default: 0 },
  wasteKg: { type: Number, default: 0 }, // 👈 Added Waste Field (kg)
  offsetKg: { type: Number, default: 0 },
  releasedKg: { type: Number, required: true },
  savedKg: { type: Number, required: true },
  netSavedKg: { type: Number, required: true },
  creditsEarned: { type: Number, required: true },
  treesNeeded: { type: Number, required: true },
  date: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const CarbonLog = mongoose.model('CarbonLog', CarbonLogSchema);

// --- JWT AUTH MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. Token missing.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// --- AUTHENTICATION API ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, accountType } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Please enter all required fields.' });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      accountType: accountType || 'person'
    });

    await newUser.save();
    res.status(201).json({ message: 'User registered successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }]
    });

    if (!user) return res.status(400).json({ error: 'Invalid username/email or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid username/email or password.' });

    const token = jwt.sign(
      { id: user._id, username: user.username, accountType: user.accountType },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user._id, username: user.username, email: user.email, accountType: user.accountType }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// --- CARBON LOGS API ROUTES ---
app.get('/api/logs', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id }).sort({ date: -1 });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch carbon logs.' });
  }
});

app.post('/api/logs', authenticateToken, async (req, res) => {
  try {
    const { 
      accountType, 
      transportMode, 
      transportDistance, 
      gridPowerKwh, 
      solarPowerKwh, 
      wasteKg, 
      offsetKg 
    } = req.body;

    // Transport Factors (kg CO2 per km)
    const transportRates = {
      bus: 0.089,
      car: 0.171,
      motorbike: 0.103,
      train: 0.035,
      walk_bike: 0.0,
      none: 0.0
    };

    const rate = transportRates[transportMode] || 0;
    const transportCO2 = (parseFloat(transportDistance) || 0) * rate;
    const gridCO2 = (parseFloat(gridPowerKwh) || 0) * 0.82; // 0.82 kg CO2 per kWh grid electricity
    const wasteCO2 = (parseFloat(wasteKg) || 0) * 1.9; // 1.9 kg CO2 per kg unmanaged waste

    // Total Released CO2 (Transport + Power + Waste)
    const totalReleased = transportCO2 + gridCO2 + wasteCO2;

    // Total Saved / Offset CO2 (Solar avoided emissions + Direct Offset purchased)
    const solarSavedCO2 = (parseFloat(solarPowerKwh) || 0) * 0.82;
    const directOffset = parseFloat(offsetKg) || 0;
    const totalSaved = solarSavedCO2 + directOffset;

    const netSaved = totalSaved - totalReleased;
    const credits = netSaved / 1000;
    const treesNeeded = Math.ceil(totalReleased / 21.77);

    const newLog = new CarbonLog({
      userId: req.user.id,
      accountType: accountType || req.user.accountType,
      transportMode: transportMode || 'none',
      transportDistance: parseFloat(transportDistance) || 0,
      gridPowerKwh: parseFloat(gridPowerKwh) || 0,
      solarPowerKwh: parseFloat(solarPowerKwh) || 0,
      wasteKg: parseFloat(wasteKg) || 0,
      offsetKg: directOffset,
      releasedKg: Number(totalReleased.toFixed(2)),
      savedKg: Number(totalSaved.toFixed(2)),
      netSavedKg: Number(netSaved.toFixed(2)),
      creditsEarned: Number(credits.toFixed(5)),
      treesNeeded: treesNeeded
    });

    await newLog.save();
    res.status(201).json(newLog);
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate and save log.' });
  }
});

app.delete('/api/logs/:id', authenticateToken, async (req, res) => {
  try {
    const log = await CarbonLog.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!log) return res.status(404).json({ error: 'Log entry not found.' });
    res.json({ message: 'Log deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete log entry.' });
  }
});

// --- CSV EXPORT ENDPOINT ---
app.get('/api/export/csv', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id }).sort({ date: -1 });
    
    let csv = 'Date,Account Type,Transport Mode,Distance (km),Waste Generated (kg),Released (kg),Saved (kg),Net Saved (kg),Credits Earned,Trees Needed\n';
    logs.forEach(log => {
      csv += `"${new Date(log.date).toISOString().split('T')[0]}","${log.accountType}","${log.transportMode}",${log.transportDistance || 0},${log.wasteKg || 0},${log.releasedKg},${log.savedKg},${log.netSavedKg},${log.creditsEarned},${log.treesNeeded || Math.ceil(log.releasedKg / 21.77)}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`carbon_logs_${req.user.username}.csv`);
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate CSV export.' });
  }
});

// --- PDF CERTIFICATE GENERATOR ---
app.get('/api/export/certificate', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id });
    const totalCredits = logs.reduce((sum, log) => sum + log.creditsEarned, 0);
    const totalReleased = logs.reduce((sum, log) => sum + log.releasedKg, 0);
    const totalWaste = logs.reduce((sum, log) => sum + (log.wasteKg || 0), 0);
    const treesNeeded = Math.ceil(totalReleased / 21.77);

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Carbon_Certificate_${req.user.username}.pdf`);
    doc.pipe(res);

    doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).stroke('#10b981');

    doc.moveDown(2);
    doc.fontSize(26).fillColor('#10b981').text('OFFICIAL CARBON CREDIT CERTIFICATE', { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(14).fillColor('#334155').text('Presented to', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(22).fillColor('#0f172a').text(req.user.username.toUpperCase(), { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(12).fillColor('#475569').text(
      `This certificate confirms that ${req.user.username} has tracked carbon footprint, tracked ${totalWaste.toFixed(1)} kg of waste, and accumulated:`,
      { align: 'center' }
    );

    doc.moveDown(1.5);
    doc.fontSize(28).fillColor('#059669').text(`${totalCredits.toFixed(5)} Carbon Credits`, { align: 'center' });
    doc.fontSize(12).fillColor('#64748b').text(`(Tree Offset Requirement: ${treesNeeded} Trees to Plant)`, { align: 'center' });

    doc.moveDown(3);
    doc.fontSize(10).fillColor('#94a3b8').text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.text('Verified by EcoCreditHub Platform', { align: 'center' });

    doc.end();
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate PDF Certificate.' });
  }
});

// --- ECO LEADERBOARD ENDPOINT ---
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await CarbonLog.aggregate([
      {
        $group: {
          _id: '$userId',
          totalSaved: { $sum: '$savedKg' },
          totalCredits: { $sum: '$creditsEarned' }
        }
      },
      { $sort: { totalCredits: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      { $unwind: '$userInfo' },
      {
        $project: {
          username: '$userInfo.username',
          accountType: '$userInfo.accountType',
          totalSaved: 1,
          totalCredits: 1
        }
      }
    ]);
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// Serve Frontend SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Carbon Credit Server running on http://localhost:${PORT}`);
});