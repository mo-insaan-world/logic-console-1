const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SUBMISSIONS_FILE = path.join(__dirname, 'submissions.json');

app.use(express.json());
app.use(express.static(__dirname));

if (!fs.existsSync(SUBMISSIONS_FILE)) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify([], null, 2));
}

app.post('/submit', (req, res) => {
  const submission = req.body;
  if (!submission || !submission.trace_id) {
    return res.status(400).json({ error: 'Invalid submission' });
  }

  const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf8');
  const data = JSON.parse(raw);
  data.push(submission);
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2));

  console.log(`[${new Date().toISOString()}] Saved trace ${submission.trace_id} (total: ${data.length})`);
  res.json({ ok: true, trace_id: submission.trace_id });
});

app.get('/submissions', (req, res) => {
  const data = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Logic Console backend → http://localhost:${PORT}`);
});
