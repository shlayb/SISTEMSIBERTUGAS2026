import Redis from 'ioredis';

let redis;

export default async function handler(req, res) {
  if (!redis) {
    // Membuka koneksi menggunakan environment variable dari Redis Cloud
    redis = new Redis(process.env.REDIS_URL);
  }

  try {
    if (req.method === 'GET') {
      const data = await redis.get('thermoguard:settings');
      if (data) {
        return res.status(200).json(JSON.parse(data));
      } else {
        return res.status(404).json({ error: 'Pengaturan tidak ditemukan' });
      }
    } else if (req.method === 'POST') {
      const settings = req.body;
      await redis.set('thermoguard:settings', JSON.stringify(settings));
      return res.status(200).json({ success: true });
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    console.error('Redis Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
