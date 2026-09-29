const express = require('express');

const app = express();
const ORIGIN = process.env.FRONTEND_ORIGIN || '*'; // set to the frontend URL in production

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use('/api', require('./routes/api'));
// Optional: serve the built frontend from the same server (used by the Docker image)
if (process.env.FRONTEND_DIR) app.use(express.static(process.env.FRONTEND_DIR));

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`SAS backend API at http://localhost:${port}/api`));
}
