const sharp = require('/Users/user/Documents/Project X/Sivan/sivan-admin-hub/node_modules/sharp');
const fs = require('fs');

const iconPath = '/Users/user/Documents/Project X/Sivan/sivan-payment/frontend/public/icon.png';
const iconBase64 = fs.readFileSync(iconPath).toString('base64');
const iconDataUri = `data:image/png;base64,${iconBase64}`;

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#07090d"/>
      <stop offset="50%" stop-color="#0d131d"/>
      <stop offset="100%" stop-color="#040609"/>
    </linearGradient>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b" stop-opacity="0.8"/>
      <stop offset="50%" stop-color="#10b981" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#0f172a" stop-opacity="0.8"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0a0e17" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#06090e" stop-opacity="0.95"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="20" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bgGrad)"/>
  
  <!-- Glowing ambient circles -->
  <circle cx="1020" cy="90" r="260" fill="#10b981" opacity="0.12" filter="url(#glow)" />
  <circle cx="120" cy="520" r="200" fill="#00e5ff" opacity="0.08" filter="url(#glow)" />

  <!-- Outer Glass Frame -->
  <rect x="50" y="40" width="1100" height="550" rx="32" fill="url(#cardGrad)" stroke="url(#borderGrad)" stroke-width="2"/>

  <!-- Inner Glass Card Container -->
  <rect x="80" y="70" width="1040" height="490" rx="24" fill="#090d14" fill-opacity="0.6" stroke="#1e293b" stroke-width="1.5"/>

  <!-- Top Right URL Badge -->
  <g transform="translate(850, 95)">
    <rect width="240" height="44" rx="22" fill="#0d1522" stroke="#10b981" stroke-width="1" stroke-opacity="0.5"/>
    <text x="120" y="27" font-family="Inter, -apple-system, sans-serif" font-size="16" font-weight="600" fill="#10b981" text-anchor="middle">app.sivantech.online</text>
  </g>

  <!-- OFFICIAL SIVAN LOGO ICON -->
  <image href="${iconDataUri}" x="120" y="98" width="86" height="86" />

  <!-- SIVAN Brand Label & Dashboard Title -->
  <text x="226" y="126" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="700" fill="#10b981" letter-spacing="3">SIVAN</text>
  <text x="226" y="174" font-family="Inter, -apple-system, sans-serif" font-size="48" font-weight="800" fill="#ffffff" letter-spacing="-1">Sivan Dashboard</text>

  <!-- Subtitle Text - EXACT 2 LINES -->
  <text font-family="Inter, -apple-system, sans-serif" font-size="24" font-weight="500" fill="#94a3b8" letter-spacing="-0.2">
    <tspan x="120" y="250">Payments, stablecoins, &amp; virtual accounts</tspan>
    <tspan x="120" y="288">with instant global transfers.</tspan>
  </text>

  <!-- Action Pill Buttons (2x2 Grid) -->
  <!-- Row 1 -->
  <g transform="translate(120, 355)">
    <rect width="215" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="107" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Buy stablecoins</text>
  </g>
  <g transform="translate(350, 355)">
    <rect width="175" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="87" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Sell crypto</text>
  </g>

  <!-- Row 2 -->
  <g transform="translate(120, 423)">
    <rect width="195" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="97" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Transfer &amp; pay</text>
  </g>
  <g transform="translate(330, 423)">
    <rect width="215" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="107" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Virtual accounts</text>
  </g>

  <!-- Right Side: Sleek Global Infrastructure Card -->
  <g transform="translate(630, 195)">
    <rect width="460" height="330" rx="20" fill="#0d1522" stroke="#1e293b" stroke-width="1.5"/>
    
    <!-- Card Header Badge -->
    <g transform="translate(24, 22)">
      <rect width="230" height="32" rx="8" fill="#131c2e" stroke="#10b981" stroke-width="1" stroke-opacity="0.4"/>
      <circle cx="16" cy="16" r="4" fill="#10b981"/>
      <text x="28" y="21" font-family="Inter, -apple-system, sans-serif" font-size="12" font-weight="700" fill="#10b981" letter-spacing="1.2">GLOBAL INFRASTRUCTURE</text>
    </g>

    <!-- Item 1: USD -->
    <g transform="translate(24, 72)">
      <rect width="412" height="52" rx="12" fill="#131c2e" stroke="#1e293b" stroke-width="1"/>
      <rect x="12" y="10" width="52" height="32" rx="6" fill="#1e293b"/>
      <text x="38" y="31" font-family="Inter, -apple-system, sans-serif" font-size="14" font-weight="800" fill="#60a5fa" text-anchor="middle">USD</text>
      <text x="78" y="31" font-family="Inter, -apple-system, sans-serif" font-size="15" font-weight="600" fill="#ffffff">Virtual Accounts (ACH / Wire)</text>
    </g>

    <!-- Item 2: GBP -->
    <g transform="translate(24, 134)">
      <rect width="412" height="52" rx="12" fill="#131c2e" stroke="#1e293b" stroke-width="1"/>
      <rect x="12" y="10" width="52" height="32" rx="6" fill="#1e293b"/>
      <text x="38" y="31" font-family="Inter, -apple-system, sans-serif" font-size="14" font-weight="800" fill="#a78bfa" text-anchor="middle">GBP</text>
      <text x="78" y="31" font-family="Inter, -apple-system, sans-serif" font-size="15" font-weight="600" fill="#ffffff">Faster Payments</text>
    </g>

    <!-- Item 3: NGN -->
    <g transform="translate(24, 196)">
      <rect width="412" height="52" rx="12" fill="#131c2e" stroke="#1e293b" stroke-width="1"/>
      <rect x="12" y="10" width="52" height="32" rx="6" fill="#1e293b"/>
      <text x="38" y="31" font-family="Inter, -apple-system, sans-serif" font-size="14" font-weight="800" fill="#34d399" text-anchor="middle">NGN</text>
      <text x="78" y="31" font-family="Inter, -apple-system, sans-serif" font-size="15" font-weight="600" fill="#ffffff">Direct Instant Payouts</text>
    </g>

    <!-- Item 4: USDC -->
    <g transform="translate(24, 258)">
      <rect width="412" height="52" rx="12" fill="#131c2e" stroke="#1e293b" stroke-width="1"/>
      <rect x="12" y="10" width="52" height="32" rx="6" fill="#1e293b"/>
      <text x="38" y="31" font-family="Inter, -apple-system, sans-serif" font-size="14" font-weight="800" fill="#38bdf8" text-anchor="middle">USDC</text>
      <text x="78" y="31" font-family="Inter, -apple-system, sans-serif" font-size="15" font-weight="600" fill="#ffffff">Instant Settlement</text>
    </g>
  </g>
</svg>
`;

sharp(Buffer.from(svg))
  .png({ quality: 100 })
  .toFile('/Users/user/Documents/Project X/Sivan/sivan-payment/frontend/public/og-sivan-dashboard.png')
  .then(() => {
    console.log('Successfully generated Global Infrastructure og-sivan-dashboard.png!');
  })
  .catch(err => {
    console.error('Error generating image:', err);
  });
