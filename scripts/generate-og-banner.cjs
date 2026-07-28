const sharp = require('/Users/user/Documents/Project X/Sivan/sivan-admin-hub/node_modules/sharp');
const fs = require('fs');

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
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
    <linearGradient id="sivanLogoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00e5ff"/>
      <stop offset="100%" stop-color="#0066ff"/>
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

  <!-- Sivan Icon Logo -->
  <g transform="translate(120, 100)">
    <rect width="84" height="84" rx="22" fill="url(#sivanLogoGrad)"/>
    <path d="M 58 24 C 42 20, 26 28, 26 42 C 26 58, 58 52, 58 66 C 58 76, 42 80, 26 74" fill="none" stroke="#ffffff" stroke-width="9" stroke-linecap="round"/>
  </g>

  <!-- SIVAN Brand Label & Dashboard Title -->
  <text x="224" y="128" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="700" fill="#10b981" letter-spacing="3">SIVAN</text>
  <text x="224" y="176" font-family="Inter, -apple-system, sans-serif" font-size="48" font-weight="800" fill="#ffffff" letter-spacing="-1">Sivan Dashboard</text>

  <!-- Subtitle Text - EXACT 2 LINES FIT TO PERFECT FONT SIZE AS SPECIFIED BY USER -->
  <text font-family="Inter, -apple-system, sans-serif" font-size="25" font-weight="500" fill="#94a3b8" letter-spacing="-0.2">
    <tspan x="120" y="252">Payments, stablecoins, &amp; virtual accounts</tspan>
    <tspan x="120" y="292">with instant global transfers.</tspan>
  </text>

  <!-- Action Pill Buttons (2x2 Grid) -->
  <!-- Row 1 -->
  <g transform="translate(120, 360)">
    <rect width="215" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="107" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Buy stablecoins</text>
  </g>
  <g transform="translate(350, 360)">
    <rect width="175" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="87" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Sell crypto</text>
  </g>

  <!-- Row 2 -->
  <g transform="translate(120, 428)">
    <rect width="195" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="97" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Transfer &amp; pay</text>
  </g>
  <g transform="translate(330, 428)">
    <rect width="215" height="52" rx="26" fill="#0d1522" stroke="#10b981" stroke-width="1.5"/>
    <text x="107" y="32" font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="600" fill="#ffffff" text-anchor="middle">Virtual accounts</text>
  </g>

  <!-- Right Side Sleek Dashboard UI Graphic -->
  <g transform="translate(680, 210)" opacity="0.5">
    <rect width="400" height="310" rx="20" fill="#0d1522" stroke="#1e293b" stroke-width="1.5"/>
    <!-- Search Bar -->
    <rect x="25" y="25" width="350" height="36" rx="10" fill="#131c2e" stroke="#1e293b" stroke-width="1"/>
    <!-- List Items -->
    <rect x="25" y="80" width="350" height="42" rx="10" fill="#131c2e"/>
    <rect x="25" y="132" width="350" height="42" rx="10" fill="#131c2e"/>
    <rect x="25" y="184" width="350" height="42" rx="10" fill="#131c2e"/>
    <rect x="25" y="236" width="350" height="42" rx="10" fill="#131c2e"/>
    
    <!-- Accent indicators -->
    <rect x="40" y="93" width="16" height="16" rx="8" fill="#10b981"/>
    <rect x="40" y="145" width="16" height="16" rx="8" fill="#00e5ff"/>
    <rect x="40" y="197" width="16" height="16" rx="8" fill="#10b981"/>
    <rect x="40" y="249" width="16" height="16" rx="8" fill="#00e5ff"/>
    
    <rect x="70" y="96" width="120" height="10" rx="5" fill="#334155"/>
    <rect x="70" y="148" width="140" height="10" rx="5" fill="#334155"/>
    <rect x="70" y="200" width="100" height="10" rx="5" fill="#334155"/>
    <rect x="70" y="252" width="130" height="10" rx="5" fill="#334155"/>
  </g>
</svg>
`;

sharp(Buffer.from(svg))
  .png({ quality: 100 })
  .toFile('/Users/user/Documents/Project X/Sivan/sivan-payment/frontend/public/og-sivan-dashboard.png')
  .then(() => {
    console.log('Successfully generated pixel-perfect og-sivan-dashboard.png via CJS sharp!');
  })
  .catch(err => {
    console.error('Error generating image:', err);
  });
