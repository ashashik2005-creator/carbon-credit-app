const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const PDFDocument = require('pdfkit');
const dns = require('dns');

try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  console.log('🌐 Node DNS set to Google Public DNS (8.8.8.8)');
} catch (e) {
  console.log('⚠️ Could not set custom DNS servers.');
}

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_carbon_key_2026';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://ashikpoojary2005_db_user:5qoIcQsBV8caZkcp@cluster0.dxrrxua.mongodb.net/carbondb?retryWrites=true&w=majority';

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.set('bufferCommands', false);

// Database Connection
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => console.log('✅ Connected to MongoDB database successfully.'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1 && req.path.startsWith('/api/')) {
    return res.status(503).json({ 
      error: 'Database connection is offline. Please check MongoDB Atlas IP Whitelist (0.0.0.0/0).' 
    });
  }
  next();
});

// --- SCHEMAS ---
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
  wasteKg: { type: Number, default: 0 },
  coalTons: { type: Number, default: 0 },
  hazardousWasteKg: { type: Number, default: 0 },
  solidWasteKg: { type: Number, default: 0 },
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

// --- AUTHENTICATION ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, accountType } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Please enter all required fields.' });

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) return res.status(400).json({ error: 'Username or email already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, email, password: hashedPassword, accountType: accountType || 'person' });
    await newUser.save();
    res.status(201).json({ message: 'User registered successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findOne({ $or: [{ username: identifier }, { email: identifier }] });
    if (!user) return res.status(400).json({ error: 'Invalid username/email or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid username/email or password.' });

    const token = jwt.sign(
      { id: user._id, username: user.username, accountType: user.accountType },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, accountType: user.accountType } });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// --- CARBON LOGS ROUTES ---
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
      accountType, transportMode, transportDistance, gridPowerKwh, 
      solarPowerKwh, wasteKg, coalTons, hazardousWasteKg, solidWasteKg, offsetKg 
    } = req.body;

    let totalReleased = 0;
    let totalSaved = 0;

    if ((accountType || req.user.accountType) === 'factory') {
      const cTons = parseFloat(coalTons) || 0;
      const hazWaste = parseFloat(hazardousWasteKg) || 0;
      const solWaste = parseFloat(solidWasteKg) || 0;

      totalReleased = (cTons * 2420) + (hazWaste * 2.5) + (solWaste * 1.5);
      totalSaved = 0;
    } else {
      const transportRates = { bus: 0.089, gas_car: 0.210, diesel_car: 0.170, motorcycle: 0.103, train: 0.035, ev: 0.053, walk: 0.0, none: 0.0 };
      const tDist = parseFloat(transportDistance) || 0;
      const rate = transportRates[transportMode] || 0;

      totalReleased = (tDist * rate) + ((parseFloat(gridPowerKwh) || 0) * 0.82) + ((parseFloat(wasteKg) || 0) * 1.9);
      totalSaved = ((parseFloat(solarPowerKwh) || 0) * 0.82) + (transportMode === 'walk' ? tDist * 0.210 : 0);
    }

    const directOffset = parseFloat(offsetKg) || 0;
    totalSaved += directOffset;

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
      coalTons: parseFloat(coalTons) || 0,
      hazardousWasteKg: parseFloat(hazardousWasteKg) || 0,
      solidWasteKg: parseFloat(solidWasteKg) || 0,
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

// --- SUSTAINABILITY ADVISOR ENDPOINT ---
app.get('/api/sustainability-advisor', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id }).sort({ date: -1 }).limit(5);
    const userType = req.user.accountType;
    let totalReleased = 0;

    logs.forEach(log => { totalReleased += log.releasedKg; });

    let advice = "";
    if (userType === 'factory') {
      advice = `Hello ${req.user.username}! Based on your recent industrial logs (Total Released: ${totalReleased.toFixed(1)} kg CO2):\n\n` +
        `1. 🏭 **Boiler Efficiency:** Consider shifting a portion of coal boiler fuel to biomass co-firing to reduce gross CO2 factors.\n` +
        `2. ⚠️ **Hazardous Waste:** Your chemical/hazardous waste releases 2.5 kg CO2 per kg. Transitioning to closed-loop chemical recycling can lower this footprint by up to 40%.\n` +
        `3. ♻️ **Solid Waste Stream:** Partner with industrial waste aggregators to redirect slag and metallic scrap away from landfills.`;
    } else {
      advice = `Hi ${req.user.username}! Here is your personalized eco-strategy based on your recent activity (Total Released: ${totalReleased.toFixed(1)} kg CO2):\n\n` +
        `1. 🚲 **Commute Optimization:** Replacing just 2 car trips per week with walking or cycling saves roughly 4.2 kg of CO2.\n` +
        `2. ⚡ **Energy Conservation:** Off-grid solar adoption or switching to LED lighting can cut grid electricity footprint by 15-20%.\n` +
        `3. ♻️ **Waste Management:** Composting organic waste prevents methane generation and avoids 1.9 kg CO2 per kg logged.`;
    }

    res.json({ advice });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate sustainability advice.' });
  }
});

