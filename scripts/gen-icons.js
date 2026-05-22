// Gera o ícone 192x192 a partir do 512x512
const sharp = require('sharp');
const path = require('path');

const src = path.join(__dirname, '..', 'icons', 'icon-512x512.png');
const dst = path.join(__dirname, '..', 'icons', 'icon-192x192.png');

sharp(src)
  .resize(192, 192, { fit: 'cover' })
  .png({ compressionLevel: 9 })
  .toFile(dst)
  .then(() => console.log('Generated:', dst))
  .catch((err) => { console.error(err); process.exit(1); });