// --- EXPORT ENDPOINTS ---
app.get('/api/export/csv', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id }).sort({ date: -1 });
    let csv = 'Date,Account Type,Transport/Industrial Mode,Released (kg),Saved (kg),Credits Earned,Trees Needed\n';
    logs.forEach(log => {
      const modeText = log.accountType === 'factory' ? `Industrial Coal (${log.coalTons}T)` : log.transportMode;
      csv += `"${new Date(log.date).toISOString().split('T')[0]}","${log.accountType}","${modeText}",${log.releasedKg},${log.savedKg},${log.creditsEarned},${log.treesNeeded}\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment(`carbon_logs_${req.user.username}.csv`);
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate CSV export.' });
  }
});

app.get('/api/export/certificate', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id });
    const totalCredits = logs.reduce((sum, log) => sum + log.creditsEarned, 0);
    const totalReleased = logs.reduce((sum, log) => sum + log.releasedKg, 0);
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
    doc.fontSize(12).fillColor('#475569').text(`This certificate confirms that ${req.user.username} has tracked carbon footprint and accumulated:`, { align: 'center' });
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

app.get('/api/export/monthly-pdf', authenticateToken, async (req, res) => {
  try {
    const logs = await CarbonLog.find({ userId: req.user.id }).sort({ date: -1 });
    const totalReleased = logs.reduce((sum, log) => sum + log.releasedKg, 0);
    const totalSaved = logs.reduce((sum, log) => sum + log.savedKg, 0);
    const totalCredits = logs.reduce((sum, log) => sum + log.creditsEarned, 0);
    const totalTrees = Math.ceil(totalReleased / 21.77);

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Monthly_Carbon_Report_${req.user.username}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).fillColor('#0f172a').text(`Monthly Carbon Analytics Report (${req.user.accountType.toUpperCase()})`, { align: 'center' });
    doc.fontSize(10).fillColor('#64748b').text(`User: ${req.user.username} | Date: ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(12).fillColor('#0f172a').text(`• Gross Carbon Released: ${totalReleased.toFixed(2)} kg CO2`);
    doc.text(`• Total Carbon Avoided/Saved: ${totalSaved.toFixed(2)} kg CO2`);
    doc.text(`• Net Carbon Credits Earned: ${totalCredits.toFixed(5)}`);
    doc.text(`• Total Trees Needed to Offset: ${totalTrees} Trees`);
    doc.moveDown(1.5);

    doc.fontSize(14).fillColor('#10b981').text('Recent Activity Log History');
    doc.moveDown(0.5);

    logs.slice(0, 15).forEach((log, index) => {
      const modeDesc = log.accountType === 'factory' 
        ? `Coal: ${log.coalTons}T, HazWaste: ${log.hazardousWasteKg}kg` 
        : `Mode: ${log.transportMode}`;
      doc.fontSize(9).fillColor('#334155').text(
        `${index + 1}. [${new Date(log.date).toLocaleDateString()}] ${modeDesc} | Released: ${log.releasedKg} kg | Saved: ${log.savedKg} kg | Trees: ${log.treesNeeded}`
      );
    });

    doc.end();
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate Monthly PDF Report.' });
  }
});

// LEADERBOARD ENDPOINT
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await CarbonLog.aggregate([
      { $group: { _id: '$userId', totalSaved: { $sum: '$savedKg' }, totalCredits: { $sum: '$creditsEarned' } } },
      { $sort: { totalCredits: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
      { $unwind: '$userInfo' },
      { $project: { username: '$userInfo.username', accountType: '$userInfo.accountType', totalSaved: 1, totalCredits: 1 } }
    ]);
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Carbon Credit Server running on http://localhost:${PORT}`);
});